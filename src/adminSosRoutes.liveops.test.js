import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes/adminSosRoutes.js";
import { pool } from "./db.js";
import { setUserNotificationMulticastSenderForTests } from "./services/userNotifications.js";
import { UserNotification } from "./models/UserNotification.js";
import { Counter } from "./models/Counter.js";

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

test("GET /admin/sos/live accepts cancelled status filter", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let capturedParams = null;
  pool.query = async (_sql, params) => {
    capturedParams = params;
    return {
      rowCount: 1,
      rows: [
        {
          thread_id: 55,
          sos_id: 5,
          latest_status: "resolved",
          terminal_status: "cancelled",
          resolved_source: "android",
          acknowledged_at: null,
          acknowledged_by_admin_id: null,
          assigned_unit: null,
          latest_event_at: "2026-03-11T10:00:00.000Z",
          requires_attention: false
        }
      ]
    };
  };

  const stack = getRoute("/admin/sos/live", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { query: { status: "cancelled", limit: "100" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(capturedParams[0], "cancelled");
  assert.equal(res.body[0].terminal_status, "cancelled");
  assert.equal(res.body[0].resolved_source, "android");
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
  const originalNextPublicId = Counter.nextPublicId;
  const originalCreate = UserNotification.create;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
    Counter.nextPublicId = originalNextPublicId;
    UserNotification.create = originalCreate;
  });

  Counter.nextPublicId = async () => 906;
  UserNotification.create = async (doc) => ({
    toObject: () => ({ public_id: 906, is_read: false, ...doc }),
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
  const originalNextPublicId = Counter.nextPublicId;
  const originalCreate = UserNotification.create;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
    Counter.nextPublicId = originalNextPublicId;
    UserNotification.create = originalCreate;
  });

  Counter.nextPublicId = async () => 907;
  UserNotification.create = async (doc) => ({
    toObject: () => ({ public_id: 907, is_read: false, ...doc }),
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

test("POST /admin/sos/:sosId/resolve stores SAFE terminal state and notifies owner and friends", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const originalNextPublicId = Counter.nextPublicId;
  const originalCreate = UserNotification.create;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
    Counter.nextPublicId = originalNextPublicId;
    UserNotification.create = originalCreate;
    setUserNotificationMulticastSenderForTests(null);
  });

  const createdDocs = [];
  Counter.nextPublicId = async () => 102;
  UserNotification.create = async (doc) => {
    createdDocs.push(doc);
    return {
      toObject: () => ({
        public_id: 102,
        recipient_user_id: 42,
        type: "sos_update",
        title: "SOS Update",
        message: "Your SOS has been marked safe.",
        metadata: { sos_id: 5, status: "safe", fallback_route: "/sos/5" },
        is_read: false,
        created_at: "2026-03-19T01:10:01.000Z",
      }),
    };
  };

  const clientQueries = [];
  const sentMessages = [];
  const client = {
    async query(sql, params) {
      const text = String(sql);
      clientQueries.push({ sql: text, params });

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
              acknowledged_at: "2026-03-19T01:00:00.000Z",
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
  pool.query = async (sql, params) => {
    const text = String(sql);
    if (/FROM sos_threads st/i.test(text) && /JOIN users u ON u.id = st.user_id/i.test(text)) {
      return {
        rowCount: 1,
        rows: [
          {
            thread_id: 55,
            sos_id: 5,
            user_id: 42,
            full_name: "Reporter One",
            latest_status: "resolved",
            terminal_status: "safe",
            acknowledged_at: "2026-03-19T01:00:00.000Z",
            acknowledged_by_admin_id: 11,
            assigned_unit: "Emergency Medical Unit",
            emergency_category: "medical",
            latest_latitude: 16.0431,
            latest_longitude: 120.3333,
            latest_address: "Dagupan City",
            requires_attention: false,
            latest_event_at: "2026-03-19T01:10:00.000Z"
          }
        ]
      };
    }
    if (/INSERT INTO user_notifications/i.test(text)) {
      throw new Error("user_notifications must be persisted to MongoDB, not PostgreSQL");
    }
    if (/FROM friendships/i.test(text)) {
      assert.equal(params[0], 42);
      return {
        rowCount: 2,
        rows: [{ friend_user_id: 7 }, { friend_user_id: 8 }]
      };
    }
    if (/FROM devices/i.test(text)) {
      if (Array.isArray(params?.[0])) {
        assert.deepEqual(params[0], [7, 8]);
        return {
          rowCount: 2,
          rows: [{ fcm_token: "friend-token-1" }, { fcm_token: "friend-token-2" }]
        };
      }
      return {
        rowCount: 1,
        rows: [{ fcm_token: "owner-token-1" }]
      };
    }
    throw new Error(`Unexpected query in test: ${text}`);
  };

  setUserNotificationMulticastSenderForTests(async (message) => {
    sentMessages.push(message);
    return {
      successCount: Array.isArray(message.tokens) ? message.tokens.length : 1,
      failureCount: 0,
      responses: (message.tokens || []).map(() => ({ success: true }))
    };
  });

  const stack = getRoute("/admin/sos/:sosId/resolve", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: { note: "SAFE: Friend confirmed okay" },
    admin: { adminId: 11 }
  };
  const res = createRes();

  await handler(req, res);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(res.statusCode, 200);
  assert.equal(
    clientQueries.some(
      (entry) =>
        /UPDATE sos_threads/i.test(entry.sql) &&
        entry.params[1] === "safe"
    ),
    true
  );
  assert.equal(
    clientQueries.some(
      (entry) =>
        /INSERT INTO sos_events/i.test(entry.sql) &&
        entry.params[7] === "safe" &&
        entry.params[6] === "SAFE: Friend confirmed okay"
    ),
    true
  );
  assert.equal(sentMessages.length, 2);
  const ownerPush = sentMessages.find((message) => message.data.terminal_outcome == null);
  const friendPush = sentMessages.find((message) => message.data.terminal_outcome === "safe");
  assert.ok(ownerPush);
  assert.equal(ownerPush.data.sos_id, "5");
  assert.ok(friendPush);
  assert.equal(friendPush.data.sender_user_id, "42");
  assert.equal(createdDocs.length, 1);
  assert.equal(createdDocs[0].recipient_user_id, 42);
  assert.equal(createdDocs[0].type, "sos_update");
});

test("POST /admin/sos/:sosId/resolve stores CANCELLED terminal state", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const originalNextPublicId = Counter.nextPublicId;
  const originalCreate = UserNotification.create;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
    Counter.nextPublicId = originalNextPublicId;
    UserNotification.create = originalCreate;
  });

  Counter.nextPublicId = async () => 904;
  UserNotification.create = async (doc) => ({
    toObject: () => ({ public_id: 904, is_read: false, ...doc }),
  });

  const clientQueries = [];
  const client = {
    async query(sql, params) {
      const text = String(sql);
      clientQueries.push({ sql: text, params });

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
        return { rowCount: 1, rows: [{ id: 902 }] };
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
        user_id: 42,
        full_name: "Reporter One",
        latest_status: "resolved",
        terminal_status: "cancelled",
        acknowledged_at: null,
        acknowledged_by_admin_id: null,
        assigned_unit: null,
        emergency_category: "medical",
        latest_latitude: 16.0431,
        latest_longitude: 120.3333,
        latest_address: "Dagupan City",
        requires_attention: false,
        latest_event_at: "2026-03-19T01:10:00.000Z"
      }
    ]
  });

  const stack = getRoute("/admin/sos/:sosId/resolve", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: { note: "CANCELLED: False trigger" },
    admin: { adminId: 11 }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(
    clientQueries.some(
      (entry) =>
        /UPDATE sos_threads/i.test(entry.sql) &&
        entry.params[1] === "cancelled"
    ),
    true
  );
  assert.equal(
    clientQueries.some(
      (entry) =>
        /INSERT INTO sos_events/i.test(entry.sql) &&
        entry.params[7] === "cancelled"
    ),
    true
  );
});

