const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_MS = 3_000;

/**
 * Builds the handler that drains the HTTP server on a shutdown signal.
 *
 * `getServer` is read at signal time so the handler can be created before the
 * server exists. `exit` and `logger` are injectable for tests.
 */
export function createShutdownHandler({
  getServer,
  disconnect,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  drainMs = DEFAULT_DRAIN_MS,
  logger = console,
  exit = (code) => process.exit(code),
} = {}) {
  let shuttingDown = false;

  return async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`[shutdown] ${signal} received; draining`);

    const server = typeof getServer === "function" ? getServer() : null;

    let forced = false;
    let resolveHardExit;
    const hardExit = new Promise((resolve) => {
      resolveHardExit = resolve;
    });
    const hardTimer = setTimeout(() => {
      forced = true;
      logger.error("[shutdown] drain timeout; forcing exit");
      exit(1);
      resolveHardExit();
    }, timeoutMs);

    if (server) {
      try {
        server.closeIdleConnections?.();
      } catch {}
      const closed = new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      // Long-lived streams (admin SSE) never close on their own, so cut them.
      const forceTimer = setTimeout(() => {
        try {
          server.closeAllConnections?.();
        } catch {}
      }, drainMs);

      await Promise.race([closed, hardExit]);
      clearTimeout(forceTimer);
    }

    clearTimeout(hardTimer);
    if (forced) return;

    try {
      await disconnect();
    } catch {}

    logger.log("[shutdown] complete");
    exit(0);
  };
}
