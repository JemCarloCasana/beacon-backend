import test from "node:test";
import assert from "node:assert/strict";
import { createShutdownHandler } from "../src/utils/gracefulShutdown.js";

function makeLogger() {
  const lines = [];
  return { log: (line) => lines.push(line), error: (line) => lines.push(line), lines };
}

function makeServer({ closeCompletes = true, forceCompletes = true } = {}) {
  const calls = { close: 0, closeIdleConnections: 0, closeAllConnections: 0 };
  let onClosed = null;
  return {
    calls,
    closeIdleConnections() {
      calls.closeIdleConnections += 1;
    },
    closeAllConnections() {
      calls.closeAllConnections += 1;
      if (forceCompletes && onClosed) onClosed();
    },
    close(callback) {
      calls.close += 1;
      onClosed = callback;
      if (closeCompletes) callback();
    },
  };
}

test("a clean drain closes the server, disconnects mongo and exits 0", async () => {
  const server = makeServer();
  const exits = [];
  let disconnected = false;
  const shutdown = createShutdownHandler({
    getServer: () => server,
    disconnect: async () => {
      disconnected = true;
    },
    exit: (code) => exits.push(code),
    timeoutMs: 500,
    drainMs: 20,
    logger: makeLogger(),
  });

  await shutdown("SIGTERM");

  assert.equal(server.calls.close, 1, "server.close is called once");
  assert.equal(server.calls.closeIdleConnections, 1, "idle connections are released");
  assert.equal(disconnected, true, "mongo is disconnected");
  assert.deepEqual(exits, [0], "process exits 0 after a clean drain");
});

test("a second shutdown signal does not exit twice", async () => {
  const server = makeServer();
  const exits = [];
  const shutdown = createShutdownHandler({
    getServer: () => server,
    disconnect: async () => {},
    exit: (code) => exits.push(code),
    timeoutMs: 500,
    drainMs: 20,
    logger: makeLogger(),
  });

  await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

  assert.deepEqual(exits, [0], "only one exit is issued");
  assert.equal(server.calls.close, 1, "the server is closed once");
});

test("an open stream is force closed after the drain window", async () => {
  const server = makeServer({ closeCompletes: false });
  const exits = [];
  const shutdown = createShutdownHandler({
    getServer: () => server,
    disconnect: async () => {},
    exit: (code) => exits.push(code),
    timeoutMs: 1000,
    drainMs: 20,
    logger: makeLogger(),
  });

  await shutdown("SIGTERM");

  assert.equal(server.calls.closeAllConnections, 1, "lingering connections are closed");
  assert.deepEqual(exits, [0], "the shutdown still completes cleanly");
});

test("a server that never closes is force exited with code 1", async () => {
  const server = makeServer({ closeCompletes: false, forceCompletes: false });
  const exits = [];
  const shutdown = createShutdownHandler({
    getServer: () => server,
    disconnect: async () => {},
    exit: (code) => exits.push(code),
    timeoutMs: 120,
    drainMs: 20,
    logger: makeLogger(),
  });

  await shutdown("SIGTERM");

  assert.deepEqual(exits, [1], "a stuck drain ends in a forced exit");
});

test("a disconnect that never settles is force exited with code 1", { timeout: 3000 }, async () => {
  const server = makeServer();
  const exits = [];
  const shutdown = createShutdownHandler({
    getServer: () => server,
    disconnect: () => new Promise(() => {}),
    exit: (code) => exits.push(code),
    timeoutMs: 120,
    drainMs: 20,
    logger: makeLogger(),
  });

  await shutdown("SIGTERM");

  assert.deepEqual(exits, [1], "a stuck disconnect ends in a forced exit");
});

test("a server handed over directly is drained too", async () => {
  const server = makeServer();
  const exits = [];
  const shutdown = createShutdownHandler({
    server,
    disconnect: async () => {},
    exit: (code) => exits.push(code),
    timeoutMs: 500,
    drainMs: 20,
    logger: makeLogger(),
  });

  await shutdown("SIGTERM");

  assert.equal(server.calls.close, 1, "the server is closed");
  assert.deepEqual(exits, [0], "the shutdown completes cleanly");
});
