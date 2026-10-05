/**
 * Load test: NFR1 (500 concurrent streams) and NFR3 (≤ 50 ms p95 added before the first token).
 *
 *   docker compose up -d --wait && npm run build && npm run load-test
 *   npm run load-test -- --levels 100,250,500 --duration 15
 *
 * What is measured (see docs/LOAD_TEST.md for method and caveats):
 *
 *  A. Server-side ADDED latency (the NFR3 number). The gateway logs, per request,
 *     added_latency_ms = pipeline time + (time to first token − the provider's own time to first
 *     token). It is computed from the gateway's own clocks, so a slow or saturated provider (or a
 *     saturated load generator) is excluded. Exact percentiles come from the gateway's log file.
 *  B. Client-observed latency, gateway vs a baseline straight to the fake provider at the same
 *     concurrency (autocannon). The difference is an upper bound that also contains contention
 *     between processes sharing one machine.
 *  C. Stability at NFR1: 500 concurrent streams; non-2xx, errors and timeouts must be 0.
 *
 * Everything runs as separate processes: fake provider, BUILT gateway (dist/), autocannon.
 * Redis and Postgres come from docker compose. Writes load-test-results/<timestamp>.json.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { parseArgs } from 'node:util';
import autocannon from 'autocannon';
import { generateEd25519KeyPair, importPrivateKey, mintAttemptToken } from '../lib/tokens.js';

const { values } = parseArgs({
  options: {
    levels: { type: 'string', default: '100,250,500' },
    duration: { type: 'string', default: '15' },
    'stream-connections': { type: 'string', default: '500' },
    'stream-model': { type: 'string', default: 'ok?words=100&gap=100' },
    'redis-url': { type: 'string', default: 'redis://localhost:6380' },
    'database-url': {
      type: 'string',
      default: 'postgres://gateway:gateway@localhost:5433/gateway',
    },
  },
});
const LEVELS = values.levels.split(',').map(Number);
const DURATION_S = Number(values.duration);
const STREAM_CONNECTIONS = Number(values['stream-connections']);
const FIRST_TOKEN_MODEL = 'ok?words=1&ttft=100';
/** Default ≈ 10 s streams (100 tokens, 100 ms apart): realistic LLM pacing for NFR1. */
const STREAM_MODEL = values['stream-model'];
const OUT_DIR = 'load-test-results';

const children: ChildProcess[] = [];
process.on('exit', () => {
  for (const c of children) c.kill();
});

async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

async function waitForHttp(url: string, okStatuses: number[] = [200], timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetch(url).then(
      (r) => r.status,
      () => 0,
    );
    if (okStatuses.includes(status)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function start(args: string[], env: Record<string, string>, stdoutFile?: string): ChildProcess {
  const out = stdoutFile === undefined ? 'ignore' : openSync(stdoutFile, 'w');
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', out, 'inherit'],
  });
  if (typeof out === 'number') {
    child.once('exit', () => {
      closeSync(out);
    });
  }
  children.push(child);
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await exited;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0
    ? NaN
    : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? NaN);

interface ClientRun {
  readonly name: string;
  readonly connections: number;
  readonly requests: number;
  readonly rps: number;
  readonly non2xx: number;
  readonly errors: number;
  readonly latencyMs: { p50: number; p90: number; p97_5: number; p99: number; max: number };
}

