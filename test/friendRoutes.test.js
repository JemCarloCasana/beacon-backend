import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/friendRoutes.js";
import { pool } from "../src/db.js";

function findRouteHandler(path, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return layer.route.stack[layer.route.stack.length - 1].handle;
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

const sendFriendRequestHandler = findRouteHandler("/friends/request", "post");
const sendFriendRequestByUserHandler = findRouteHandler("/friends/request/by-user", "post");
const incomingFriendRequestsHandler = findRouteHandler("/friends/requests/incoming", "get");
const acceptFriendRequestHandler = findRouteHandler("/friends/requests/:id/accept", "post");
const deleteFriendHandler = findRouteHandler("/friends/:id", "delete");
const listFriendsHandler = findRouteHandler("/friends", "get");

test("POST /friends/request creates a pending request when the pair state is NONE", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    if (queryCount === 1) {
      assert.match(String(sql), /SELECT id FROM users WHERE firebase_uid = \$1/i);
      assert.deepEqual(params, ["firebase-uid-1"]);
      return { rowCount: 1, rows: [{ id: 10 }] };
    }
    if (queryCount === 2) {
      assert.match(String(sql), /SELECT id FROM users WHERE beacon_code = \$1/i);
      assert.deepEqual(params, ["ABC123"]);
      return { rowCount: 1, rows: [{ id: 20 }] };
    }
    throw new Error(`Unexpected pool.query: ${sql}`);
  };

  const client = {
    async query(sql, params) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.friendships/i.test(text)) return { rowCount: 0, rows: [] };
      if (/FROM public\.friend_requests/i.test(text) && /status = 'pending'/i.test(text)) {
        return { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO friend_requests/i.test(text)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 71,
              requester_user_id: 10,
              addressee_user_id: 20,
              status: "pending",
              created_at: "2026-03-20T01:00:00.000Z",
            },
          ],
        };
      }
      if (/^COMMIT$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { beacon_code: " abc123 " },
  };
  const res = createRes();

  await sendFriendRequestHandler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.id, 71);
  assert.equal(res.body.requester_user_id, 10);
  assert.equal(res.body.addressee_user_id, 20);
  assert.equal(res.body.status, "pending");
});

test("POST /friends/request succeeds when only historical accepted rows exist for the pair", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    if (queryCount === 1) return { rowCount: 1, rows: [{ id: 1 }] };
    if (queryCount === 2) return { rowCount: 1, rows: [{ id: 759 }] };
    throw new Error("Unexpected pool.query call");
  };

  const client = {
    async query(sql) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.friendships/i.test(text)) return { rowCount: 0, rows: [] };
      if (/FROM public\.friend_requests/i.test(text) && /status = 'pending'/i.test(text)) {
        return { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO friend_requests/i.test(text)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 101,
              requester_user_id: 1,
              addressee_user_id: 759,
              status: "pending",
              created_at: "2026-03-23T01:00:00.000Z",
            },
          ],
        };
      }
      if (/^COMMIT$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { beacon_code: "BEACON759" },
  };
  const res = createRes();

  await sendFriendRequestHandler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.id, 101);
  assert.equal(res.body.requester_user_id, 1);
  assert.equal(res.body.addressee_user_id, 759);
  assert.equal(res.body.status, "pending");
});

test("POST /friends/request returns 409 when a pending request already exists for the pair", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    if (queryCount === 1) return { rowCount: 1, rows: [{ id: 10 }] };
    if (queryCount === 2) return { rowCount: 1, rows: [{ id: 20 }] };
    throw new Error("Unexpected pool.query call");
  };

  const client = {
    async query(sql) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.friendships/i.test(text)) return { rowCount: 0, rows: [] };
      if (/FROM public\.friend_requests/i.test(text) && /status = 'pending'/i.test(text)) {
        return {
          rowCount: 1,
          rows: [{ id: 99, requester_user_id: 20, addressee_user_id: 10, status: "pending" }],
        };
      }
      if (/^ROLLBACK$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { beacon_code: "ABC123" },
  };
  const res = createRes();

  await sendFriendRequestHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    message: "Open friend request already exists",
    code: "FRIEND_REQUEST_PENDING",
  });
});