test("POST /admin/sos/:sosId/resolve keeps fallback resolved event without terminal status", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const originalNextPublicId = Counter.nextPublicId;
  const originalCreate = UserNotification.create;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
    Counter.nextPublicId = originalNextPublicId;
    UserNotification.create = originalCreate;
  });

  Counter.nextPublicId = async () => 905;
  UserNotification.create = async (doc) => ({
    toObject: () => ({ public_id: 905, is_read: false, ...doc }),
  });

  const clientQueries = [];
  const client = {
    async query(sql, params) {
      const text = String(sql);
      clientQueries.push({ sql: text, params });

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
        return { rowCount: 1, rows: [{ id: 903 }] };
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
        user_id: 42,
        full_name: "Reporter One",
        latest_status: "resolved",
        terminal_status: null,
        acknowledged_at: null,
        acknowledged_by_admin_id: null,
        assigned_unit: null,
        emergency_category: "medical",
        latest_latitude: 16.0431,
        latest_longitude: 120.3333,
        latest_address: "Dagupan City",
        requires_attention: false,
        latest_event_at: "2026-03-19T01:10:00.000Z"
      }
    ]
  });

  const stack = getRoute("/admin/sos/:sosId/resolve", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: { note: "Handled by responders" },
    admin: { adminId: 11 }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(
    clientQueries.some(
      (entry) =>
        /UPDATE sos_threads/i.test(entry.sql) &&
        entry.params[1] === null
    ),
    true
  );
  assert.equal(
    clientQueries.some(
      (entry) =>
        /INSERT INTO sos_events/i.test(entry.sql) &&
        entry.params[7] === "resolved" &&
        entry.params[6] === "Handled by responders"
    ),
    true
  );
});

