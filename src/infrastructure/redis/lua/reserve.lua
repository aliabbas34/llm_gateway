--[[
  Atomic budget reservation (FR5). Runs entirely inside Redis, so concurrent requests for one
  attempt are serialised: no read-modify-write race can overspend the budget.

  KEYS[1] status   KEYS[2] budget   KEYS[3] reservations (hash)
  ARGV[1] initial budget (token_budget claim; used only if the attempt has no budget yet)
  ARGV[2] max_tokens_cap      ARGV[3] input tokens (estimate)
  ARGV[4] min useful tokens   ARGV[5] reservation TTL ms
  ARGV[6] reservation id      ARGV[7] attempt key TTL s
  ARGV[8] student id          ARGV[9] request id

  Returns {'reserved', reserved, effective, expiresAtMs}
        | {'attempt_closed'} | {'budget_exhausted', remaining} | {'duplicate'}
]]
local initial = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local input = tonumber(ARGV[3])
local min_useful = tonumber(ARGV[4])
local ttl_ms = tonumber(ARGV[5])
local rid = ARGV[6]
local attempt_ttl = tonumber(ARGV[7])

-- 1. Status check: a closed attempt never reserves again (FR7).
if redis.call('GET', KEYS[1]) == 'closed' then
  return { 'attempt_closed' }
end

if redis.call('HEXISTS', KEYS[3], rid) == 1 then
  return { 'duplicate' }
end

-- 2. Initialise the budget only if this attempt has none (SETNX semantics). Later tokens carrying
--    a different token_budget can't reset or top up an existing budget.
redis.call('SET', KEYS[2], initial, 'NX')
local remaining = tonumber(redis.call('GET', KEYS[2]))

-- 3. How much completion this request may produce.
local effective = math.min(cap, remaining - input)

-- 4. Not enough left to say anything useful: reject without touching the budget.
if effective <= min_useful then
  return { 'budget_exhausted', remaining }
end

-- 5. Reserve the worst case: all the input plus a full-length completion.
local reserved = input + effective
redis.call('DECRBY', KEYS[2], reserved)

-- 6. Record the reservation with an expiry from Redis' own clock (ADR-0003).
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local expires_at = now + ttl_ms
redis.call('HSET', KEYS[3], rid, cjson.encode({
  r = reserved, i = input, e = expires_at, c = now, s = ARGV[8], q = ARGV[9],
}))

-- Keep per-attempt state alive while the attempt is in use.
redis.call('EXPIRE', KEYS[2], attempt_ttl)
redis.call('EXPIRE', KEYS[3], attempt_ttl)

return { 'reserved', reserved, effective, expires_at }
