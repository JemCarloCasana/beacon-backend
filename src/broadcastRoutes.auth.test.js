import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes/broadcastRoutes.js";
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
    },
  };
}

test("GET /admin/broadcasts/my/inbox returns 200 for authenticated app user via firebase uid claim", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let call = 0;
  pool.query = async (sql, params) => {
    call += 1;

    if (call === 1) {
      assert.match(sql, /FROM users/i);
      assert.deepEqual(params, ["firebase-uid-1"]);
      return {
        rowCount: 1,
        rows: [{ id: 42 }],
      };
    }

    assert.match(sql, /FROM broadcast_user_deliveries/i);
    assert.deepEqual(params, [42]);
    return {
      rowCount: 1,
      rows: [
        {
          id: "5",
          title: "Broadcast",
          body: "Test",
          delivered_at: "2026-02-27T04:00:00.000Z",
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
  assert.equal(Array.isArray(res.body), true);
  assert.equal(res.body.length, 1);
});

test("POST /admin/broadcasts/:id/ack returns 200 for authenticated app user with delivery", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let call = 0;
  pool.query = async (sql, params) => {
    call += 1;

    if (call === 1) {
      assert.match(sql, /FROM users/i);
      assert.deepEqual(params, ["firebase-uid-2"]);
      return {
        rowCount: 1,
        rows: [{ id: 100 }],
      };
    }

    if (call === 2) {
      assert.match(sql, /FROM broadcasts/i);
      assert.deepEqual(params, [7]);
      return {
        rowCount: 1,
        rows: [{ id: 7 }],
      };
    }

    assert.match(sql, /FROM broadcast_user_deliveries/i);
    assert.deepEqual(params, [7, 100]);
    return {
      rowCount: 1,
      rows: [{ "?column?": 1 }],
    };
  };

  const ackStack = getRoute("/admin/broadcasts/:id/ack", "post");
  const handler = ackStack[ackStack.length - 1].handle;
  const req = { auth: { uid: "firebase-uid-2" }, params: { id: "7" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
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
  t.after(() => {
    pool.query = originalQuery;
  });

  let call = 0;
  pool.query = async (sql, params) => {
    call += 1;

    if (call === 1) {
      assert.match(sql, /FROM users/i);
      assert.deepEqual(params, ["firebase-uid-3"]);
      return {
        rowCount: 1,
        rows: [{ id: 200 }],
      };
    }

    if (call === 2) {
      assert.match(sql, /FROM broadcasts/i);
      assert.deepEqual(params, [9]);
      return {
        rowCount: 1,
        rows: [{ id: 9 }],
      };
    }

    assert.match(sql, /FROM broadcast_user_deliveries/i);
    assert.deepEqual(params, [9, 200]);
    return {
      rowCount: 0,
      rows: [],
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
