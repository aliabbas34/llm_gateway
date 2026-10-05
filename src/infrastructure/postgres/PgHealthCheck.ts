import type pg from 'pg';
import type { HealthCheck } from '../../domain/ports.js';

export class PgHealthCheck implements HealthCheck {
  readonly name = 'postgres';

  constructor(private readonly pool: pg.Pool) {}

  async check(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
