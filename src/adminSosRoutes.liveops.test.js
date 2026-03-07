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

test("GET /admin/sos/live rejects legacy acknowledged status filter", async () => {
  const stack = getRoute("/admin/sos/live", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { query: { status: "acknowledged" } };
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

test("POST /admin/sos/:sosId/acknowledge returns 400 when assigned_unit is missing", async () => {
  const stack = getRoute("/admin/sos/:sosId/acknowledge", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: {}
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "assigned_unit is required" });
});

test("POST /admin/sos/:sosId/acknowledge returns 400 when assigned_unit is invalid", async () => {
  const stack = getRoute("/admin/sos/:sosId/acknowledge", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: { assigned_unit: "Invalid Unit" }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid assigned_unit" });
});

test("POST /admin/sos/:sosId/acknowledge returns 400 when note exceeds max length", async () => {
  const stack = getRoute("/admin/sos/:sosId/acknowledge", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: {
      assigned_unit: "Emergency Medical Unit",
      note: "a".repeat(1001)
    }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "note must be 1000 characters or less" });
});

test("POST /admin/sos/:sosId/acknowledge persists assigned_unit and returns alias fields", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  });

  const queries = [];
  const client = {
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params });

      if (/^BEGIN$/i.test(text.trim())) {
        return { rowCount: null, rows: [] };
      }
      if (/FROM sos_threads st/i.test(text) && /FOR UPDATE OF st/i.test(text)) {
        return {
          rowCount: 1,
          rows: [
            {
              thread_id: 55,
              sos_id: 5,
              user_id: 42,
              status: "active",
              acknowledged_at: null,
              emergency_category: "medical",
              latitude: 16.0431,
              longitude: 120.3333,
              address: "Dagupan City"
            }
          ]
        };
      }
      if (/UPDATE sos_threads/i.test(text)) {
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO sos_events/i.test(text)) {
        return { rowCount: 1, rows: [{ id: 900 }] };
      }
      if (/^COMMIT$/i.test(text.trim())) {
        return { rowCount: null, rows: [] };
      }

      throw new Error(`Unexpected query in test: ${text}`);
    },
    release() {}
  };

  pool.connect = async () => client;
  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        thread_id: 55,
        sos_id: 5,
        latest_status: "active",
        acknowledged_at: "2026-03-07T10:00:00.000Z",
        acknowledged_by_admin_id: 11,
        assigned_unit: "Emergency Medical Unit",
        emergency_category: "medical",
        requires_attention: false,
        latest_event_at: "2026-03-07T10:00:00.000Z"
      }
    ]
  });

  const stack = getRoute("/admin/sos/:sosId/acknowledge", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: {
      assigned_unit: "Emergency Medical Unit",
      note: "Need backup\u0007"
    },
    admin: { adminId: 11 }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.assigned_unit, "Emergency Medical Unit");
  assert.equal(res.body.assignedUnit, "Emergency Medical Unit");
  assert.equal(res.body.acknowledged_at, "2026-03-07T10:00:00.000Z");
  assert.equal(res.body.acknowledgedAt, "2026-03-07T10:00:00.000Z");
  assert.equal(
    queries.some(
      (entry) =>
        /UPDATE sos_threads/i.test(entry.sql) &&
        /assigned_unit = \$3/i.test(entry.sql) &&
        entry.params[2] === "Emergency Medical Unit"
    ),
    true
  );
  assert.equal(
    queries.some((entry) => /INSERT INTO sos_events/i.test(entry.sql) && entry.params[6] === "Need backup"),
    true
  );
});

test("POST /admin/sos/:sosId/acknowledge on already-acknowledged thread refreshes assignment and appends event", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  });

  const queries = [];
  const client = {
    async query(sql, params) {
      const text = String(sql);
      queries.push({ sql: text, params });

      if (/^BEGIN$/i.test(text.trim())) {
        return { rowCount: null, rows: [] };
      }
      if (/FROM sos_threads st/i.test(text) && /FOR UPDATE OF st/i.test(text)) {
        return {
          rowCount: 1,
          rows: [
            {
              thread_id: 55,
              sos_id: 5,
              user_id: 42,
              status: "active",
              acknowledged_at: "2026-03-07T09:00:00.000Z",
              emergency_category: "medical",
              latitude: 16.0431,
              longitude: 120.3333,
              address: "Dagupan City"
            }
          ]
        };
      }
      if (/UPDATE sos_threads/i.test(text)) {
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO sos_events/i.test(text)) {
        return { rowCount: 1, rows: [{ id: 901 }] };
      }
      if (/^COMMIT$/i.test(text.trim())) {
        return { rowCount: null, rows: [] };
      }

      throw new Error(`Unexpected query in test: ${text}`);
    },
    release() {}
  };

  pool.connect = async () => client;
  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        thread_id: 55,
        sos_id: 5,
        latest_status: "active",
        acknowledged_at: "2026-03-07T10:05:00.000Z",
        acknowledged_by_admin_id: 11,
        assigned_unit: "Police Personnel",
        emergency_category: "medical",
        requires_attention: false,
        latest_event_at: "2026-03-07T10:05:00.000Z"
      }
    ]
  });

  const stack = getRoute("/admin/sos/:sosId/acknowledge", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: {
      assigned_unit: "Police Personnel",
      note: "Reassigned"
    },
    admin: { adminId: 11 }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(
    queries.some((entry) => /UPDATE sos_threads/i.test(entry.sql)),
    true
  );
  assert.equal(
    queries.some((entry) => /INSERT INTO sos_events/i.test(entry.sql)),
    true
  );
});

test("GET /admin/sos/live includes snake_case and camelCase ack/unit aliases", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        thread_id: 55,
        sos_id: 5,
        latest_status: "active",
        acknowledged_at: "2026-03-07T10:00:00.000Z",
        acknowledged_by_admin_id: 11,
        assigned_unit: "Emergency Medical Unit",
        latest_event_at: "2026-03-07T10:00:00.000Z",
        requires_attention: false
      }
    ]
  });

  const stack = getRoute("/admin/sos/live", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { query: { status: "open" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body[0].assigned_unit, "Emergency Medical Unit");
  assert.equal(res.body[0].assignedUnit, "Emergency Medical Unit");
  assert.equal(res.body[0].acknowledged_at, "2026-03-07T10:00:00.000Z");
  assert.equal(res.body[0].acknowledgedAt, "2026-03-07T10:00:00.000Z");
});

test("GET /admin/sos/:sosId includes snake_case and camelCase ack/unit aliases in thread", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql) => {
    if (/FROM sos_threads st/i.test(String(sql))) {
      return {
        rowCount: 1,
        rows: [
          {
            thread_id: 55,
            sos_id: 5,
            latest_status: "active",
            acknowledged_at: "2026-03-07T10:00:00.000Z",
            acknowledged_by_admin_id: 11,
            assigned_unit: "Emergency Medical Unit",
            latest_event_at: "2026-03-07T10:00:00.000Z",
            requires_attention: false
          }
        ]
      };
    }
    if (/FROM sos_events/i.test(String(sql))) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`Unexpected query in test: ${sql}`);
  };

  const stack = getRoute("/admin/sos/:sosId", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { sosId: "5" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.thread.assigned_unit, "Emergency Medical Unit");
  assert.equal(res.body.thread.assignedUnit, "Emergency Medical Unit");
  assert.equal(res.body.thread.acknowledged_at, "2026-03-07T10:00:00.000Z");
  assert.equal(res.body.thread.acknowledgedAt, "2026-03-07T10:00:00.000Z");
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
