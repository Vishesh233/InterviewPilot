// Process-level robustness: crash handlers and graceful shutdown.
// `exit`, `closeDb` and `logger` are injectable so the behaviour is testable
// without ending the test process.

const SHUTDOWN_TIMEOUT_MS = 10_000;

const fatalErrorMeta = (error) => JSON.stringify({
  name: error?.name || null,
  code: error?.code ?? null,
  message: typeof error?.message === 'string' ? error.message : String(error),
  stack: typeof error?.stack === 'string' ? error.stack : null,
});

// Neither case is recoverable in general: after an uncaught exception or an
// unhandled rejection the process state is unknown, so the error is logged and
// the process exits non-zero for the platform to restart it. Unfinished jobs
// are requeued by startup recovery. No case is treated as recoverable.
const createCrashHandlers = ({ exit = (code) => process.exit(code), logger = console } = {}) => ({
  uncaughtException: (error) => {
    logger.error('Fatal uncaught exception; exiting.', fatalErrorMeta(error));
    exit(1);
  },
  unhandledRejection: (reason) => {
    logger.error('Fatal unhandled promise rejection; exiting.', fatalErrorMeta(reason));
    exit(1);
  },
});

const installCrashHandlers = (options) => {
  const handlers = createCrashHandlers(options);
  process.on('uncaughtException', handlers.uncaughtException);
  process.on('unhandledRejection', handlers.unhandledRejection);
  return handlers;
};

// Graceful shutdown: stop accepting connections, let in-flight requests end,
// close MongoDB, exit 0. Background jobs are not marked as failed: they keep
// their stored status (queued/running/retrying) and startup recovery resumes
// them from their checkpoints. Exits 1 if a step fails or takes too long.
const createShutdown = (server, {
  closeDb,
  exit = (code) => process.exit(code),
  logger = console,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
} = {}) => {
  let shuttingDown = false;
  return async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`${signal} received; shutting down.`);
    const forceExit = setTimeout(() => {
      logger.error(`Shutdown did not finish within ${timeoutMs} ms; exiting.`);
      exit(1);
    }, timeoutMs);
    forceExit.unref();
    try {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      });
      logger.log('HTTP server closed.');
      await closeDb();
      logger.log('MongoDB connection closed.');
      clearTimeout(forceExit);
      exit(0);
    } catch (error) {
      clearTimeout(forceExit);
      logger.error('Graceful shutdown failed.', JSON.stringify({ name: error?.name || null, code: error?.code ?? null }));
      exit(1);
    }
  };
};

const installShutdownHandlers = (server, options) => {
  const shutdown = createShutdown(server, options);
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return shutdown;
};

module.exports = {
  SHUTDOWN_TIMEOUT_MS,
  createCrashHandlers,
  installCrashHandlers,
  createShutdown,
  installShutdownHandlers,
};
