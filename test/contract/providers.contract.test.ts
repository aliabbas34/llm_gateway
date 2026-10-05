import { afterAll, beforeAll } from 'vitest';
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from '../../scripts/lib/fakeProviderServer.js';
import { FakeProvider, type FakeScript } from '../../src/infrastructure/providers/FakeProvider.js';
import { GroqProvider } from '../../src/infrastructure/providers/GroqProvider.js';
import { MistralProvider } from '../../src/infrastructure/providers/MistralProvider.js';
import { OpenAiCompatibleProvider } from '../../src/infrastructure/providers/OpenAiCompatibleProvider.js';
import type { LlmProvider } from '../../src/domain/ports.js';
import { describeProviderContract, type ContractScenario } from './providerContract.js';

let server: FakeProviderServer;
beforeAll(async () => {
  server = await startFakeProviderServer();
});
afterAll(async () => {
  await server.close();
});

const DEAD_URL = 'http://127.0.0.1:1/v1';

/** HTTP adapters: the scenario is the model name; connection-refused uses a dead port. */
function httpHarness(make: (baseUrl: string) => LlmProvider) {
  return {
    subject: (scenario: ContractScenario) =>
      scenario === 'connection-refused'
        ? { provider: make(DEAD_URL), model: 'ok' }
        : { provider: make(server.url), model: scenario },
    upstreamCancelled: () => server.nextAbortedResponse(),
  };
}

describeProviderContract(
  'OpenAiCompatibleProvider (generic)',
  httpHarness((baseUrl) => new OpenAiCompatibleProvider({ name: 'generic', baseUrl, apiKey: 'k' })),
);
describeProviderContract(
  'GroqProvider',
  httpHarness((baseUrl) => new GroqProvider({ baseUrl, apiKey: 'k' })),
);
describeProviderContract(
  'MistralProvider',
  httpHarness((baseUrl) => new MistralProvider({ baseUrl, apiKey: 'k' })),
);

/** The in-process fake expresses the same scenarios as scripts. */
const words = ['w1', ' w2', ' w3', ' w4', ' w5'];
const FAKE_SCRIPTS: Record<ContractScenario, FakeScript> = {
  ok: { deltas: words, usage: { inputTokens: 3, outputTokens: 5 } },
  'no-usage': { deltas: words, usage: null },
  'status-429': { failBeforeFirstChunk: 'rate_limited', retryAfterSec: 2 },
  'status-503': { failBeforeFirstChunk: 'server_error' },
  'status-400': { failBeforeFirstChunk: 'client_error' },
  'connection-refused': { failBeforeFirstChunk: 'connection' },
  'midstream-error': { deltas: words, failAfterDeltas: { count: 2, kind: 'server_error' } },
  garbage: { deltas: words, failAfterDeltas: { count: 1, kind: 'protocol_error' } },
  'no-done': { deltas: words, failAfterDeltas: { count: 5, kind: 'protocol_error' } },
  'hang-body': { deltas: words, hangAfterDeltas: 1 },
};

describeProviderContract('FakeProvider (in-process)', {
  subject: (scenario) => ({
    provider: new FakeProvider('fake', FAKE_SCRIPTS[scenario]),
    model: scenario,
  }),
});
