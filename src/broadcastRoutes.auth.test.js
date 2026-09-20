import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes/broadcastRoutes.js";
import { pool } from "./db.js";
import { Broadcast } from "./models/Broadcast.js";
import { BroadcastDelivery } from "./models/BroadcastDelivery.js";

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
    },
  };
}

test("GET /admin/broadcasts/my/inbox returns 200 for authenticated app user via firebase uid claim", async (t) => {
  const originalQuery = pool.query;
  const originalDeliveryFind = BroadcastDelivery.find;
  const originalBroadcastFind = Broadcast.find;
  t.after(() => {
    pool.query = originalQuery;
    BroadcastDelivery.find = originalDeliveryFind;
    Broadcast.find = originalBroadcastFind;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /FROM users/i);
    assert.deepEqual(params, ["firebase-uid-1"]);
    return {
      rowCount: 1,
      rows: [{ id: 42 }],
    };
  };

  let capturedDeliveryFilter = null;
  BroadcastDelivery.find = (filter) => {
    capturedDeliveryFilter = filter;
    return {
      sort: () => ({
        lean: async () => [
          {
            broadcast_id: "oid-broadcast-5",
            broadcast_public_id: 5,
            recipient_user_id: 42,
            delivered_at: "2026-02-27T04:00:00.000Z",
            acknowledged_at: "2026-02-27T04:05:00.000Z",
          },
        ],
      }),
    };
  };
  Broadcast.find = (filter) => {
    assert.deepEqual(filter, { _id: { $in: ["oid-broadcast-5"] } });
    return {
      lean: async () => [
        {
          _id: "oid-broadcast-5",
          public_id: 5,
          title: "Broadcast",
          body: "Test",
          severity: "announcement",
          audience_type: "all",
          created_by_admin_id: 2,
          is_active: true,
          sent_at: "2026-02-27T03:00:00.000Z",
          created_at: "2026-02-27T02:00:00.000Z",
          updated_at: "2026-02-27T03:00:00.000Z",
        },
      ],
    };
  };

  const inboxStack = getRoute("/admin/broadcasts/my/inbox", "get");
  const handler = inboxStack[inboxStack.length - 1].handle;
  const req = { auth: { uid: "firebase-uid-1" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capturedDeliveryFilter, { recipient_user_id: 42 });
  assert.equal(Array.isArray(res.body), true);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 5);
  assert.equal(res.body[0].title, "Broadcast");
  assert.equal(res.body[0].acknowledged_at, "2026-02-27T04:05:00.000Z");
});

