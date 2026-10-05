import { describe, expect, it } from 'vitest';
import { HealthService } from '../../../src/application/HealthService.js';
import { Lifecycle } from '../../../src/application/Lifecycle.js';
import type { HealthCheck } from '../../../src/domain/ports.js';

const up = (name: string): HealthCheck => ({ name, check: () => Promise.resolve() });
const down = (name: string): HealthCheck => ({
  name,
  check: () => Promise.reject(new Error('unreachable')),
});
const hanging = (name: string): HealthCheck => ({
  name,
  check: () => new Promise<void>(() => undefined),
});

describe('HealthService', () => {
  it('is ready when every check passes and the instance is not draining', async () => {
    const svc = new HealthService(new Lifecycle(), [up('redis'), up('postgres')], 50);
    await expect(svc.readiness()).resolves.toEqual({
      ready: true,
      draining: false,
      checks: { redis: 'up', postgres: 'up' },
    });
  });

  it('is not ready when any check fails, and reports which', async () => {
    const svc = new HealthService(new Lifecycle(), [up('redis'), down('postgres')], 50);
    const r = await svc.readiness();
    expect(r.ready).toBe(false);
    expect(r.checks).toEqual({ redis: 'up', postgres: 'down' });
  });

  it('treats a check that exceeds the timeout as down', async () => {
    const svc = new HealthService(new Lifecycle(), [hanging('redis')], 20);
    const r = await svc.readiness();
    expect(r).toMatchObject({ ready: false, checks: { redis: 'down' } });
  });

  it('is not ready while draining even if dependencies are fine', async () => {
    const lifecycle = new Lifecycle();
    const svc = new HealthService(lifecycle, [up('redis')], 50);
    lifecycle.startDraining();
    await expect(svc.readiness()).resolves.toMatchObject({ ready: false, draining: true });
  });
});