async function load(
  name: string,
  url: string,
  connections: number,
  model: string | undefined,
  tokens: string[] | undefined,
): Promise<ClientRun> {
  let next = 0;
  const result = await autocannon({
    url,
    method: 'POST',
    connections,
    duration: DURATION_S,
    timeout: 30,
    headers: { 'content-type': 'application/json' },
    // The gateway ignores `model` (config decides); the fake provider reads it as its scenario.
    body: JSON.stringify({
      ...(model !== undefined && { model }),
      messages: [{ role: 'user', content: 'Summarise the repository structure in one line.' }],
    }),
    // One attempt (token) per connection: per-attempt limits and budgets stay independent.
    setupClient: (client) => {
      if (tokens === undefined) return;
      const token = tokens[next % tokens.length] ?? '';
      next += 1;
      client.setHeaders({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
    },
  });
  const l = result.latency;
  return {
    name,
    connections,
    requests: result.requests.total,
    rps: Math.round(result.requests.average),
    non2xx: result.non2xx,
    errors: result.errors + result.timeouts,
    latencyMs: { p50: l.p50, p90: l.p90, p97_5: l.p97_5, p99: l.p99, max: l.max },
  };
}

/** Exact percentiles of the gateway's own per-request measurements, from its JSON log. */
function serverSide(logFile: string) {
  const lines = readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((l) => l.includes('"chat completion finished"'))
    .map((l) => JSON.parse(l) as { added_latency_ms?: number | null; outcome?: string });
  const added = lines
    .map((l) => l.added_latency_ms)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  return {
    completions: lines.length,
    nonCompleted: lines.filter((l) => l.outcome !== 'completed').length,
    addedLatencyMs: {
      p50: percentile(added, 0.5),
      p95: percentile(added, 0.95),
      p99: percentile(added, 0.99),
      max: added.at(-1) ?? NaN,
    },
  };
}

function metric(text: string, name: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line === undefined ? NaN : Number(line.split(' ').at(-1));
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { privatePem, publicPem } = await generateEd25519KeyPair();
  const privateKey = await importPrivateKey(privatePem);
  const maxConnections = Math.max(...LEVELS, STREAM_CONNECTIONS);
  const tokens = await Promise.all(
    Array.from({ length: maxConnections }, (_, i) =>
      mintAttemptToken(privateKey, {
        studentId: `load-${i}`,
        attemptId: `load-${stamp}-${i}`,
        tokenBudget: 1_000_000_000,
        maxTokensCap: 256,
        ttlSec: 3_600,
      }),
    ),
  );

  const fakePort = await freePort();
  start(
    [
      '--import',
      'tsx',
      'scripts/fake-provider-server.ts',
      '--port',
      String(fakePort),
      '--host',
      '127.0.0.1',
    ],
    {},
  );
  const fakeBase = `http://127.0.0.1:${fakePort}`;
  await waitForHttp(`${fakeBase}/`, [404]);

  const startGateway = async (model: string, logFile: string) => {
    const port = await freePort();
    const metricsPort = await freePort();
    const child = start(
      ['dist/server.js'],
      {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info', // realistic: access log + completion line per request
        HOST: '127.0.0.1',
        PORT: String(port),
        METRICS_HOST: '127.0.0.1',
        METRICS_PORT: String(metricsPort),
        REDIS_URL: values['redis-url'],
        DATABASE_URL: values['database-url'],
        JWT_PUBLIC_KEY: publicPem,
        SERVICE_API_KEY: randomBytes(24).toString('hex'),
        FAKE_PROVIDER_BASE_URL: `${fakeBase}/v1`,
        PRIMARY_MODEL: `fake:${model}`,
        FALLBACK_MODELS: '',
        RATE_LIMIT_IP_PER_MINUTE: '1000000000',
        RATE_LIMIT_ATTEMPT_PER_MINUTE: '1000000000',
        PG_POOL_MAX: '20',
        // Generous, so the first-token scenario measures latency rather than turning Redis-VM
        // hiccups on a laptop into 503s.
        REDIS_COMMAND_TIMEOUT_MS: '2000',
      },
      logFile,
    );
    await waitForHttp(`http://127.0.0.1:${port}/readyz`);
    return { child, url: `http://127.0.0.1:${port}/v1/chat/completions`, metricsPort };
  };

  const levels = [];
  for (const c of LEVELS) {
    console.log(`\n[level ${c}] baseline → fake provider`);
    const baseline = await load(
      `baseline c=${c}`,
      `${fakeBase}/v1/chat/completions`,
      c,
      FIRST_TOKEN_MODEL,
      undefined,
    );
    const logFile = `${OUT_DIR}/${stamp}-gateway-c${c}.log`;
    const gw = await startGateway(FIRST_TOKEN_MODEL, logFile);
    console.log(`[level ${c}] gateway → fake provider`);
    const gateway = await load(`gateway c=${c}`, gw.url, c, undefined, tokens);
    const scrape = await (await fetch(`http://127.0.0.1:${gw.metricsPort}/metrics`)).text();
    await stop(gw.child);
    levels.push({
      connections: c,
      baseline,
      gateway,
      server: serverSide(logFile),
      eventLoopLagP99Ms: metric(scrape, 'gateway_nodejs_eventloop_lag_p99_seconds') * 1000,
      clientDiffMs: {
        p50: gateway.latencyMs.p50 - baseline.latencyMs.p50,
        p97_5: gateway.latencyMs.p97_5 - baseline.latencyMs.p97_5,
      },
    });
  }

  console.log(`\n[streams] ${STREAM_CONNECTIONS} concurrent streams through the gateway`);
  const streamLog = `${OUT_DIR}/${stamp}-gateway-streams.log`;
  const gwStreams = await startGateway(STREAM_MODEL, streamLog);
  const streams = await load(
    `streams c=${STREAM_CONNECTIONS}`,
    gwStreams.url,
    STREAM_CONNECTIONS,
    undefined,
    tokens,
  );
  await stop(gwStreams.child);
  const streamServer = serverSide(streamLog);

  const report = {
    at: new Date().toISOString(),
    machine: {
      platform: `${os.type()} ${os.release()}`,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      memGb: Math.round(os.totalmem() / 2 ** 30),
      node: process.version,
    },
    config: {
      levels: LEVELS,
      durationS: DURATION_S,
      firstTokenModel: FIRST_TOKEN_MODEL,
      streamModel: STREAM_MODEL,
    },
    levels,
    streams: { client: streams, server: streamServer },
  };
  writeFileSync(`${OUT_DIR}/${stamp}.json`, JSON.stringify(report, null, 2));

  console.log(
    `\n## Load test (${DURATION_S} s per run, ${report.machine.cpu ?? '?'}, ${report.machine.logicalCpus} logical CPUs)\n`,
  );
  console.log(
    '| conns | baseline p50 / p97.5 ms | gateway p50 / p97.5 ms | gateway req/s | non-2xx+errors | **added p50 / p95 / p99 ms (server)** | event-loop lag p99 ms |',
  );
  console.log('|---|---|---|---|---|---|---|');
  for (const l of levels) {
    const a = l.server.addedLatencyMs;
    console.log(
      `| ${l.connections} | ${l.baseline.latencyMs.p50} / ${l.baseline.latencyMs.p97_5} | ${l.gateway.latencyMs.p50} / ${l.gateway.latencyMs.p97_5} | ${l.gateway.rps} | ${l.gateway.non2xx + l.gateway.errors} | **${a.p50} / ${a.p95} / ${a.p99}** | ${l.eventLoopLagP99Ms.toFixed(1)} |`,
    );
  }
  const s = streamServer.addedLatencyMs;
  console.log(
    `\nStreams (${STREAM_CONNECTIONS} concurrent, model ${STREAM_MODEL}): ${streams.requests} requests, non-2xx ${streams.non2xx}, errors ${streams.errors}, completions ${streamServer.completions} (non-completed ${streamServer.nonCompleted}), added p50/p95 ${s.p50}/${s.p95} ms`,
  );
  console.log(`\nraw: ${OUT_DIR}/${stamp}.json (+ gateway logs)`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
