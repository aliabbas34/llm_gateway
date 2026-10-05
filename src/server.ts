/**
 * Process entry point: read the environment, build the gateway, listen, handle signals.
 * The only module with process-level side effects. Wiring lives in gateway.ts.
 */
import { loadConfig } from './config/loadConfig.js';
import { createGateway } from './gateway.js';
import { createLogger } from './observability/logger.js';
import { startMetricsServer } from './observability/metricsServer.js';

/** Extra time on top of the drain deadline before a stuck shutdown is cut short. */
const SHUTDOWN_HARD_LIMIT_EXTRA_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config);
  const gateway = await createGateway(config, logger);
  const metricsServer = await startMetricsServer(
    gateway.metrics.registry,
    config.metrics.host,
    config.metrics.port,
  );

  let signalled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) return;
    signalled = true;
    // Safety net: if draining or a dependency hangs, exit anyway (non-zero: it wasn't clean).
    setTimeout(() => {
      logger.error('shutdown exceeded its hard limit; exiting');
      process.exit(1);
    }, config.shutdown.drainTimeoutMs + SHUTDOWN_HARD_LIMIT_EXTRA_MS).unref();

    gateway
      .shutdown(signal)
      .then(() => metricsServer.close())
      .then(
        () => {
          // Everything is closed; leftover handles (e.g. provider keep-alive sockets) must not
          // keep the process alive.
          process.exit(0);
        },
        (err: unknown) => {
          logger.error({ err }, 'shutdown failed');
          process.exit(1);
        },
      );
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  await gateway.app.listen({ host: config.http.host, port: config.http.port });
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. invalid config), so fall back to stderr.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