test("POST /friends/request returns 500 for legacy friend_requests uniqueness conflicts", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const originalError = console.error;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    console.error = originalError;
  });

  console.error = () => {};

  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    if (queryCount === 1) return { rowCount: 1, rows: [{ id: 1 }] };
    if (queryCount === 2) return { rowCount: 1, rows: [{ id: 759 }] };
    throw new Error("Unexpected pool.query call");
  };

  const client = {
    async query(sql) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.friendships/i.test(text)) return { rowCount: 0, rows: [] };
      if (/FROM public\.friend_requests/i.test(text) && /status = 'pending'/i.test(text)) {
        return { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO friend_requests/i.test(text)) {
        const error = new Error("duplicate key value violates unique constraint");
        error.code = "23505";
        error.constraint = "friend_requests_requester_user_id_addressee_user_id_key";
        throw error;
      }
      if (/^ROLLBACK$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { beacon_code: "BEACON759" },
  };
  const res = createRes();

  await sendFriendRequestHandler(req, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { message: "Server error" });
});

test("POST /friends/request treats a stale historical pending row as a pair-level conflict before cleanup", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    if (queryCount === 1) return { rowCount: 1, rows: [{ id: 10 }] };
    if (queryCount === 2) return { rowCount: 1, rows: [{ id: 20 }] };
    throw new Error("Unexpected pool.query call");
  };

  const client = {
    async query(sql) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.friendships/i.test(text)) return { rowCount: 0, rows: [] };
      if (/FROM public\.friend_requests/i.test(text) && /status = 'pending'/i.test(text)) {
        return {
          rowCount: 1,
          rows: [{ id: 33, requester_user_id: 20, addressee_user_id: 10, status: "pending" }],
        };
      }
      if (/^ROLLBACK$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { beacon_code: "ABC123" },
  };
  const res = createRes();

  await sendFriendRequestHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    message: "Open friend request already exists",
    code: "FRIEND_REQUEST_PENDING",
  });
});

test("POST /friends/request returns 409 when the pair is already friends", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    if (queryCount === 1) return { rowCount: 1, rows: [{ id: 10 }] };
    if (queryCount === 2) return { rowCount: 1, rows: [{ id: 20 }] };
    throw new Error("Unexpected pool.query call");
  };

  const client = {
    async query(sql) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.friendships/i.test(text)) {
        return { rowCount: 1, rows: [{ user_id: 10, friend_user_id: 20 }] };
      }
      if (/^ROLLBACK$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { beacon_code: "ABC123" },
  };
  const res = createRes();

  await sendFriendRequestHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    message: "Already friends",
    code: "ALREADY_FRIENDS",
  });
});

test("POST /friends/request/by-user creates a pending request with the same response shape", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    if (queryCount === 1) {
      assert.match(String(sql), /SELECT id FROM users WHERE firebase_uid = \$1/i);
      assert.deepEqual(params, ["firebase-uid-1"]);
      return { rowCount: 1, rows: [{ id: 10 }] };
    }
    if (queryCount === 2) {
      assert.match(String(sql), /SELECT id FROM users WHERE id = \$1/i);
      assert.deepEqual(params, [20]);
      return { rowCount: 1, rows: [{ id: 20 }] };
    }
    throw new Error(`Unexpected pool.query: ${sql}`);
  };

  const client = {
    async query(sql, params) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.friendships/i.test(text)) return { rowCount: 0, rows: [] };
      if (/FROM public\.friend_requests/i.test(text) && /status = 'pending'/i.test(text)) {
        return { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO friend_requests/i.test(text)) {
        assert.deepEqual(params, [10, 20]);
        return {
          rowCount: 1,
          rows: [
            {
              id: 88,
              requester_user_id: 10,
              addressee_user_id: 20,
              status: "pending",
              created_at: "2026-03-21T01:00:00.000Z",
            },
          ],
        };
      }
      if (/^COMMIT$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { user_id: 20 },
  };
  const res = createRes();

  await sendFriendRequestByUserHandler(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, {
    id: 88,
    requester_user_id: 10,
    addressee_user_id: 20,
    status: "pending",
    created_at: "2026-03-21T01:00:00.000Z",
  });
});

