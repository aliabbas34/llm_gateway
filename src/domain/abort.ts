/**
 * Abort reasons the gateway itself uses, so that whoever observes an aborted signal can tell
 * *why*: the client left (plain abort), a timeout fired (ProviderError 'timeout'), or the
 * instance is shutting down (ShutdownAbort).
 */
export class ShutdownAbort extends Error {
  constructor() {
    super('instance is shutting down');
    this.name = 'ShutdownAbort';
  }
}
