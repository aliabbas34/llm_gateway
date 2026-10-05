import { afterEach, describe, expect, it } from 'vitest';
import { DependencyUnavailableError } from '../../../src/domain/errors.js';
import { secretsEqual } from '../../../src/http/plugins/serviceKey.js';
import { buildTestApp, type TestApp } from '../../helpers/testApp.js';
import { TEST_SERVICE_API_KEY } from '../../helpers/testConfig.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.app.close();
  t = undefined;
});

const close = (id: string, key?: string) => ({
  method: 'POST' as const,
  url: `/v1/attempts/${id}/close`,
  headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
});

describe('POST /v1/attempts/:id/close (FR7)', () => {
  it('closes the attempt and is idempotent', async () => {
    t = await buildTestApp();
    for (let i = 0; i < 2; i++) {
      const res = await t.app.inject(close('att-9', TEST_SERVICE_API_KEY));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ attempt_id: 'att-9', status: 'closed' });
    }
    expect([...t.statuses.closed]).toEqual(['att-9']);
  });

  it('rejects a missing or wrong service key with 401 before touching the store', async () => {
    t = await buildTestApp();
    expect((await t.app.inject(close('att-9'))).statusCode).toBe(401);
    expect((await t.app.inject(close('att-9', 'wrong'))).statusCode).toBe(401);
    expect(
      (await t.app.inject({ ...close('att-9'), headers: { authorization: TEST_SERVICE_API_KEY } }))
        .statusCode,
    ).toBe(401);
    expect(t.statuses.closed.size).toBe(0);
  });

  it('authenticates before validating: a bad id with a bad key is 401, with a good key 400', async () => {
    t = await buildTestApp();
    expect((await t.app.inject(close('bad%20id', 'wrong'))).statusCode).toBe(401);
    expect((await t.app.inject(close('bad%20id', TEST_SERVICE_API_KEY))).statusCode).toBe(400);
  });

  it('fails closed with 503 + Retry-After when Redis is unavailable', async () => {
    t = await buildTestApp();
    t.statuses.failWith = new DependencyUnavailableError('redis close attempt failed');
    const res = await t.app.inject(close('att-9', TEST_SERVICE_API_KEY));
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
  });

  it('never logs the service key', async () => {
    t = await buildTestApp();
    await t.app.inject(close('att-9', TEST_SERVICE_API_KEY));
    await t.app.inject(close('att-9', 'a-wrong-key-attempt-0123456789'));
    expect(t.logs.text).not.toContain(TEST_SERVICE_API_KEY);
    expect(t.logs.text).not.toContain('a-wrong-key-attempt');
  });
});

describe('secretsEqual', () => {
  it('compares by value, including different lengths', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abd')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
    expect(secretsEqual('', 'x')).toBe(false);
  });
});
