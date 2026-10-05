/**
 * An OpenAI-compatible `/v1/chat/completions` server that misbehaves on request. Used by:
 * contract tests (real adapters over real HTTP), the real-socket disconnect test, e2e, the load
 * test, and local demos without provider keys.
 *
 * The scenario comes from the `model` field, so the gateway's PRIMARY_MODEL / FALLBACK_MODELS
 * config picks behaviour without any extra control channel:
 *
 *   ok                     normal stream ("w1 w2 …"), usage in the final chunk, [DONE]
 *   ok?words=50&ttft=100&gap=5&text=hello%20world
 *   no-usage               like ok, without any usage object
 *   x-groq-usage           usage only under x_groq.usage (legacy Groq shape)
 *   status-429             HTTP 429 with Retry-After: 2 (any status works: status-503, status-400)
 *   midstream-error        a few deltas, then an in-stream error object
 *   midstream-drop         a few deltas, then the TCP connection is destroyed
 *   no-done                normal deltas, then the stream ends without [DONE]
 *   garbage                a data line that is not JSON
 *   split                  normal stream, written one byte per TCP write (boundary torture)
 *   hang-headers           never sends response headers
 *   hang-body              sends headers and one delta, then stalls
 */
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequestRecord {
  readonly model: string;
  readonly body: Record<string, unknown>;
  readonly authorization: string | undefined;
}

export interface FakeProviderServer {
  readonly url: string;
  readonly requests: FakeRequestRecord[];
  /** Resolves when the server sees a client close a response it had not finished. */
  nextAbortedResponse(): Promise<{ model: string }>;
  close(): Promise<void>;
}

interface Scenario {
  name: string;
  params: URLSearchParams;
}

function parseScenario(model: string): Scenario {
  const q = model.indexOf('?');
  return q === -1
    ? { name: model, params: new URLSearchParams() }
    : { name: model.slice(0, q), params: new URLSearchParams(model.slice(q + 1)) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function num(params: URLSearchParams, key: string, fallback: number): number {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? v : fallback;
}

function chunk(model: string, delta: Record<string, unknown>, finish: string | null, extra = {}) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  };
}

export interface FakeProviderOptions {
  readonly port?: number;
  readonly host?: string;
  /** Default completion text for every scenario (overridden per request by `?text=`). */
  readonly text?: string;
}

export async function startFakeProviderServer(
  options: FakeProviderOptions = {},
): Promise<FakeProviderServer> {
  const { port = 0, host = '127.0.0.1' } = options;
  const requests: FakeRequestRecord[] = [];
  const abortWaiters: ((v: { model: string }) => void)[] = [];

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => res.destroy());
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const part of req) raw += String(part);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const model = typeof body.model === 'string' ? body.model : 'ok';
    requests.push({ model, body, authorization: req.headers.authorization });

    res.on('close', () => {
      if (!res.writableFinished) for (const w of abortWaiters.splice(0)) w({ model });
    });

    const { name, params } = parseScenario(model);
    const status = /^status-(\d{3})$/.exec(name);
    if (status) {
      res.writeHead(Number(status[1]), { 'content-type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify({ error: { message: 'scripted status', type: 'fake' } }));
      return;
    }
    if (name === 'hang-headers') return; // never respond

    const words = num(params, 'words', 5);
    const ttft = num(params, 'ttft', 0);
    const gap = num(params, 'gap', 0);
    const text = params.get('text') ?? options.text ?? null;
    const deltas =
      text !== null
        ? text.split(/(?<= )/)
        : Array.from({ length: words }, (_, i) => `${i === 0 ? '' : ' '}w${i + 1}`);
    const promptTokens = Math.ceil(raw.length / 4);

    if (ttft > 0) await sleep(ttft);
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    const write = async (payload: string) => {
      if (name === 'split') {
        // One byte per write, flushed immediately (no Nagle), so the client really receives
        // events, lines and UTF-8 sequences cut at arbitrary points.
        res.socket?.setNoDelay(true);
        for (const byte of Buffer.from(payload)) {
          if (res.destroyed) return;
          res.write(Buffer.from([byte]));
          await new Promise((r) => setImmediate(r));
        }
      } else if (!res.destroyed && !res.write(payload)) {
        await once(res, 'drain');
      }
    };
    const event = (obj: unknown) => write(`data: ${JSON.stringify(obj)}\n\n`);

    await event(chunk(model, { role: 'assistant', content: '' }, null));
    // A function, not a property read, so TS does not narrow it to `false` after the first check.
    const clientGone = () => res.destroyed;
    for (const [i, d] of deltas.entries()) {
      if (clientGone()) return;
      if (i > 0 && gap > 0) await sleep(gap);
      if (name === 'hang-body' && i === 1) return; // stall forever after one delta
      if (i === 2 && name === 'midstream-error') {
        await event({ error: { message: 'scripted mid-stream failure', type: 'server_error' } });
        res.end();
        return;
      }
      if (i === 2 && name === 'midstream-drop') {
        // Let the first deltas reach the client before cutting the connection; destroying at once
        // can discard unflushed writes, which would look like a failure *before* the first byte.
        await sleep(50);
        res.destroy();
        return;
      }
      if (i === 1 && name === 'garbage') {
        await write('data: {not json\n\n');
        res.end();
        return;
      }
      await event(chunk(model, { content: d }, null));
    }

    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: deltas.length,
      total_tokens: promptTokens + deltas.length,
    };
    if (name === 'no-usage') {
      await event(chunk(model, {}, 'stop'));
    } else if (name === 'x-groq-usage') {
      await event(chunk(model, {}, 'stop', { x_groq: { usage } }));
    } else {
      await event(chunk(model, {}, 'stop'));
      await event({ ...chunk(model, {}, null), choices: [], usage });
    }
    if (name !== 'no-done') await write('data: [DONE]\n\n');
    res.end();
  }

  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}/v1`,
    requests,
    nextAbortedResponse: () => new Promise((resolve) => abortWaiters.push(resolve)),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