test("POST /admin/sos/:sosId/resolve returns current state when already resolved", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  });

  const client = {
    async query(sql) {
      const text = String(sql);

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
              status: "resolved",
              emergency_category: "medical",
              latitude: 16.0431,
              longitude: 120.3333,
              address: "Dagupan City"
            }
          ]
        };
      }
      if (/^ROLLBACK$/i.test(text.trim())) {
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
        user_id: 42,
        latest_status: "resolved",
        terminal_status: "safe",
        acknowledged_at: null,
        acknowledged_by_admin_id: null,
        assigned_unit: null,
        emergency_category: "medical",
        requires_attention: false,
        latest_event_at: "2026-03-19T01:10:00.000Z"
      }
    ]
  });

  const stack = getRoute("/admin/sos/:sosId/resolve", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: { note: "SAFE: Already handled" },
    admin: { adminId: 11 }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.latest_status, "resolved");
  assert.equal(res.body.sos_id, 5);
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
        terminal_status: null,
        resolved_source: null,
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
            terminal_status: null,
            resolved_source: null,
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

test("GET /admin/sos/:sosId timeline includes actor_name for staff events", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql) => {
    const text = String(sql);
    if (/FROM sos_threads st/i.test(text) && /JOIN users u ON u.id = st.user_id/i.test(text)) {
      return {
        rowCount: 1,
        rows: [
          {
            thread_id: 55,
            sos_id: 5,
            latest_status: "active",
            terminal_status: null,
            resolved_source: null,
            acknowledged_at: "2026-03-07T10:00:00.000Z",
            acknowledged_by_admin_id: 11,
            assigned_unit: "Emergency Medical Unit",
            latest_event_at: "2026-03-07T10:05:00.000Z",
            requires_attention: false
          }
        ]
      };
    }
    if (
      /FROM sos_events se/i.test(text) &&
      /LEFT JOIN sos_threads st ON st.id = se.thread_id/i.test(text) &&
      /LEFT JOIN admins a ON a.id = se.actor_admin_id/i.test(text)
    ) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 902,
            thread_id: 55,
            sos_id: 5,
            user_id: 42,
            status: "active",
            latitude: 16.0431,
            longitude: 120.3333,
            address: "Dagupan City",
            message: "Acknowledged from live feed",
            created_at: "2026-03-07T10:05:00.000Z",
            actor_type: "admin",
            actor_name: "Officer Reyes",
            actor_admin_id: 11,
            event_type: "admin_acknowledged",
            emergency_category: "medical"
          }
        ]
      };
    }
    throw new Error(`Unexpected query in test: ${text}`);
  };

  const stack = getRoute("/admin/sos/:sosId", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { sosId: "5" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.events[0].actor_type, "admin");
  assert.equal(res.body.events[0].actor_name, "Officer Reyes");
});

