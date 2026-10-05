import type { Usage } from '../domain/types.js';

/**
 * Where a chat completion is written. Implemented by the HTTP layer's SSE writer; tests use an
 * in-memory recorder. Defined here (the consumer) so the service doesn't depend on HTTP (DIP).
 *
 * Commit point: `open()` is the moment the client receives its first byte (status 200 + headers).
 * Until then the service may still fail over or answer with an ordinary JSON error. After it,
 * failures can only be reported with `error()` inside the stream (FR6).
 */
export interface ChatSink {
  readonly opened: boolean;
  open(meta: { readonly model: string }): void;
  /** Resolve when the chunk is handed to the transport (honours backpressure). */
  delta(content: string): Promise<void>;
  finish(reason: string): Promise<void>;
  usage(usage: Usage): Promise<void>;
  /** In-stream error event (after open only), followed by `end()`. */
  error(code: string, message: string): Promise<void>;
  end(): Promise<void>;
}
