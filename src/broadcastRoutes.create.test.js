import test from "node:test";
import assert from "node:assert/strict";

import broadcastRouter from "./routes/broadcastRoutes.js";
import adminBroadcastRouter from "./routes/adminBroadcastRoutes.js";
import { pool } from "./db.js";
import { mongoose } from "./mongo.js";
import { Broadcast } from "./models/Broadcast.js";
import { BroadcastDelivery } from "./models/BroadcastDelivery.js";
import { Counter } from "./models/Counter.js";

function stubBroadcastSendModels(t, { markerDoc, existingDoc = null, audienceUserIds = [1, 2] } = {}) {
  const originalStartSession = mongoose.startSession;
  const originalFindOneAndUpdate = Broadcast.findOneAndUpdate;
  const originalFindOne = Broadcast.findOne;
  const originalInsertMany = BroadcastDelivery.insertMany;
  const originalDeliveryFind = BroadcastDelivery.find;
  const originalQuery = pool.query;
  t.after(() => {
    mongoose.startSession = originalStartSession;
    Broadcast.findOneAndUpdate = originalFindOneAndUpdate;
    Broadcast.findOne = originalFindOne;
    BroadcastDelivery.insertMany = originalInsertMany;
    BroadcastDelivery.find = originalDeliveryFind;
    pool.query = originalQuery;
  });

  const sessionCalls = { commit: 0, abort: 0 };
  const fakeSession = {
    async withTransaction(callback) {
      try { const result = await callback(); await this.commitTransaction(); return result; }
      catch (err) { await this.abortTransaction(); throw err; }
    },
    startTransaction() {},
    async commitTransaction() {
      sessionCalls.commit += 1;
    },
    async abortTransaction() {
      sessionCalls.abort += 1;
    },
    async endSession() {},
  };
  mongoose.startSession = async () => fakeSession;

  let capturedMarkerFilter = null;
  Broadcast.findOneAndUpdate = (filter) => {
    capturedMarkerFilter = filter;
    return {
      lean: async () => markerDoc,
    };
  };
  Broadcast.findOne = () => ({
    lean: async () => existingDoc,
  });

  const captured = { deliveryDocs: [], deliveryOpts: null };
  BroadcastDelivery.insertMany = async (docs, opts) => {
    captured.deliveryDocs.push(...docs);
    captured.deliveryOpts = opts;
    return docs;
  };
  BroadcastDelivery.find = () => ({
    lean: async () => audienceUserIds.map((recipient_user_id) => ({ recipient_user_id })),
  });

  pool.query = async (sql) => {
    const text = String(sql);
    if (/SELECT id FROM users/i.test(text)) {
      return { rowCount: audienceUserIds.length, rows: audienceUserIds.map((id) => ({ id })) };
    }
    if (/FROM devices/i.test(text)) {
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  return { sessionCalls, captured, capturedMarkerFilter: () => capturedMarkerFilter };
}

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
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("POST /admin/broadcasts accepts audience_roles and normalizes deduped values", async (t) => {
  const originalNextPublicId = Counter.nextPublicId;
  const originalCreate = Broadcast.create;
  t.after(() => {
    Counter.nextPublicId = originalNextPublicId;
    Broadcast.create = originalCreate;
  });

  let capturedDoc = null;
  Counter.nextPublicId = async (key) => {
    assert.equal(key, "broadcasts");
    return 1;
  };
  Broadcast.create = async (doc) => {
    capturedDoc = doc;
    return {
      toObject: () => ({
        public_id: 1,
        title: "Campus Alert",
        body: "Classes suspended",
        severity: "danger",
        audience_type: "role",
        audience_roles: ["citizen", "student"],
        audience_role_ids: undefined,
        created_by_admin_id: 9,
        is_active: true,
        sent_at: null,
        created_at: "2026-03-11T00:00:00.000Z",
        updated_at: "2026-03-11T00:00:00.000Z",
      }),
    };
  };

  const stack = getRoute(broadcastRouter, "/admin/broadcasts", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    admin: { adminId: 9 },
    body: {
      title: "Campus Alert",
      body: "Classes suspended",
      severity: "Danger",
      audience_type: "role",
      audience_roles: [" Citizen ", "student", "CITIZEN"],
      audience_role_ids: [100, 101],
    },
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(capturedDoc.public_id, 1);
  assert.equal(capturedDoc.title, "Campus Alert");
  assert.equal(capturedDoc.severity, "danger");
  assert.equal(capturedDoc.audience_type, "role");
  assert.deepEqual(capturedDoc.audience_roles, ["citizen", "student"]);
  assert.equal(capturedDoc.audience_role_ids, undefined);
  assert.equal(capturedDoc.created_by_admin_id, 9);
  assert.deepEqual(res.body.audience_roles, ["citizen", "student"]);
  assert.equal(res.body.id, 1);
});

test("POST /admin/broadcasts accepts deprecated audience_role_ids fallback", async (t) => {
  const originalNextPublicId = Counter.nextPublicId;
  const originalCreate = Broadcast.create;
  t.after(() => {
    Counter.nextPublicId = originalNextPublicId;
    Broadcast.create = originalCreate;
  });

  let capturedDoc = null;
  Counter.nextPublicId = async () => 2;
  Broadcast.create = async (doc) => {
    capturedDoc = doc;
    return {
      toObject: () => ({
        public_id: 2,
        title: "Legacy Alert",
        body: "Legacy payload",
        severity: "warning",
        audience_type: "role",
        audience_roles: undefined,
        audience_role_ids: [1, 2],
        created_by_admin_id: 11,
        is_active: true,
        sent_at: null,
        created_at: "2026-03-11T00:00:00.000Z",
        updated_at: "2026-03-11T00:00:00.000Z",
      }),
    };
  };

  const stack = getRoute(broadcastRouter, "/admin/broadcasts", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    admin: { adminId: 11 },
    body: {
      title: "Legacy Alert",
      body: "Legacy payload",
      severity: "Warning",
      audience_type: "role",
      audience_role_ids: [1, 1, 2],
    },
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(capturedDoc.audience_type, "role");
  assert.equal(capturedDoc.audience_roles, undefined);
  assert.deepEqual(capturedDoc.audience_role_ids, [1, 2]);
  assert.deepEqual(res.body.audience_role_ids, [1, 2]);
  assert.equal(res.body.id, 2);
});

test("POST /admin/broadcasts rejects role audience when no selector is provided", async () => {
  const stack = getRoute(broadcastRouter, "/admin/broadcasts", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    admin: { adminId: 5 },
    body: {
      title: "Missing selector",
      body: "Body",
      severity: "Announcement",
      audience_type: "role",
    },
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body?.message ?? "", /audience_roles is required/i);
});

test("POST /admin/broadcasts rejects legacy severity values", async () => {
  const stack = getRoute(broadcastRouter, "/admin/broadcasts", "post");
  const handler = stack[stack.length - 1].handle;
  const req = {
    admin: { adminId: 5 },
    body: {
      title: "Old severity",
      body: "Body",
      severity: "high",
      audience_type: "all",
    },
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid severity" });
});

test("POST /admin/broadcasts/:id/send uses audience_roles first with legacy fallback parameter still available", async (t) => {
  const markerDoc = {
    _id: "oid-broadcast-7",
    public_id: 7,
    title: "Title",
    body: "Body",
    severity: "danger",
    audience_type: "role",
    audience_roles: ["citizen"],
    audience_role_ids: [3],
    sent_at: "2026-03-11T00:00:00.000Z",
  };
  const { sessionCalls, captured, capturedMarkerFilter } = stubBroadcastSendModels(t, {
    markerDoc,
    audienceUserIds: [1, 2],
  });

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id/send", "post");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { id: "7" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capturedMarkerFilter(), { public_id: 7, sent_at: null });
  assert.equal(res.body?.delivered_count, 2);
  assert.equal(res.body?.broadcast_id, 7);
  assert.deepEqual(
    captured.deliveryDocs.map((doc) => doc.recipient_user_id),
    [1, 2]
  );
  assert.equal(captured.deliveryOpts.ordered, false);
  assert.equal(sessionCalls.commit, 1);
  assert.equal(sessionCalls.abort, 0);
  assert.deepEqual(res.body?.push, { successCount: 0, failureCount: 0, removedTokensCount: 0 });
});

test("POST /admin/broadcasts/:id/send returns 404 when broadcast does not exist", async (t) => {
  stubBroadcastSendModels(t, { markerDoc: null, existingDoc: null });

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id/send", "post");
  const handler = stack[stack.length - 1].handle;
  const res = createRes();

  await handler({ params: { id: "777" } }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Broadcast not found" });
});

test("POST /admin/broadcasts/:id/send returns 409 when broadcast was already sent", async (t) => {
  stubBroadcastSendModels(t, {
    markerDoc: null,
    existingDoc: { public_id: 7, sent_at: "2026-03-11T00:00:00.000Z" },
  });

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id/send", "post");
  const handler = stack[stack.length - 1].handle;
  const res = createRes();

  await handler({ params: { id: "7" } }, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { message: "Broadcast already sent" });
});

test("POST /admin/broadcasts/:id/send commits one send when two sends race", async (t) => {
  const originalStartSession = mongoose.startSession;
  const originalFindOneAndUpdate = Broadcast.findOneAndUpdate;
  const originalFindOne = Broadcast.findOne;
  const originalInsertMany = BroadcastDelivery.insertMany;
  const originalDeliveryFind = BroadcastDelivery.find;
  const originalQuery = pool.query;
  t.after(() => {
    mongoose.startSession = originalStartSession;
    Broadcast.findOneAndUpdate = originalFindOneAndUpdate;
    Broadcast.findOne = originalFindOne;
    BroadcastDelivery.insertMany = originalInsertMany;
    BroadcastDelivery.find = originalDeliveryFind;
    pool.query = originalQuery;
  });

  const fakeSession = {
    async withTransaction(callback) { return callback(); },
    startTransaction() {},
    async commitTransaction() {},
    async abortTransaction() {},
    async endSession() {},
  };
  mongoose.startSession = async () => fakeSession;

  const sentDoc = {
    _id: "oid-broadcast-7",
    public_id: 7,
    title: "Title",
    body: "Body",
    severity: "danger",
    audience_type: "all",
    sent_at: "2026-03-11T00:00:00.000Z",
  };
  let markerCalls = 0;
  let deliveryBatches = 0;
  Broadcast.findOneAndUpdate = () => {
    markerCalls += 1;
    const won = markerCalls === 1;
    return { lean: async () => (won ? sentDoc : null) };
  };
  Broadcast.findOne = () => ({ lean: async () => sentDoc });
  BroadcastDelivery.insertMany = async (docs) => {
    deliveryBatches += 1;
    return docs;
  };
  BroadcastDelivery.find = () => ({ lean: async () => [{ recipient_user_id: 1 }] });
  pool.query = async (sql) => {
    const text = String(sql);
    if (/SELECT id FROM users/i.test(text)) {
      return { rowCount: 1, rows: [{ id: 1 }] };
    }
    return { rowCount: 0, rows: [] };
  };

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id/send", "post");
  const handler = stack[stack.length - 1].handle;
  const firstRes = createRes();
  const secondRes = createRes();

  await handler({ params: { id: "7" } }, firstRes);
  await handler({ params: { id: "7" } }, secondRes);

  assert.equal(firstRes.statusCode, 200);
  assert.equal(firstRes.body?.delivered_count, 1);
  assert.equal(secondRes.statusCode, 409);
  assert.deepEqual(secondRes.body, { message: "Broadcast already sent" });
  assert.equal(markerCalls, 2);
  assert.equal(deliveryBatches, 1);
});

test("POST /admin/broadcasts/:id/send leaves no partial commit when delivery insert fails", async (t) => {
  const originalStartSession = mongoose.startSession;
  const originalFindOneAndUpdate = Broadcast.findOneAndUpdate;
  const originalInsertMany = BroadcastDelivery.insertMany;
  const originalQuery = pool.query;
  t.after(() => {
    mongoose.startSession = originalStartSession;
    Broadcast.findOneAndUpdate = originalFindOneAndUpdate;
    BroadcastDelivery.insertMany = originalInsertMany;
    pool.query = originalQuery;
  });

  const sessionCalls = { commit: 0, abort: 0 };
  mongoose.startSession = async () => ({
    async withTransaction(callback) {
      try { const result = await callback(); await this.commitTransaction(); return result; }
      catch (err) { await this.abortTransaction(); throw err; }
    },
    startTransaction() {},
    async commitTransaction() {
      sessionCalls.commit += 1;
    },
    async abortTransaction() {
      sessionCalls.abort += 1;
    },
    async endSession() {},
  });
  Broadcast.findOneAndUpdate = () => ({
    lean: async () => ({
      _id: "oid-broadcast-7",
      public_id: 7,
      title: "Title",
      body: "Body",
      severity: "danger",
      audience_type: "all",
      sent_at: "2026-03-11T00:00:00.000Z",
    }),
  });
  BroadcastDelivery.insertMany = async () => {
    throw new Error("delivery insert failed");
  };
  pool.query = async () => ({ rowCount: 1, rows: [{ id: 1 }] });

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id/send", "post");
  const handler = stack[stack.length - 1].handle;
  const res = createRes();

  await handler({ params: { id: "7" } }, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { message: "Server error" });
  assert.equal(sessionCalls.commit, 0);
  assert.equal(sessionCalls.abort, 1);
});

test("POST /admin/broadcasts/:id/send keeps committed state when push lookup fails", async (t) => {
  const markerDoc = {
    _id: "oid-broadcast-7",
    public_id: 7,
    title: "Title",
    body: "Body",
    severity: "danger",
    audience_type: "all",
    sent_at: "2026-03-11T00:00:00.000Z",
  };
  const { captured } = stubBroadcastSendModels(t, { markerDoc, audienceUserIds: [1, 2] });
  const originalDeliveryFind = BroadcastDelivery.find;
  t.after(() => {
    BroadcastDelivery.find = originalDeliveryFind;
  });
  BroadcastDelivery.find = () => {
    throw new Error("push recipient lookup failed");
  };

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id/send", "post");
  const handler = stack[stack.length - 1].handle;
  const res = createRes();

  await handler({ params: { id: "7" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.push.error, "Push delivery incomplete");
  assert.equal(captured.deliveryDocs.length, 2);
});

test("POST /admin/broadcasts/:id/publish uses audience_roles first with legacy fallback parameter still available", async (t) => {
  const markerDoc = {
    _id: "oid-broadcast-8",
    public_id: 8,
    title: "Title",
    body: "Body",
    severity: "announcement",
    audience_type: "role",
    audience_roles: ["student"],
    audience_role_ids: [4],
    created_by_admin_id: 9,
    sent_at: "2026-03-11T00:00:00.000Z",
  };
  const { sessionCalls, captured, capturedMarkerFilter } = stubBroadcastSendModels(t, {
    markerDoc,
    audienceUserIds: [5],
  });

  const stack = getRoute(adminBroadcastRouter, "/admin/broadcasts/:id/publish", "post");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { id: "8" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capturedMarkerFilter(), { public_id: 8, sent_at: null });
  assert.equal(res.body?.delivered_count, 1);
  assert.equal(res.body?.broadcast?.id, 8);
  assert.equal(res.body?.broadcast?.title, "Title");
  assert.deepEqual(
    captured.deliveryDocs.map((doc) => doc.recipient_user_id),
    [5]
  );
  assert.equal(sessionCalls.commit, 1);
  assert.equal(sessionCalls.abort, 0);
});

test("PATCH /admin/broadcasts/:id edits a draft and rejects unknown fields", async (t) => {
  const originalFindOne = Broadcast.findOne;
  const originalFindOneAndUpdate = Broadcast.findOneAndUpdate;
  t.after(() => {
    Broadcast.findOne = originalFindOne;
    Broadcast.findOneAndUpdate = originalFindOneAndUpdate;
  });

  const existingDoc = {
    public_id: 9,
    title: "Old title",
    body: "Old body",
    severity: "announcement",
    audience_type: "all",
    sent_at: null,
  };
  Broadcast.findOne = (filter) => {
    assert.deepEqual(filter, { public_id: 9 });
    return { lean: async () => ({ ...existingDoc }) };
  };

  let capturedFilter = null;
  let capturedUpdate = null;
  Broadcast.findOneAndUpdate = (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return {
      lean: async () => ({
        ...existingDoc,
        title: "New title",
        severity: "warning",
      }),
    };
  };

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id", "patch");
  const handler = stack[stack.length - 1].handle;

  const res = createRes();
  await handler(
    { params: { id: "9" }, body: { title: "New title", severity: "Warning" } },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capturedFilter, { public_id: 9, sent_at: null, audience_type: "all", audience_roles: null, audience_role_ids: null });
  assert.equal(capturedUpdate.$set.title, "New title");
  assert.equal(capturedUpdate.$set.severity, "warning");
  assert.ok(capturedUpdate.$set.updated_at instanceof Date);
  assert.equal(res.body?.id, 9);
  assert.equal(res.body?.title, "New title");

  const badRes = createRes();
  await handler({ params: { id: "9" }, body: { sent_at: "now" } }, badRes);
  assert.equal(badRes.statusCode, 400);
});

test("PATCH /admin/broadcasts/:id returns 409 for sent broadcasts and 404 when missing", async (t) => {
  const originalFindOne = Broadcast.findOne;
  const originalFindOneAndUpdate = Broadcast.findOneAndUpdate;
  t.after(() => {
    Broadcast.findOne = originalFindOne;
    Broadcast.findOneAndUpdate = originalFindOneAndUpdate;
  });

  Broadcast.findOne = () => ({
    lean: async () => ({
      public_id: 10,
      title: "Sent",
      body: "Body",
      severity: "danger",
      audience_type: "all",
      sent_at: "2026-03-11T00:00:00.000Z",
    }),
  });
  Broadcast.findOneAndUpdate = () => ({ lean: async () => null });

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id", "patch");
  const handler = stack[stack.length - 1].handle;

  const sentRes = createRes();
  await handler({ params: { id: "10" }, body: { title: "Late edit" } }, sentRes);
  assert.equal(sentRes.statusCode, 409);
  assert.deepEqual(sentRes.body, { message: "Broadcast already sent" });

  Broadcast.findOne = () => ({ lean: async () => null });
  const missingRes = createRes();
  await handler({ params: { id: "999" }, body: { title: "Ghost edit" } }, missingRes);
  assert.equal(missingRes.statusCode, 404);
  assert.deepEqual(missingRes.body, { message: "Broadcast not found" });
});

test("DELETE /admin/broadcasts/:id deletes a draft and returns numeric broadcast_id", async (t) => {
  const originalFindOneAndDelete = Broadcast.findOneAndDelete;
  const originalDeleteMany = BroadcastDelivery.deleteMany;
  t.after(() => {
    Broadcast.findOneAndDelete = originalFindOneAndDelete;
    BroadcastDelivery.deleteMany = originalDeleteMany;
  });

  let capturedFilter = null;
  let sweptFilter = null;
  Broadcast.findOneAndDelete = (filter) => {
    capturedFilter = filter;
    return { lean: async () => ({ public_id: 11, sent_at: null }) };
  };
  BroadcastDelivery.deleteMany = async (filter) => {
    sweptFilter = filter;
    return { deletedCount: 0 };
  };

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id", "delete");
  const handler = stack[stack.length - 1].handle;
  const res = createRes();

  await handler({ params: { id: "11" } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capturedFilter, { public_id: 11, sent_at: null });
  assert.deepEqual(sweptFilter, { broadcast_public_id: 11 });
  assert.deepEqual(res.body, { ok: true, broadcast_id: 11 });
});

test("DELETE /admin/broadcasts/:id returns 409 for sent broadcasts and 404 when missing", async (t) => {
  const originalFindOneAndDelete = Broadcast.findOneAndDelete;
  const originalFindOne = Broadcast.findOne;
  t.after(() => {
    Broadcast.findOneAndDelete = originalFindOneAndDelete;
    Broadcast.findOne = originalFindOne;
  });

  Broadcast.findOneAndDelete = () => ({ lean: async () => null });
  Broadcast.findOne = () => ({
    lean: async () => ({ public_id: 12, sent_at: "2026-03-11T00:00:00.000Z" }),
  });

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id", "delete");
  const handler = stack[stack.length - 1].handle;

  const sentRes = createRes();
  await handler({ params: { id: "12" } }, sentRes);
  assert.equal(sentRes.statusCode, 409);
  assert.deepEqual(sentRes.body, { message: "Broadcast already sent" });

  Broadcast.findOne = () => ({ lean: async () => null });
  const missingRes = createRes();
  await handler({ params: { id: "999" } }, missingRes);
  assert.equal(missingRes.statusCode, 404);
  assert.deepEqual(missingRes.body, { message: "Broadcast not found" });
});

test("DELETE /admin/broadcasts/:id denies personnel without manage_broadcasts", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [{ permissions: ["view_broadcasts"] }],
  });

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id", "delete");
  const permissionMiddleware = stack[1].handle;
  const req = { admin: { adminId: 21 } };
  const res = createRes();
  let nextCalled = false;

  await permissionMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { message: "Insufficient permissions" });
});
