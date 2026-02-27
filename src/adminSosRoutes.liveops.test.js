import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes/adminSosRoutes.js";
import { pool } from "./db.js";

function getRoute(path, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return layer.route.stack;
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test("GET /admin/sos/live middleware returns 401 when bearer token is missing", async () => {
  const stack = getRoute("/admin/sos/live", "get");
  const authMiddleware = stack[0].handle;
  const req = { headers: {} };
  const res = createRes();
  let nextCalled = false;

  await authMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: "Missing Bearer token" });
});

test("GET /admin/sos/live returns 400 on invalid status query", async () => {
  const stack = getRoute("/admin/sos/live", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { query: { status: "bad-status" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid status filter" });
});

test("GET /admin/sos/:sosId returns 400 on invalid sos id", async () => {
  const stack = getRoute("/admin/sos/:sosId", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { sosId: "0" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid sosId" });
});

test("POST /admin/sos/:sosId/acknowledge returns 400 when note is not a string", async () => {
  const stack = getRoute("/admin/sos/:sosId/acknowledge", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: { note: 123 }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "note must be a string" });
});

test("GET /admin/sos/live-map returns map rows", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        sos_id: 10,
        user_id: 8,
        latitude: 16.0431,
        longitude: 120.3333,
        address: "Dagupan City",
        message: "Need help",
        status: "active",
        created_at: "2026-02-27T10:00:00.000Z"
      }
    ]
  });

  const stack = getRoute("/admin/sos/live-map", "get");
  const handler = stack[stack.length - 1].handle;
  const req = {};
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(Array.isArray(res.body), true);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].sos_id, 10);
});
