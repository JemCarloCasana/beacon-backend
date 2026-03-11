import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes/sosRoutes.js";
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
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

test("POST /sos returns 400 when category is missing", async () => {
  const stack = getRoute("/sos", "post");
  const handler = stack[stack.length - 1].handle;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { latitude: 16.04, longitude: 120.33 }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid category" });
});

test("PATCH /sos/:sosId/status returns 400 on invalid sos id", async () => {
  const stack = getRoute("/sos/:sosId/status", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    auth: { uid: "firebase-uid-1" },
    params: { sosId: "0" },
    body: { status: "safe" }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid sosId" });
});

test("PATCH /sos/:sosId/status returns 400 on invalid terminal status", async () => {
  const stack = getRoute("/sos/:sosId/status", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    auth: { uid: "firebase-uid-1" },
    params: { sosId: "7" },
    body: { status: "resolved" }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid status" });
});

test("PATCH /sos/:sosId/status returns 400 on invalid source", async () => {
  const stack = getRoute("/sos/:sosId/status", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    auth: { uid: "firebase-uid-1" },
    params: { sosId: "7" },
    body: { status: "safe", source: "ios" }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid source" });
});

test("PATCH /sos/:sosId/status returns 400 on invalid resolved_at", async () => {
  const stack = getRoute("/sos/:sosId/status", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    auth: { uid: "firebase-uid-1" },
    params: { sosId: "7" },
    body: { status: "cancelled", resolved_at: "not-a-date" }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid resolved_at" });
});

test("PATCH /sos/:sosId/status persists terminal outcome and returns contract payload", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  pool.query = async (sql) => {
    const text = String(sql);
    if (/SELECT id FROM users WHERE firebase_uid = \$1/i.test(text)) {
      return { rowCount: 1, rows: [{ id: 42 }] };
    }
    if (/FROM sos_threads st/i.test(text) && /JOIN users u ON u.id = st.user_id/i.test(text)) {
      return {
        rowCount: 1,
        rows: [
          {
            thread_id: 99,
            sos_id: 7,
            user_id: 42,
            full_name: "User",
            phone_number: null,
            role: "citizen",
            latest_status: "resolved",
            emergency_category: "medical",
            acknowledged_at: null,
            assigned_unit: null,
            acknowledged_by_admin_id: null,
            resolved_at: "2026-03-11T00:30:00.000Z",
            opened_at: "2026-03-11T00:00:00.000Z",
            latest_message: null,
            latest_latitude: 16.04,
            latest_longitude: 120.33,
            latest_address: "Dagupan",
            latest_event_at: "2026-03-11T00:30:00.000Z",
            admin_acknowledged_at: null,
            admin_acknowledged_by_admin_id: null,
            requires_attention: false
          }
        ]
      };
    }
    throw new Error(`Unexpected pool.query in test: ${text}`);
  };

  const client = {
    insertParams: null,
    async query(sql) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/FROM sos_threads st/i.test(text) && /FOR UPDATE OF st/i.test(text)) {
        return {
          rowCount: 1,
          rows: [
            {
              thread_id: 99,
              user_id: 42,
              latest_status: "active",
              resolved_at: null,
              emergency_category: "medical",
              latitude: 16.04,
              longitude: 120.33,
              address: "Dagupan"
            }
          ]
        };
      }
      if (/UPDATE sos_threads/i.test(text)) {
        return {
          rowCount: 1,
          rows: [
            {
              sos_id: 7,
              terminal_status: "safe",
              resolved_at: "2026-03-11T00:30:00.000Z"
            }
          ]
        };
      }
      if (/INSERT INTO sos_events/i.test(text)) {
        this.insertParams = arguments[1];
        return { rowCount: 1, rows: [] };
      }
      if (/^COMMIT$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query in test: ${text}`);
    },
    release() {}
  };
  pool.connect = async () => client;

  const stack = getRoute("/sos/:sosId/status", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    auth: { uid: "firebase-uid-1" },
    params: { sosId: "7" },
    body: { status: "safe", source: "android", resolved_at: "2026-03-11T00:30:00.000Z" }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    sos_id: "7",
    status: "safe",
    resolved_at: "2026-03-11T00:30:00.000Z"
  });
  assert.equal(client.insertParams[6], "safe");
});
