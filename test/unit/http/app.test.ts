import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RateLimitedError } from '../../../src/domain/errors.js';
import { buildTestApp, type TestApp } from '../../helpers/testApp.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

describe('health endpoints (FR9)', () => {
  it('GET /healthz returns 200 with no dependencies', async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 503 when a dependency is down', async () => {
    t = await buildTestApp({
      checks: [{ name: 'redis', check: () => Promise.reject(new Error('down')) }],
    });
    const res = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable', checks: { redis: 'down' } });
  });

  it('GET /readyz returns 503 while draining', async () => {
    t = await buildTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    t.lifecycle.startDraining();
    const res = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'draining' });
  });
});

describe('request id', () => {
  it('generates a server-side id, ignoring the client header, and logs it', async () => {
    t = await buildTestApp();
    const res = await t.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'client-chosen' },
    });
    expect(res.headers['x-request-id']).toBe('req-1');
    const access = t.logs.records.find((r) => r.msg === 'request completed');
    expect(access).toMatchObject({
      request_id: 'req-1',
      client_request_id: 'client-chosen',
      route: '/healthz',
      status: 200,
    });
  });
});

describe('error handling', () => {
  it('returns a generic 404 body with the request id', async () => {
    t = await buildTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'Not found.' },
      request_id: 'req-1',
    });
  });

  it('maps GatewayError to its status, code and Retry-After', async () => {
    t = await buildTestApp();
    t.app.get('/boom', () => {
      throw new RateLimitedError('ip 1.2.3.4 exceeded 60/min', 2.2);
    });
    const res = await t.app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(res.body).not.toContain('1.2.3.4');
  });

  it('maps unexpected errors to a generic 500 and logs the detail', async () => {
    t = await buildTestApp();
    t.app.get('/bug', () => {
      throw new TypeError('undefined is not a function (internal detail)');
    });
    const res = await t.app.inject({ method: 'GET', url: '/bug' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'internal_error' } });
    expect(res.body).not.toContain('internal detail');
    expect(t.logs.text).toContain('internal detail');
  });

  it('maps schema validation, malformed JSON and oversized bodies to 400', async () => {
    t = await buildTestApp();
    t.app.post('/echo', { schema: { body: z.object({ a: z.string() }) } }, (req) => req.body);

    const bad = await t.app.inject({ method: 'POST', url: '/echo', payload: { a: 1 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const malformed = await t.app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expect(malformed.statusCode).toBe(400);

    const huge = await t.app.inject({
      method: 'POST',
      url: '/echo',
      payload: { a: 'x'.repeat(256 * 1024 + 1) },
    });
    expect(huge.statusCode).toBe(400);
  });
});

describe('CORS allowlist (NFR7)', () => {
  const preflight = (origin: string) => ({
    method: 'OPTIONS' as const,
    url: '/healthz',
    headers: { origin, 'access-control-request-method': 'GET' },
  });

  it('reflects an allowed origin', async () => {
    t = await buildTestApp();
    const res = await t.app.inject(preflight('http://localhost:5173'));
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not allow an origin outside the allowlist', async () => {
    t = await buildTestApp();
    const res = await t.app.inject(preflight('https://evil.example'));
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
