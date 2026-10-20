import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

// An unreachable database: the old probe dialled this on every request, which
// is what made it slow and noisy when Mongo was down.
process.env.MONGODB_URI = "mongodb://127.0.0.1:27099/nope";
process.env.MONGO_CONNECT_MAX_ATTEMPTS = "1";
process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS = "3000";

const { mongoose } = await import("../src/mongo.js");
const { app } = await import("../server.js");

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;

function get(path) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const request = http.get({ host: "127.0.0.1", port, path }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ status: response.statusCode, body, elapsed: Date.now() - startedAt });
      });
    });
    request.on("error", reject);
  });
}

test.after(async () => {
  server.close();
  await mongoose.disconnect();
});

test("the readiness probe answers immediately instead of dialling the database", async () => {
  const result = await get("/health/mongo");

  assert.equal(result.status, 503, "an unreachable database reports not ready");
  assert.deepEqual(JSON.parse(result.body), { ok: false });
  assert.ok(result.elapsed < 1000, `expected an immediate answer, took ${result.elapsed}ms`);
});

test("the readiness probe reports ready once the database is connected", async () => {
  Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
  try {
    const result = await get("/health/mongo");

    assert.equal(result.status, 200, "a connected database reports ready");
    assert.deepEqual(JSON.parse(result.body), { ok: true });
  } finally {
    delete mongoose.connection.readyState;
  }
});
