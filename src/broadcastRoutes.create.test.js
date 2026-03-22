import test from "node:test";
import assert from "node:assert/strict";

import broadcastRouter from "./routes/broadcastRoutes.js";
import adminBroadcastRouter from "./routes/adminBroadcastRoutes.js";
import { pool } from "./db.js";

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
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /INSERT INTO broadcasts/i);
    assert.deepEqual(params, [
      "Campus Alert",
      "Classes suspended",
      "danger",
      "role",
      ["citizen", "student"],
      null,
      9,
    ]);
    return {
      rowCount: 1,
      rows: [{ id: 1, audience_roles: ["citizen", "student"], audience_role_ids: null }],
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
  assert.deepEqual(res.body.audience_roles, ["citizen", "student"]);
});

test("POST /admin/broadcasts accepts deprecated audience_role_ids fallback", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /INSERT INTO broadcasts/i);
    assert.deepEqual(params, [
      "Legacy Alert",
      "Legacy payload",
      "warning",
      "role",
      null,
      [1, 2],
      11,
    ]);
    return {
      rowCount: 1,
      rows: [{ id: 2, audience_roles: null, audience_role_ids: [1, 2] }],
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
  assert.deepEqual(res.body.audience_role_ids, [1, 2]);
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
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  });

  let call = 0;
  const client = {
    async query(sql, params) {
      call += 1;
      if (call === 1) {
        assert.match(sql, /BEGIN/i);
        return { rowCount: 0, rows: [] };
      }
      if (call === 2) {
        assert.match(sql, /UPDATE broadcasts/i);
        return {
          rowCount: 1,
          rows: [
            {
              id: 7,
              title: "Title",
              body: "Body",
              severity: "danger",
              audience_type: "role",
              audience_roles: ["citizen"],
              audience_role_ids: [3],
              sent_at: "2026-03-11T00:00:00.000Z",
            },
          ],
        };
      }
      if (call === 3) {
        assert.match(sql, /unnest\(COALESCE\(\$3::text\[\]/i);
        assert.match(sql, /unnest\(COALESCE\(\$4::int\[\]/i);
        assert.deepEqual(params, [7, "role", ["citizen"], [3]]);
        return { rowCount: 2, rows: [] };
      }
      if (call === 4) {
        assert.match(sql, /COMMIT/i);
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected client query call ${call}`);
    },
    release() {},
  };

  pool.connect = async () => client;
  pool.query = async () => ({ rows: [] });

  const stack = getRoute(broadcastRouter, "/admin/broadcasts/:id/send", "post");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { id: "7" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.delivered_count, 2);
});

test("POST /admin/broadcasts/:id/publish uses audience_roles first with legacy fallback parameter still available", async (t) => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  t.after(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  });

  let call = 0;
  const client = {
    async query(sql, params) {
      call += 1;
      if (call === 1) {
        assert.match(sql, /BEGIN/i);
        return { rowCount: 0, rows: [] };
      }
      if (call === 2) {
        assert.match(sql, /UPDATE broadcasts/i);
        return {
          rowCount: 1,
          rows: [
            {
              id: 8,
              title: "Title",
              body: "Body",
              severity: "announcement",
              audience_type: "role",
              audience_roles: ["student"],
              audience_role_ids: [4],
            },
          ],
        };
      }
      if (call === 3) {
        assert.match(sql, /unnest\(COALESCE\(\$3::text\[\]/i);
        assert.match(sql, /unnest\(COALESCE\(\$4::int\[\]/i);
        assert.deepEqual(params, [8, "role", ["student"], [4]]);
        return { rowCount: 1, rows: [] };
      }
      if (call === 4) {
        assert.match(sql, /COMMIT/i);
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected client query call ${call}`);
    },
    release() {},
  };

  pool.connect = async () => client;
  pool.query = async () => ({ rows: [] });

  const stack = getRoute(adminBroadcastRouter, "/admin/broadcasts/:id/publish", "post");
  const handler = stack[stack.length - 1].handle;
  const req = { params: { id: "8" } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.delivered_count, 1);
});
