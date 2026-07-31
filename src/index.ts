import { EnvironmentConfigLoader } from './config';
import { ExpressHttpServer } from './server';
import { initializeLogger, getLogger } from './utils';

async function main(): Promise<void> {
  const configLoader = new EnvironmentConfigLoader();
  const config = configLoader.load();

  initializeLogger({ level: config.logLevel });
  const logger = getLogger('main');

  const server = new ExpressHttpServer({ config });

  let isShuttingDown = false;

  const shutdown = (signal: string): void => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    logger.info('Shutting down...', { signal });

    // server.stop() waits on stopAllAgents(), which waits on each Claude CLI
    // process. A wedged CLI made shutdown hang forever, so a restart left the
    // old process holding the port and the new one failed with EADDRINUSE.
    // PM2 SIGKILLs after kill_timeout, but a manual or dev run has no such
    // backstop. unref() so this timer never keeps a healthy exit waiting.
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit', { signal });
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    server
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  server.onShutdown(() => shutdown('API'));

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await server.start();
  logger.info('Server started', { port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  const logger = getLogger('main');
  const message = error instanceof Error ? error.message : String(error);
  logger.error('Failed to start server', { error: message });
  process.exit(1);
});
