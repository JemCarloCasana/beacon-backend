import test from "node:test";
import assert from "node:assert/strict";

import admin from "../src/firebaseAdmin.js";
import { pool } from "../src/db.js";
import notificationRouter from "../src/routes/notificationRoutes.js";
import incidentRouter from "../src/routes/incidentRoutes.js";
import adminSosRouter from "../src/routes/adminSosRoutes.js";
import {
  buildUserLifecycleNotification,
  notifySosFriendsTerminalEvent,
  notifyUserLifecycleEvent,
  setUserNotificationMulticastSenderForTests,
} from "../src/services/userNotifications.js";
import { UserNotification } from "../src/models/UserNotification.js";
import { Counter } from "../src/models/Counter.js";

function getRoute(router, path, method) {
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
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("buildUserLifecycleNotification creates app-compatible SOS payload fields", () => {
  const payload = buildUserLifecycleNotification({
    recipient_user_id: 42,
    entity_type: "sos",
    entity_id: 15,
    status: "acknowledged",
    assigned_unit: "Fire Station Unit",
    sender_name: "Reporter One",
    latitude: 16.04,
    longitude: 120.33,
    address: "Dagupan City",
    category: "fire",
  });

  assert.equal(payload.type, "sos_update");
  assert.equal(payload.data.type, "sos_update");
  assert.equal(payload.data.sos_id, 15);
  assert.equal(payload.data.sender_user_id, 42);
  assert.equal(payload.data.sender_name, "Reporter One");
  assert.equal(payload.data.address, "Dagupan City");
  assert.equal(payload.data.category, "fire");
  assert.equal(payload.title, "SOS Update");
  assert.equal(payload.message, "Your SOS has been acknowledged by Fire Station Unit.");
});

test("notifyUserLifecycleEvent stores notification when device token is missing", async (t) => {
  const originalQuery = pool.query;
  const originalNextPublicId = Counter.nextPublicId;
  const originalCreate = UserNotification.create;
  const originalInfo = console.info;
  const infoLogs = [];
  t.after(() => {
    pool.query = originalQuery;
    Counter.nextPublicId = originalNextPublicId;
    UserNotification.create = originalCreate;
    setUserNotificationMulticastSenderForTests(null);
    console.info = originalInfo;
  });
  console.info = (...args) => {
    infoLogs.push(args);
  };

  let createdDoc = null;
  Counter.nextPublicId = async (key) => {
    assert.equal(key, "user_notifications");
    return 1;
  };
  UserNotification.create = async (doc) => {
    createdDoc = doc;
    return {
      toObject: () => ({
        public_id: 1,
        recipient_user_id: 9,
        type: "incident_update",
        title: "Incident Update",
        message: "Your incident report has been dispatched to Fire Station Unit.",
        metadata: { incident_id: 19, status: "dispatched", fallback_route: "/incidents/19" },
        is_read: false,
        created_at: "2026-03-19T03:00:00.000Z",
      }),
    };
  };
  pool.query = async (sql, params) => {
    const text = String(sql);
    if (/FROM devices/i.test(text)) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  const result = await notifyUserLifecycleEvent({
    recipient_user_id: 9,
    entity_type: "incident",
    entity_id: 19,
    status: "dispatched",
    assigned_department: "Fire Station Unit",
    trace: {
      requestId: "req-no-token",
      action: "admin_incident_update",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.push.reason, "no_device_tokens");
  assert.equal(result.notification.id, 1);
  assert.equal(createdDoc.recipient_user_id, 9);
  assert.equal(createdDoc.type, "incident_update");
  assert.equal(
    infoLogs.some(
      ([message, payload]) =>
        message === "[user-notifications] start" &&
        payload?.requestId === "req-no-token" &&
        payload?.recipientUserId === 9
    ),
    true
  );
  assert.equal(
    infoLogs.some(
      ([message, payload]) =>
        message === "[user-notifications] push_skipped" &&
        payload?.reason === "no_device_tokens" &&
        payload?.tokenCount === 0
    ),
    true
  );
});

test("notifyUserLifecycleEvent logs and continues when FCM send fails", async (t) => {
  const originalQuery = pool.query;
  const originalNextPublicId = Counter.nextPublicId;
  const originalCreate = UserNotification.create;
  t.after(() => {
    pool.query = originalQuery;
    Counter.nextPublicId = originalNextPublicId;
    UserNotification.create = originalCreate;
    setUserNotificationMulticastSenderForTests(null);
  });

  Counter.nextPublicId = async () => 2;
  UserNotification.create = async (doc) => ({
    toObject: () => ({
      public_id: 2,
      recipient_user_id: 5,
      type: "sos_update",
      title: "SOS Update",
      message: "Your SOS has been resolved.",
      metadata: { sos_id: 22, status: "resolved", fallback_route: "/sos/22" },
      is_read: false,
      created_at: "2026-03-19T03:00:00.000Z",
      ...doc,
      public_id: 2,
    }),
  });
  pool.query = async (sql) => {
    const text = String(sql);
    if (/FROM devices/i.test(text)) {
      return { rowCount: 1, rows: [{ fcm_token: "token-1" }] };
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  setUserNotificationMulticastSenderForTests(async () => {
    throw new Error("FCM down");
  });

  const result = await notifyUserLifecycleEvent({
    recipient_user_id: 5,
    entity_type: "sos",
    entity_id: 22,
    status: "resolved",
  });

  assert.equal(result.ok, true);
  assert.equal(result.push.attempted, true);
  assert.equal(result.push.error, "fcm_send_failed");
});

test("notifySosFriendsTerminalEvent sends SOS terminal updates to accepted friends", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
    setUserNotificationMulticastSenderForTests(null);
  });

  const poolQueries = [];
  const sentMessages = [];
  pool.query = async (sql, params) => {
    const text = String(sql);
    poolQueries.push({ sql: text, params });
    if (/FROM friendships/i.test(text)) {
      assert.equal(params[0], 42);
      return {
        rowCount: 2,
        rows: [{ friend_user_id: 7 }, { friend_user_id: 8 }],
      };
    }
    if (/FROM devices/i.test(text)) {
      assert.deepEqual(params[0], [7, 8]);
      return {
        rowCount: 2,
        rows: [{ fcm_token: "friend-token-1" }, { fcm_token: "friend-token-2" }],
      };
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  setUserNotificationMulticastSenderForTests(async (message) => {
    sentMessages.push(message);
    return {
      successCount: 2,
      failureCount: 0,
      responses: [{ success: true }, { success: true }],
    };
  });

  const result = await notifySosFriendsTerminalEvent({
    owner_user_id: 42,
    sos_id: 22,
    terminal_outcome: "safe",
    sender_name: "Reporter One",
    latitude: 16.04,
    longitude: 120.33,
    address: "Dagupan City",
    category: "medical",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.recipients, [7, 8]);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].data.type, "sos_update");
  assert.equal(sentMessages[0].data.sos_id, "22");
  assert.equal(sentMessages[0].data.status, "safe");
  assert.equal(sentMessages[0].data.terminal_outcome, "safe");
  assert.equal(sentMessages[0].data.fallback_route, "/sos/22");
  assert.equal(sentMessages[0].data.sender_user_id, "42");
  assert.equal(sentMessages[0].data.sender_name, "Reporter One");
  assert.equal(
    poolQueries.some((entry) => /FROM friendships/i.test(entry.sql)),
    true
  );
});

test("notifySosFriendsTerminalEvent removes invalid tokens and keeps partial success", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
    setUserNotificationMulticastSenderForTests(null);
  });

  const deleteCalls = [];
  pool.query = async (sql, params) => {
    const text = String(sql);
    if (/FROM friendships/i.test(text)) {
      return {
        rowCount: 2,
        rows: [{ friend_user_id: 7 }, { friend_user_id: 8 }],
      };
    }
    if (/DELETE FROM devices/i.test(text)) {
      deleteCalls.push(params[0]);
      return { rowCount: 1, rows: [] };
    }
    if (/FROM devices/i.test(text)) {
      return {
        rowCount: 2,
        rows: [{ fcm_token: "friend-token-1" }, { fcm_token: "friend-token-2" }],
      };
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  setUserNotificationMulticastSenderForTests(async () => ({
    successCount: 1,
    failureCount: 1,
    responses: [
      { success: true },
      {
        success: false,
        error: { code: "messaging/registration-token-not-registered" },
      },
    ],
  }));

  const result = await notifySosFriendsTerminalEvent({
    owner_user_id: 42,
    sos_id: 22,
    terminal_outcome: "cancelled",
    sender_name: "Reporter One",
  });

  assert.equal(result.ok, true);
  assert.equal(result.push.attempted, true);
  assert.equal(result.push.successCount, 1);
  assert.equal(result.push.failureCount, 1);
  assert.equal(result.push.removedTokensCount, 1);
  assert.deepEqual(deleteCalls, [["friend-token-2"]]);
});

test("GET /notifications returns current user notifications newest first", async (t) => {
  const originalQuery = pool.query;
  const originalFind = UserNotification.find;
  t.after(() => {
    pool.query = originalQuery;
    UserNotification.find = originalFind;
  });

  pool.query = async (sql, params) => {
    assert.equal(params[0], "firebase-uid-1");
    return { rowCount: 1, rows: [{ id: 44 }] };
  };

  let capturedFilter = null;
  UserNotification.find = (filter) => {
    capturedFilter = filter;
    return {
      sort: () => ({
        lean: async () => [
          {
            public_id: 10,
            recipient_user_id: 44,
            type: "incident_update",
            title: "Incident Update",
            message: "Your incident report has been resolved.",
            metadata: { incident_id: "88", status: "resolved", created_at: "2026-03-19T03:00:00.000Z" },
            is_read: false,
            created_at: "2026-03-19T03:00:00.000Z",
          },
          {
            public_id: 9,
            recipient_user_id: 44,
            type: "sos_update",
            title: "SOS Update",
            message: "Your SOS has been acknowledged.",
            metadata: { sos_id: "55" },
            is_read: true,
            created_at: "2026-03-19T02:00:00.000Z",
          },
        ],
      }),
    };
  };

  const stack = getRoute(notificationRouter, "/notifications", "get");
  const handler = stack[stack.length - 1].handle;
  const req = { auth: { uid: "firebase-uid-1" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capturedFilter, { recipient_user_id: 44 });
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].id, 10);
  assert.equal(res.body[0].metadata.incident_id, 88);
  assert.equal(res.body[1].metadata.sos_id, 55);
  assert.equal(res.body[1].metadata.fallback_route, "/sos/55");
});

test("PATCH /notifications/:id/read scopes updates to the authenticated user", async (t) => {
  const originalQuery = pool.query;
  const originalFindOneAndUpdate = UserNotification.findOneAndUpdate;
  t.after(() => {
    pool.query = originalQuery;
    UserNotification.findOneAndUpdate = originalFindOneAndUpdate;
  });

  pool.query = async () => ({ rowCount: 1, rows: [{ id: 44 }] });

  let capturedFilter = null;
  let capturedUpdate = null;
  UserNotification.findOneAndUpdate = (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return {
      lean: async () => ({
        public_id: 17,
        recipient_user_id: 44,
        type: "incident_update",
        title: "Incident Update",
        message: "Your incident report has been resolved.",
        metadata: { incident_id: 90 },
        is_read: true,
        created_at: "2026-03-19T03:00:00.000Z",
      }),
    };
  };

  const stack = getRoute(notificationRouter, "/notifications/:id/read", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = { auth: { uid: "firebase-uid-1" }, params: { id: "17" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capturedFilter, { public_id: 17, recipient_user_id: 44 });
  assert.deepEqual(capturedUpdate, { $set: { is_read: true } });
  assert.equal(res.body.notification.id, 17);
  assert.equal(res.body.notification.is_read, true);
  assert.equal(res.body.notification.recipient_user_id, 44);
});

test("PATCH /notifications/:id/read returns 404 for another recipient's notification", async (t) => {
  const originalQuery = pool.query;
  const originalFindOneAndUpdate = UserNotification.findOneAndUpdate;
  t.after(() => {
    pool.query = originalQuery;
    UserNotification.findOneAndUpdate = originalFindOneAndUpdate;
  });

  pool.query = async () => ({ rowCount: 1, rows: [{ id: 44 }] });

  let capturedFilter = null;
  UserNotification.findOneAndUpdate = (filter) => {
    capturedFilter = filter;
    return {
      lean: async () => null,
    };
  };

  const stack = getRoute(notificationRouter, "/notifications/:id/read", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = { auth: { uid: "firebase-uid-1" }, params: { id: "18" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(capturedFilter, { public_id: 18, recipient_user_id: 44 });
  assert.deepEqual(res.body, { message: "Notification not found" });
});

test("PATCH /admin/incidents/:id sends sender notification only on status milestone changes", async (t) => {
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
  Counter.nextPublicId = async () => 91;
  UserNotification.create = async (doc) => {
    createdDocs.push(doc);
    return {
      toObject: () => ({
        public_id: 91,
        recipient_user_id: 33,
        type: "incident_update",
        title: "Incident Update",
        message: "Your incident report has been dispatched to Fire Station Unit.",
        metadata: { incident_id: 7, status: "dispatched", assigned_department: "Fire Station Unit" },
        is_read: false,
        created_at: "2026-03-19T01:05:01.000Z",
      }),
    };
  };

  const clientQueries = [];
  const poolQueries = [];
  const sentMessages = [];
  const client = {
    async query(sql, params) {
      const text = String(sql);
      clientQueries.push({ sql: text, params });
      if (/^BEGIN$/i.test(text.trim())) {
        return { rowCount: null, rows: [] };
      }
      if (/FROM incident_reports/i.test(text) && /WHERE id = \$1/i.test(text)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 7,
              user_id: 33,
              status: "pending",
              assigned_department: null,
              dispatched_at: null,
              resolved_at: null,
            },
          ],
        };
      }
      if (/UPDATE incident_reports/i.test(text)) {
        return { rowCount: 1, rows: [{ id: 7 }] };
      }
      if (/^COMMIT$/i.test(text.trim())) {
        return { rowCount: null, rows: [] };
      }
      throw new Error(`Unexpected client SQL in test: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  pool.query = async (sql, params) => {
    const text = String(sql);
    poolQueries.push({ sql: text, params });
    if (/FROM incident_reports ir/i.test(text)) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 7,
            user_id: 33,
            incident_type: "fire",
            assigned_department: "Fire Station Unit",
            description: "Warehouse smoke",
            latitude: null,
            longitude: null,
            address: null,
            priority: "high",
            status: "dispatched",
            created_at: "2026-03-19T01:00:00.000Z",
            updated_at: "2026-03-19T01:05:00.000Z",
            dispatched_at: "2026-03-19T01:05:00.000Z",
            resolved_at: null,
            resolution_notes: null,
            images: [],
          },
        ],
      };
    }
    if (/INSERT INTO user_notifications/i.test(text)) {
      throw new Error("user_notifications must be persisted to MongoDB, not PostgreSQL");
    }
    if (/FROM devices/i.test(text)) {
      return { rowCount: 1, rows: [{ fcm_token: "token-7" }] };
    }
    throw new Error(`Unexpected pool SQL in test: ${text}`);
  };

  setUserNotificationMulticastSenderForTests(async (message) => {
    sentMessages.push(message);
    return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
  });

  const stack = getRoute(incidentRouter, "/admin/incidents/:id", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { id: "7" },
    body: { status: "dispatched", assigned_department: "Fire Station Unit" },
  };
  const res = createRes();

  await handler(req, res);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(res.statusCode, 200);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].data.incident_id, "7");
  assert.equal(createdDocs.length, 1);
  assert.equal(createdDocs[0].recipient_user_id, 33);
  assert.equal(createdDocs[0].type, "incident_update");
  assert.equal(
    clientQueries.some((entry) => /UPDATE incident_reports/i.test(entry.sql)),
    true
  );
});

test("PATCH /admin/incidents/:id logs sender notification skip for non-milestone edits", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const originalInfo = console.info;
  const infoLogs = [];
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
    console.info = originalInfo;
    setUserNotificationMulticastSenderForTests(null);
  });

  console.info = (...args) => {
    infoLogs.push(args);
  };

  const client = {
    async query(sql) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) {
        return { rowCount: null, rows: [] };
      }
      if (/FROM incident_reports/i.test(text) && /WHERE id = \$1/i.test(text)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 7,
              user_id: 33,
              status: "pending",
              assigned_department: null,
              dispatched_at: null,
              resolved_at: null,
            },
          ],
        };
      }
      if (/UPDATE incident_reports/i.test(text)) {
        return { rowCount: 1, rows: [{ id: 7 }] };
      }
      if (/^COMMIT$/i.test(text.trim())) {
        return { rowCount: null, rows: [] };
      }
      throw new Error(`Unexpected client SQL in test: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  pool.query = async (sql) => {
    const text = String(sql);
    if (/FROM incident_reports ir/i.test(text)) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 7,
            user_id: 33,
            incident_type: "fire",
            assigned_department: "Police Personnel",
            description: "Warehouse smoke",
            latitude: null,
            longitude: null,
            address: null,
            priority: "high",
            status: "pending",
            created_at: "2026-03-19T01:00:00.000Z",
            updated_at: "2026-03-19T01:05:00.000Z",
            dispatched_at: null,
            resolved_at: null,
            resolution_notes: null,
            images: [],
          },
        ],
      };
    }
    throw new Error(`Unexpected pool SQL in test: ${text}`);
  };

  const stack = getRoute(incidentRouter, "/admin/incidents/:id", "patch");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { id: "7" },
    body: { assigned_department: "Police Personnel" },
    get(name) {
      return name.toLowerCase() === "x-request-id" ? "req-skip-1" : undefined;
    },
    admin: { adminId: 14 },
  };
  const res = createRes();

  await handler(req, res);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(res.statusCode, 200);
  assert.equal(
    infoLogs.some(
      ([message, payload]) =>
        message === "[incident-routes] sender notification skipped" &&
        payload?.requestId === "req-skip-1" &&
        payload?.reason === "status_unchanged_or_missing"
    ),
    true
  );
});

test("POST /admin/sos/:sosId/acknowledge creates sender notification with assigned unit", async (t) => {
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
  Counter.nextPublicId = async () => 101;
  UserNotification.create = async (doc) => {
    createdDocs.push(doc);
    return {
      toObject: () => ({
        public_id: 101,
        recipient_user_id: 42,
        type: "sos_update",
        title: "SOS Update",
        message: "Your SOS has been acknowledged by Emergency Medical Unit.",
        metadata: { sos_id: 5, status: "acknowledged", assigned_unit: "Emergency Medical Unit" },
        is_read: false,
        created_at: "2026-03-19T01:00:01.000Z",
      }),
    };
  };

  const sentMessages = [];
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
              status: "active",
              acknowledged_at: null,
              emergency_category: "medical",
              latitude: 16.0431,
              longitude: 120.3333,
              address: "Dagupan City",
            },
          ],
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
      throw new Error(`Unexpected client SQL in test: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const poolQueryLog = [];
  pool.query = async (sql) => {
    const text = String(sql);
    poolQueryLog.push(text);
    if (/FROM sos_threads st/i.test(text) && /JOIN users u ON u.id = st.user_id/i.test(text)) {
      return {
        rowCount: 1,
        rows: [
          {
            thread_id: 55,
            sos_id: 5,
            user_id: 42,
            full_name: "Reporter One",
            latest_status: "active",
            acknowledged_at: "2026-03-19T01:00:00.000Z",
            acknowledged_by_admin_id: 11,
            assigned_unit: "Emergency Medical Unit",
            emergency_category: "medical",
            latest_latitude: 16.0431,
            latest_longitude: 120.3333,
            latest_address: "Dagupan City",
            requires_attention: false,
            latest_event_at: "2026-03-19T01:00:00.000Z",
          },
        ],
      };
    }
    if (/INSERT INTO user_notifications/i.test(text)) {
      throw new Error("user_notifications must be persisted to MongoDB, not PostgreSQL");
    }
    if (/FROM devices/i.test(text)) {
      return { rowCount: 1, rows: [{ fcm_token: "token-42" }] };
    }
    throw new Error(`Unexpected pool SQL in test: ${text}`);
  };

  setUserNotificationMulticastSenderForTests(async (message) => {
    sentMessages.push(message);
    return { successCount: 1, failureCount: 0, responses: [{ success: true }] };
  });

  const stack = getRoute(adminSosRouter, "/admin/sos/:sosId/acknowledge", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    params: { sosId: "5" },
    body: { assigned_unit: "Emergency Medical Unit" },
    admin: { adminId: 11 },
  };
  const res = createRes();

  await handler(req, res);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(res.statusCode, 200);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].data.sos_id, "5");
  assert.equal(sentMessages[0].data.sender_user_id, "42");
  assert.equal(createdDocs.length, 1);
  assert.equal(createdDocs[0].recipient_user_id, 42);
  assert.equal(createdDocs[0].type, "sos_update");
});