test("POST /admin/broadcasts/:id/ack persists acknowledgement and returns timestamp", async (t) => {
  const originalQuery = pool.query;
  const originalBroadcastFindOne = Broadcast.findOne;
  const originalFindOneAndUpdate = BroadcastDelivery.findOneAndUpdate;
  t.after(() => {
    pool.query = originalQuery;
    Broadcast.findOne = originalBroadcastFindOne;
    BroadcastDelivery.findOneAndUpdate = originalFindOneAndUpdate;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /FROM users/i);
    assert.deepEqual(params, ["firebase-uid-2"]);
    return {
      rowCount: 1,
      rows: [{ id: 100 }],
    };
  };

  Broadcast.findOne = (filter) => {
    assert.deepEqual(filter, { public_id: 7 });
    return { lean: async () => ({ public_id: 7 }) };
  };

  let capturedFilter = null;
  BroadcastDelivery.findOneAndUpdate = (filter) => {
    capturedFilter = filter;
    return {
      lean: async () => ({ acknowledged_at: "2026-03-23T12:00:00.000Z" }),
    };
  };

  const ackStack = getRoute("/admin/broadcasts/:id/ack", "post");
  const handler = ackStack[ackStack.length - 1].handle;
  const req = { auth: { uid: "firebase-uid-2" }, params: { id: "7" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capturedFilter, { broadcast_public_id: 7, recipient_user_id: 100 });
  assert.deepEqual(res.body, {
    ok: true,
    broadcast_id: 7,
    acknowledged_at: "2026-03-23T12:00:00.000Z",
  });
});

test("POST /admin/broadcasts/:id/ack is idempotent and preserves existing acknowledged_at", async (t) => {
  const originalQuery = pool.query;
  const originalBroadcastFindOne = Broadcast.findOne;
  const originalFindOneAndUpdate = BroadcastDelivery.findOneAndUpdate;
  t.after(() => {
    pool.query = originalQuery;
    Broadcast.findOne = originalBroadcastFindOne;
    BroadcastDelivery.findOneAndUpdate = originalFindOneAndUpdate;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /FROM users/i);
    assert.deepEqual(params, ["firebase-uid-2"]);
    return { rowCount: 1, rows: [{ id: 100 }] };
  };

  Broadcast.findOne = () => ({ lean: async () => ({ public_id: 7 }) });
  let updateCalls = 0;
  BroadcastDelivery.findOneAndUpdate = (filter, update) => {
    updateCalls += 1;
    assert.deepEqual(filter, { broadcast_public_id: 7, recipient_user_id: 100 });
    assert.ok(Array.isArray(update));
    return {
      lean: async () => ({ acknowledged_at: "2026-03-23T12:00:00.000Z" }),
    };
  };

  const ackStack = getRoute("/admin/broadcasts/:id/ack", "post");
  const handler = ackStack[ackStack.length - 1].handle;
  const req = { auth: { uid: "firebase-uid-2" }, params: { id: "7" } };
  const firstRes = createRes();
  const secondRes = createRes();

  await handler(req, firstRes);
  await handler(req, secondRes);

  assert.equal(updateCalls, 2);
  assert.equal(firstRes.statusCode, 200);
  assert.deepEqual(firstRes.body, {
    ok: true,
    broadcast_id: 7,
    acknowledged_at: "2026-03-23T12:00:00.000Z",
  });
  assert.equal(secondRes.statusCode, 200);
  assert.deepEqual(secondRes.body, {
    ok: true,
    broadcast_id: 7,
    acknowledged_at: "2026-03-23T12:00:00.000Z",
  });
});

test("GET /admin/broadcasts/my/inbox returns 401 without bearer token", async () => {
  const inboxStack = getRoute("/admin/broadcasts/my/inbox", "get");
  const authMiddleware = inboxStack[0].handle;
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

test("POST /admin/broadcasts/:id/ack blocks user when broadcast is not in inbox", async (t) => {
  const originalQuery = pool.query;
  const originalBroadcastFindOne = Broadcast.findOne;
  const originalFindOneAndUpdate = BroadcastDelivery.findOneAndUpdate;
  t.after(() => {
    pool.query = originalQuery;
    Broadcast.findOne = originalBroadcastFindOne;
    BroadcastDelivery.findOneAndUpdate = originalFindOneAndUpdate;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /FROM users/i);
    assert.deepEqual(params, ["firebase-uid-3"]);
    return {
      rowCount: 1,
      rows: [{ id: 200 }],
    };
  };

  Broadcast.findOne = (filter) => {
    assert.deepEqual(filter, { public_id: 9 });
    return { lean: async () => ({ public_id: 9 }) };
  };
  BroadcastDelivery.findOneAndUpdate = (filter) => {
    assert.deepEqual(filter, { broadcast_public_id: 9, recipient_user_id: 200 });
    return {
      lean: async () => null,
    };
  };

  const ackStack = getRoute("/admin/broadcasts/:id/ack", "post");
  const handler = ackStack[ackStack.length - 1].handle;
  const req = { auth: { uid: "firebase-uid-3" }, params: { id: "9" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Delivery not found" });
});

test("POST /admin/broadcasts/:id/ack returns 404 when broadcast does not exist", async (t) => {
  const originalQuery = pool.query;
  const originalBroadcastFindOne = Broadcast.findOne;
  t.after(() => {
    pool.query = originalQuery;
    Broadcast.findOne = originalBroadcastFindOne;
  });

  pool.query = async () => ({ rowCount: 1, rows: [{ id: 200 }] });
  Broadcast.findOne = () => ({ lean: async () => null });

  const ackStack = getRoute("/admin/broadcasts/:id/ack", "post");
  const handler = ackStack[ackStack.length - 1].handle;
  const res = createRes();

  await handler({ auth: { uid: "firebase-uid-3" }, params: { id: "999" } }, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Broadcast not found" });
});
