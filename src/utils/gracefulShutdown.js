const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_MS = 3_000;

/**
 * Builds the handler that drains the HTTP server on a shutdown signal.
 *
 * The server can be handed over directly or through `getServer`, which is read
 * at signal time so the handler can be created before the server exists.
 * `exit` and `logger` are injectable for tests.
 */
export function createShutdownHandler({
  server = null,
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

    const activeServer = typeof getServer === "function" ? getServer() : server;

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

    if (activeServer) {
      try {
        activeServer.closeIdleConnections?.();
      } catch {}
      const closed = new Promise((resolve) => {
        try {
          activeServer.close(() => resolve());
        } catch {
          resolve();
        }
      });
      // Long-lived streams (admin SSE) never close on their own, so cut them.
      const forceTimer = setTimeout(() => {
        try {
          activeServer.closeAllConnections?.();
        } catch {}
      }, drainMs);

      await Promise.race([closed, hardExit]);
      clearTimeout(forceTimer);
    }

    // The hard timeout stays armed across the disconnect: a stuck disconnect
    // must not leave the process hanging, which is the exact failure this
    // handler exists to prevent.
    if (!forced) {
      try {
        await Promise.race([
          typeof disconnect === "function" ? disconnect() : Promise.resolve(),
          hardExit
        ]);
      } catch {}
    }

    clearTimeout(hardTimer);
    if (forced) return;

    logger.log("[shutdown] complete");
    exit(0);
  };
}