test("POST /friends/request/by-user rejects self requests", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    if (queryCount === 1) return { rowCount: 1, rows: [{ id: 10 }] };
    if (queryCount === 2) return { rowCount: 1, rows: [{ id: 10 }] };
    throw new Error("Unexpected pool.query call");
  };

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { user_id: 10 },
  };
  const res = createRes();

  await sendFriendRequestByUserHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Cannot add yourself" });
});

test("POST /friends/request/by-user returns 404 when target user is missing", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    if (queryCount === 1) return { rowCount: 1, rows: [{ id: 10 }] };
    if (queryCount === 2) return { rowCount: 0, rows: [] };
    throw new Error("Unexpected pool.query call");
  };

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { user_id: 999 },
  };
  const res = createRes();

  await sendFriendRequestByUserHandler(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "User not found" });
});

test("POST /friends/request/by-user returns 409 when a pending request already exists", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    if (queryCount === 1) return { rowCount: 1, rows: [{ id: 10 }] };
    if (queryCount === 2) return { rowCount: 1, rows: [{ id: 20 }] };
    throw new Error("Unexpected pool.query call");
  };

  const client = {
    async query(sql) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.friendships/i.test(text)) return { rowCount: 0, rows: [] };
      if (/FROM public\.friend_requests/i.test(text) && /status = 'pending'/i.test(text)) {
        return {
          rowCount: 1,
          rows: [{ id: 12, requester_user_id: 20, addressee_user_id: 10, status: "pending" }],
        };
      }
      if (/^ROLLBACK$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { user_id: 20 },
  };
  const res = createRes();

  await sendFriendRequestByUserHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    message: "Open friend request already exists",
    code: "FRIEND_REQUEST_PENDING",
  });
});

test("POST /friends/request/by-user returns 409 when already friends", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    if (queryCount === 1) return { rowCount: 1, rows: [{ id: 10 }] };
    if (queryCount === 2) return { rowCount: 1, rows: [{ id: 20 }] };
    throw new Error("Unexpected pool.query call");
  };

  const client = {
    async query(sql) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.friendships/i.test(text)) {
        return { rowCount: 1, rows: [{ user_id: 10, friend_user_id: 20 }] };
      }
      if (/^ROLLBACK$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-1" },
    body: { user_id: 20 },
  };
  const res = createRes();

  await sendFriendRequestByUserHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    message: "Already friends",
    code: "ALREADY_FRIENDS",
  });
});

test("GET /friends/requests/incoming returns pending request DTOs with addressee_user_id", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    if (queryCount === 1) {
      assert.deepEqual(params, ["firebase-uid-1"]);
      return { rowCount: 1, rows: [{ id: 44 }] };
    }
    assert.match(String(sql), /fr\.status = 'pending'/i);
    return {
      rowCount: 1,
      rows: [
        {
          id: 12,
          requester_user_id: 10,
          addressee_user_id: 44,
          requester_name: "Requester One",
          requester_beacon_code: "BCN001",
          status: "pending",
          created_at: "2026-03-20T01:00:00.000Z",
        },
      ],
    };
  };

  const req = { auth: { uid: "firebase-uid-1" } };
  const res = createRes();

  await incomingFriendRequestsHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [
    {
      id: 12,
      requester_user_id: 10,
      addressee_user_id: 44,
      requester_name: "Requester One",
      requester_beacon_code: "BCN001",
      status: "pending",
      created_at: "2026-03-20T01:00:00.000Z",
    },
  ]);
});

test("GET /friends/requests/incoming excludes cancelled historical requests after cleanup", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    if (queryCount === 1) {
      assert.deepEqual(params, ["firebase-uid-1"]);
      return { rowCount: 1, rows: [{ id: 44 }] };
    }
    assert.match(String(sql), /fr\.status = 'pending'/i);
    return { rowCount: 0, rows: [] };
  };

  const req = { auth: { uid: "firebase-uid-1" } };
  const res = createRes();

  await incomingFriendRequestsHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
});

