import { DependencyUnavailableError } from '../../domain/errors.js';

/**
 * Run a Redis operation; turn *any* failure (connection refused, timeout, offline, script error)
 * into a 503 DependencyUnavailableError. Callers never see raw Redis errors, and nothing proceeds
 * on a guess when Redis cannot answer (NFR5: fail closed).
 */
export async function failClosed<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new DependencyUnavailableError(`redis ${operation} failed`, { cause: err });
  }
}