test("GET /admin/sos/:sosId timeline returns null actor_name when no staff name exists", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql) => {
    const text = String(sql);
    if (/FROM sos_threads st/i.test(text) && /JOIN users u ON u.id = st.user_id/i.test(text)) {
      return {
        rowCount: 1,
        rows: [
          {
            thread_id: 55,
            sos_id: 5,
            latest_status: "active",
            terminal_status: null,
            resolved_source: null,
            acknowledged_at: null,
            acknowledged_by_admin_id: null,
            assigned_unit: null,
            latest_event_at: "2026-03-07T10:00:00.000Z",
            requires_attention: true
          }
        ]
      };
    }
    if (/FROM sos_events se/i.test(text) && /LEFT JOIN sos_threads st ON st.id = se.thread_id/i.test(text)) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 903,
            thread_id: 55,
            sos_id: 5,
            user_id: 42,
            status: "active",
            latitude: 16.0431,
            longitude: 120.3333,
            address: "Dagupan City",
            message: "Need help",
            created_at: "2026-03-07T10:00:00.000Z",
            actor_type: "user",
            actor_name: null,
            actor_admin_id: null,
            event_type: "report_created",
            emergency_category: "medical"
          }
        ]
      };
    }
    throw new Error(`Unexpected query in test: ${text}`);
  };

  const stack = getRoute("/admin/sos/:sosId", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { sosId: "5" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.events[0].actor_type, "user");
  assert.equal(res.body.events[0].actor_name, null);
});

test("GET /admin/sos/:sosId timeline exposes cancelled terminal status", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql) => {
    const text = String(sql);
    if (/FROM sos_threads st/i.test(text) && /JOIN users u ON u.id = st.user_id/i.test(text)) {
      return {
        rowCount: 1,
        rows: [
          {
            thread_id: 55,
            sos_id: 5,
            latest_status: "resolved",
            terminal_status: "cancelled",
            resolved_source: "android",
            acknowledged_at: null,
            acknowledged_by_admin_id: null,
            assigned_unit: null,
            latest_event_at: "2026-03-07T10:00:00.000Z",
            requires_attention: false
          }
        ]
      };
    }
    if (/FROM sos_events se/i.test(text) && /LEFT JOIN sos_threads st ON st.id = se.thread_id/i.test(text)) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 901,
            thread_id: 55,
            sos_id: 5,
            user_id: 42,
            status: "cancelled",
            latitude: 16.0431,
            longitude: 120.3333,
            address: "Dagupan City",
            message: null,
            created_at: "2026-03-07T10:00:00.000Z",
            actor_type: "user",
            actor_name: null,
            actor_admin_id: null,
            event_type: "status_update",
            emergency_category: "medical"
          }
        ]
      };
    }
    throw new Error(`Unexpected query in test: ${text}`);
  };

  const stack = getRoute("/admin/sos/:sosId", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { sosId: "5" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.events[0].status, "cancelled");
  assert.equal(res.body.events[0].actor_name, null);
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