test("POST /friends/requests/:id/accept returns stale conflict when the request is no longer pending", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const client = {
    async query(sql, params) {
      const text = String(sql);
      if (/SELECT id FROM users WHERE firebase_uid = \$1/i.test(text)) {
        assert.deepEqual(params, ["firebase-uid-2"]);
        return { rowCount: 1, rows: [{ id: 20 }] };
      }
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/FROM friend_requests/i.test(text) && /FOR UPDATE/i.test(text)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 17,
              requester_user_id: 10,
              addressee_user_id: 20,
              status: "cancelled",
            },
          ],
        };
      }
      if (/^ROLLBACK$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-2" },
    params: { id: "17" },
  };
  const res = createRes();

  await acceptFriendRequestHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    message: "Friend request is no longer pending",
    code: "STALE_FRIEND_REQUEST",
    status: "cancelled",
  });
});

test("POST /friends/requests/:id/accept returns stale conflict when the pair is already friends", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const client = {
    async query(sql, params) {
      const text = String(sql);
      if (/SELECT id FROM users WHERE firebase_uid = \$1/i.test(text)) {
        assert.deepEqual(params, ["firebase-uid-2"]);
        return { rowCount: 1, rows: [{ id: 20 }] };
      }
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/FROM friend_requests/i.test(text) && /FOR UPDATE/i.test(text)) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 17,
              requester_user_id: 10,
              addressee_user_id: 20,
              status: "pending",
            },
          ],
        };
      }
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/FROM public\.friendships/i.test(text)) {
        return { rowCount: 1, rows: [{ user_id: 10, friend_user_id: 20 }] };
      }
      if (/^ROLLBACK$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-2" },
    params: { id: "17" },
  };
  const res = createRes();

  await acceptFriendRequestHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    message: "Friend request is stale or invalid",
    code: "STALE_FRIEND_REQUEST",
  });
});

test("DELETE /friends/:id is idempotent and clears the pair without returning 404", async (t) => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  t.after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });

  pool.query = async (sql, params) => {
    assert.match(String(sql), /SELECT id FROM users WHERE firebase_uid = \$1/i);
    assert.deepEqual(params, ["firebase-uid-1"]);
    return { rowCount: 1, rows: [{ id: 10 }] };
  };

  const client = {
    async query(sql, params) {
      const text = String(sql);
      if (/^BEGIN$/i.test(text.trim())) return { rowCount: null, rows: [] };
      if (/pg_advisory_xact_lock/i.test(text)) return { rowCount: 1, rows: [] };
      if (/DELETE FROM public\.friendships/i.test(text)) {
        assert.deepEqual(params, [10, 20]);
        return { rowCount: 0, rows: [] };
      }
      if (/UPDATE public\.friend_requests/i.test(text)) {
        assert.deepEqual(params, [10, 20]);
        return { rowCount: 0, rows: [] };
      }
      if (/^COMMIT$/i.test(text.trim())) return { rowCount: null, rows: [] };
      throw new Error(`Unexpected client.query: ${text}`);
    },
    release() {},
  };
  pool.connect = async () => client;

  const req = {
    auth: { uid: "firebase-uid-1" },
    params: { id: "20" },
  };
  const res = createRes();

  await deleteFriendHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("GET /friends lists the other user from canonical friendship rows", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let queryCount = 0;
  pool.query = async (sql, params) => {
    queryCount += 1;
    if (queryCount === 1) {
      return { rowCount: 1, rows: [{ id: 10 }] };
    }
    const text = String(sql);
    assert.match(text, /CASE/i);
    assert.match(text, /\$1 IN \(f\.user_id, f\.friend_user_id\)/i);
    assert.deepEqual(params, [10]);
    return {
      rowCount: 1,
      rows: [
        {
          id: 20,
          full_name: "Friend User",
          email: "friend@example.com",
          phone_number: "+1234567890",
          beacon_code: "FRIEND1",
        },
      ],
    };
  };

  const req = { auth: { uid: "firebase-uid-1" } };
  const res = createRes();

  await listFriendsHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, [
    {
      id: 20,
      full_name: "Friend User",
      email: "friend@example.com",
      phone_number: "+1234567890",
      beacon_code: "FRIEND1",
    },
  ]);
});
