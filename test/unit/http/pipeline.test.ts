/**
 * The request pipeline order is a requirement, not an implementation detail:
 * requestId → IP rate limit → auth → validation → attempt rate limit → reserve → handler.
 * Each test proves one adjacency by making two steps fail at once and checking which one wins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from '../../../src/domain/errors.js';
import { CountingRateLimiter } from '../../helpers/fakes.js';
import { buildTestApp, type TestApp } from '../../helpers/testApp.js';
import { testToken } from '../../helpers/tokens.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const valid = { messages: [{ role: 'user', content: 'hi' }] };
const invalid = { messages: [] };

async function chat(app: TestApp['app'], body: unknown, token: string | undefined) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    payload: body as Record<string, unknown>,
  });
}

describe('pipeline order', () => {
  it('IP rate limit runs before auth: an IP over its limit gets 429 even without a token', async () => {
    t = await buildTestApp({ ipLimiter: new CountingRateLimiter(1, 2_100) });
    expect((await chat(t.app, valid, undefined)).statusCode).toBe(401);
    const res = await chat(t.app, valid, undefined);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3'); // ceil(2.1 s)
    expect(res.headers['x-request-id']).toBeDefined(); // requestId ran first
  });

  it('auth runs before validation: a bad token with a bad body is 401, not 400', async () => {
    t = await buildTestApp();
    expect((await chat(t.app, invalid, 'garbage')).statusCode).toBe(401);
  });

  it('validation runs before the attempt limit: invalid bodies do not spend attempt quota', async () => {
    t = await buildTestApp({ attemptLimiter: new CountingRateLimiter(1) });
    const token = await testToken({ attemptId: 'att-q' });
    expect((await chat(t.app, invalid, token)).statusCode).toBe(400);
    expect((await chat(t.app, invalid, token)).statusCode).toBe(400);
    expect(t.attemptLimiter.consumed).toEqual([]);
    expect((await chat(t.app, valid, token)).statusCode).toBe(200);
  });

  it('the attempt limit applies per attempt, after auth, with Retry-After', async () => {
    t = await buildTestApp({ attemptLimiter: new CountingRateLimiter(2, 30_000) });
    const a = await testToken({ attemptId: 'att-a' });
    const b = await testToken({ attemptId: 'att-b' });
    expect((await chat(t.app, valid, a)).statusCode).toBe(200);
    expect((await chat(t.app, valid, a)).statusCode).toBe(200);
    const limited = await chat(t.app, valid, a);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('30');
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect((await chat(t.app, valid, b)).statusCode).toBe(200); // other attempts unaffected
    expect(t.attemptLimiter.consumed).toEqual(['att-a', 'att-a', 'att-a', 'att-b']);
  });

  it('keys the IP limit by client IP', async () => {
    t = await buildTestApp();
    await chat(t.app, valid, await testToken());
    expect(t.ipLimiter.consumed).toEqual(['127.0.0.1']);
  });

  it('fails closed with 503 when the limiter backend is down (NFR5)', async () => {
    t = await buildTestApp();
    t.ipLimiter.failWith = new DependencyUnavailableError('redis rate limit failed');
    const res = await chat(t.app, valid, await testToken());
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
  });

  it('does not rate-limit health checks or the backend close endpoint', async () => {
    t = await buildTestApp({ ipLimiter: new CountingRateLimiter(0) });
    expect((await t.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect(t.ipLimiter.consumed).toEqual([]);
  });
});
