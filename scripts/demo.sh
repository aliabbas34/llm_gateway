#!/usr/bin/env bash
# End-to-end demo with the fake provider (no provider keys needed). Run from the repo root:
#
#   bash scripts/demo.sh
#
# Shows: a streamed chat → its ledger row and the Redis budget → failover (primary 503 → fallback)
# → budget exhaustion (403) → closing the attempt (403) → metrics. Cleans up its processes on exit.
set -euo pipefail

GATEWAY=http://127.0.0.1:8080
FAKE_PORT=8090
export DATABASE_URL=postgres://gateway:gateway@localhost:5433/gateway
export REDIS_URL=redis://localhost:6380
export SERVICE_API_KEY=demo-service-key-0123456789abcdef0123456789

step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

wait_ready() {
  for _ in $(seq 1 60); do curl -fsS "$GATEWAY/readyz" >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "gateway did not become ready" >&2; return 1
}

start_gateway() { # $1 = PRIMARY_MODEL, $2 = FALLBACK_MODELS
  [ -n "${GW_PID:-}" ] && { kill "$GW_PID" 2>/dev/null || true; wait "$GW_PID" 2>/dev/null || true; }
  JWT_PUBLIC_KEY="$(cat keys/public.pem)" FAKE_PROVIDER_BASE_URL="http://127.0.0.1:$FAKE_PORT/v1" \
    PRIMARY_MODEL="$1" FALLBACK_MODELS="$2" LOG_LEVEL=warn PORT=8080 HOST=127.0.0.1 \
    node dist/server.js &
  GW_PID=$!; pids+=("$GW_PID")
  wait_ready
}

chat() { # $1 = token
  curl -sN "$GATEWAY/v1/chat/completions" \
    -H "authorization: Bearer $1" -H 'content-type: application/json' \
    -d '{"messages":[{"role":"user","content":"Explain this codebase in one sentence."}]}'
}

step "1. Infrastructure: Redis + Postgres (docker compose), migrations, build"
docker compose up -d --wait
npm run -s migrate
npm run -s build
[ -f keys/private.pem ] || npm run -s gen-keys

step "2. Fake provider + gateway"
# node directly (not npx): on Windows, killing npx would leave its node child running.
node --import tsx scripts/fake-provider-server.ts --port "$FAKE_PORT" --host 127.0.0.1 &
pids+=($!)
start_gateway 'fake:ok?words=12&gap=60' ''

ATTEMPT="demo-$(date +%s)"
TOKEN=$(npm run -s mint-token -- --attempt "$ATTEMPT" --student stu-demo --budget 600 --cap 128)

step "3. A streamed chat (OpenAI-format SSE)"
chat "$TOKEN"

step "4. The ledger row and the remaining budget"
docker compose exec -T postgres psql -U gateway -d gateway -c \
  "SELECT outcome, provider, model, input_tokens, output_tokens, reserved_tokens, charged_tokens, ttft_ms, failover_count FROM usage_ledger WHERE attempt_id = '$ATTEMPT' ORDER BY created_at;"
echo "remaining budget in Redis: $(docker compose exec -T redis redis-cli GET "gw:{att:$ATTEMPT}:budget")"

step "5. Failover: the primary answers 503, the fallback serves (the client never notices)"
start_gateway 'fake:status-503' 'fake:ok?words=8&gap=40'
chat "$(npm run -s mint-token -- --attempt "$ATTEMPT-fo" --budget 5000)"

step "6. Spend the small allowance until the gateway stops the chat (403 budget_exhausted)"
for i in $(seq 1 10); do
  code=$(curl -s -o /tmp/demo-body -w '%{http_code}' "$GATEWAY/v1/chat/completions" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d '{"messages":[{"role":"user","content":"more please"}]}')
  echo "request $i → HTTP $code"
  if [ "$code" = 403 ]; then cat /tmp/demo-body; echo; break; fi
done

step "7. The backend closes the attempt → new requests get 403 attempt_closed"
OTHER="demo-close-$(date +%s)"
OTHER_TOKEN=$(npm run -s mint-token -- --attempt "$OTHER" --budget 5000)
npm run -s close-attempt -- --attempt "$OTHER" --url "$GATEWAY"
curl -s "$GATEWAY/v1/chat/completions" -H "authorization: Bearer $OTHER_TOKEN" \
  -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}'
echo

step "8. A few metrics (separate port, not public)"
curl -s http://127.0.0.1:9464/metrics | grep -E '^gateway_(chat_requests_total|failovers_total|tokens_charged_total|added_latency_seconds_count)'

step "Done"
