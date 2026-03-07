import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes/adminAdminsRoutes.js";
import { pool } from "./db.js";

function findRouteLayer(path, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods?.[method]
  );
  if (!layer) {
    throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  }
  return layer.route.stack;
}

function createRes() {
  const headers = {};
  return {
    statusCode: 200,
    body: null,
    headers,
    set(name, value) {
      headers[String(name).toLowerCase()] = value;
      return this;
    },
    get(name) {
      return headers[String(name).toLowerCase()];
    },
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

const adminAdminsPatchStack = findRouteLayer("/admin/admins/:id", "patch");
const adminAdminsGetStack = findRouteLayer("/admin/admins", "get");
const adminAdminsDeleteStack = findRouteLayer("/admin/admins/:id", "delete");
const adminNotificationsGetStack = findRouteLayer("/admin/notifications", "get");
const adminNotificationsReadStack = findRouteLayer("/admin/notifications/:id/read", "patch");
const adminRequestsPostStack = findRouteLayer("/admin/admin-requests", "post");
const patchAdminAdminPermissionMiddleware = adminAdminsPatchStack[1].handle;
const patchAdminAdminHandler = adminAdminsPatchStack[adminAdminsPatchStack.length - 1].handle;
const getAdminsHandler = adminAdminsGetStack[adminAdminsGetStack.length - 1].handle;
const deleteAdminHandler = adminAdminsDeleteStack[adminAdminsDeleteStack.length - 1].handle;
const getNotificationsHandler = adminNotificationsGetStack[adminNotificationsGetStack.length - 1].handle;
const patchNotificationReadHandler =
  adminNotificationsReadStack[adminNotificationsReadStack.length - 1].handle;
const postAdminRequestHandler = adminRequestsPostStack[adminRequestsPostStack.length - 1].handle;

test("PATCH /admin/admins/:id returns 200", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [{ id: 2, email: "admin2@example.com", full_name: "Admin Two", role_id: 1, created_at: "2026-01-01" }]
  });

  const req = { params: { id: "2" }, body: { full_name: "Admin Two", email: "admin2@example.com" } };
  const res = createRes();

  await patchAdminAdminHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, 2);
});

test("PATCH /admin/admins/:id returns 422 for invalid id", async () => {
  const req = { params: { id: "0" }, body: { full_name: "Valid Name" } };
  const res = createRes();

  await patchAdminAdminHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    message: "Validation failed",
    errors: { id: ["Must be a positive integer"] }
  });
});

test("PATCH /admin/admins/:id returns 422 for unknown field", async () => {
  const req = { params: { id: "2" }, body: { role: "admin" } };
  const res = createRes();

  await patchAdminAdminHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.message, "Validation failed");
});

test("PATCH /admin/admins/:id returns 404 when admin not found", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({ rowCount: 0, rows: [] });

  const req = { params: { id: "9999" }, body: { full_name: "No Admin" } };
  const res = createRes();

  await patchAdminAdminHandler(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Admin not found" });
});

test("PATCH /admin/admins/:id returns 409 on duplicate email", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => {
    const err = new Error("duplicate key");
    err.code = "23505";
    throw err;
  };

  const req = { params: { id: "2" }, body: { email: "existing@example.com" } };
  const res = createRes();

  await patchAdminAdminHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { message: "Email already exists" });
});

test("PATCH /admin/admins/:id middleware returns 403 without manage_admins", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [{ permissions: ["manage_users"] }]
  });

  const req = { admin: { adminId: 123 } };
  const res = createRes();
  let nextCalled = false;

  await patchAdminAdminPermissionMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { message: "Insufficient permissions" });
});

test("GET /admin/admins returns all statuses by default", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (_sql, values) => {
    assert.deepEqual(values, []);
    return {
      rowCount: 2,
      rows: [
        { id: 1, email: "a@example.com", full_name: "A", role_id: 1, created_at: "2026-01-01", status: "active" },
        { id: 2, email: "b@example.com", full_name: "B", role_id: 2, created_at: "2026-01-02", status: "deactivated" }
      ]
    };
  };

  const req = { query: {} };
  const res = createRes();

  await getAdminsHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].status, "active");
  assert.equal(res.body[1].status, "deactivated");
});

test("GET /admin/admins filters active status", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (_sql, values) => {
    assert.deepEqual(values, ["active"]);
    return {
      rowCount: 1,
      rows: [{ id: 1, email: "a@example.com", full_name: "A", role_id: 1, created_at: "2026-01-01", status: "active" }]
    };
  };

  const req = { query: { status: "active" } };
  const res = createRes();

  await getAdminsHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].status, "active");
});

test("GET /admin/admins filters deactivated status", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (_sql, values) => {
    assert.deepEqual(values, ["deactivated"]);
    return {
      rowCount: 1,
      rows: [{ id: 2, email: "b@example.com", full_name: "B", role_id: 2, created_at: "2026-01-02", status: "deactivated" }]
    };
  };

  const req = { query: { status: "deactivated" } };
  const res = createRes();

  await getAdminsHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].status, "deactivated");
});

test("GET /admin/admins returns 400 for invalid status filter", async () => {
  const req = { query: { status: "paused" } };
  const res = createRes();

  await getAdminsHandler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid status filter" });
});

test("DELETE /admin/admins/:id is disabled", async () => {
  const req = { params: { id: "9" }, admin: { adminId: 1 } };
  const res = createRes();

  await deleteAdminHandler(req, res);

  assert.equal(res.statusCode, 410);
  assert.deepEqual(res.body, {
    message: "Admin deletion is disabled. Use PATCH /admin/users/:id with status=deactivated or status=active.",
  });
});

test("GET /admin/notifications preserves admin_request type", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        id: 71,
        recipient_admin_id: 55,
        type: "admin_request",
        title: "Admin Access Request",
        message: "You have received an admin access request.",
        metadata: { admin_request_id: 101, requested_by_admin_id: 9 },
        is_read: false,
        created_at: "2026-03-07T01:00:00.000Z",
      },
    ],
  });

  const req = { admin: { adminId: 55 } };
  const res = createRes();

  await getNotificationsHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].type, "admin_request");
  assert.equal(res.body[0].metadata.admin_request_id, 101);
  assert.equal(res.get("cache-control"), "no-store, private, max-age=0");
  assert.equal(res.get("pragma"), "no-cache");
  assert.equal(res.get("vary"), "Authorization");
});

test("GET /admin/notifications returns [] for non-recipient admin", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 0,
    rows: [],
  });

  const req = { admin: { adminId: 999 } };
  const res = createRes();

  await getNotificationsHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, []);
});

test("GET /admin/notifications normalizes legacy string metadata admin_request_id", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        id: 72,
        recipient_admin_id: 55,
        type: "admin_request",
        title: "Admin Access Request",
        message: "You have received an admin access request.",
        metadata: { admin_request_id: "101", requested_by_admin_id: 9 },
        is_read: false,
        created_at: "2026-03-07T01:01:00.000Z",
      },
    ],
  });

  const req = { admin: { adminId: 55 } };
  const res = createRes();

  await getNotificationsHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.length, 1);
  assert.equal(typeof res.body[0].metadata.admin_request_id, "number");
  assert.equal(res.body[0].metadata.admin_request_id, 101);
});

test("POST /admin/admin-requests inserts notification metadata with admin_request_id", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  let capturedNotificationValues = null;
  const client = {
    query: async (sql, values = []) => {
      const compactSql = String(sql).replace(/\s+/g, " ").trim();
      if (compactSql === "BEGIN") {
        return { rowCount: null, rows: [] };
      }
      if (compactSql.includes("SELECT a.id, r.name AS role FROM admins a")) {
        return { rowCount: 1, rows: [{ id: 55, role: "personnel" }] };
      }
      if (compactSql.includes("INSERT INTO admin_requests")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 777,
              personnel_id: 55,
              requested_by_admin_id: 9,
              status: "pending",
              note: null,
              created_at: "2026-03-07T02:00:00.000Z",
            },
          ],
        };
      }
      if (compactSql.includes("INSERT INTO notifications")) {
        capturedNotificationValues = values;
        return { rowCount: 1, rows: [{ id: 998 }] };
      }
      if (compactSql === "COMMIT") {
        return { rowCount: null, rows: [] };
      }
      if (compactSql === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${compactSql}`);
    },
    release: () => {},
  };

  pool.connect = async () => client;

  const req = {
    body: { personnel_id: 55 },
    admin: { adminId: 9 },
  };
  const res = createRes();

  await postAdminRequestHandler(req, res);

  assert.equal(res.statusCode, 201);
  assert.ok(Array.isArray(capturedNotificationValues));
  assert.equal(capturedNotificationValues[0], 55);
  assert.notEqual(capturedNotificationValues[0], 9);
  assert.equal(capturedNotificationValues[1], "admin_request");

  const metadata = JSON.parse(capturedNotificationValues[4]);
  assert.equal(metadata.admin_request_id, 777);
  assert.equal(metadata.requested_by_admin_id, 9);
});

test("POST /admin/admin-requests rolls back when notification insert fails", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  let rollbackCalled = false;
  let commitCalled = false;

  const client = {
    query: async (sql) => {
      const compactSql = String(sql).replace(/\s+/g, " ").trim();
      if (compactSql === "BEGIN") {
        return { rowCount: null, rows: [] };
      }
      if (compactSql.includes("SELECT a.id, r.name AS role FROM admins a")) {
        return { rowCount: 1, rows: [{ id: 55, role: "personnel" }] };
      }
      if (compactSql.includes("INSERT INTO admin_requests")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 778,
              personnel_id: 55,
              requested_by_admin_id: 9,
              status: "pending",
              note: null,
              created_at: "2026-03-07T02:10:00.000Z",
            },
          ],
        };
      }
      if (compactSql.includes("INSERT INTO notifications")) {
        throw new Error("notification insert failed");
      }
      if (compactSql === "ROLLBACK") {
        rollbackCalled = true;
        return { rowCount: null, rows: [] };
      }
      if (compactSql === "COMMIT") {
        commitCalled = true;
        return { rowCount: null, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${compactSql}`);
    },
    release: () => {},
  };

  pool.connect = async () => client;

  const req = {
    body: { personnel_id: 55 },
    admin: { adminId: 9 },
  };
  const res = createRes();

  await postAdminRequestHandler(req, res);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { message: "Server error" });
  assert.equal(rollbackCalled, true);
  assert.equal(commitCalled, false);
});

test("PATCH /admin/notifications/:id/read scopes update to recipient admin", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let capturedValues = null;
  pool.query = async (_sql, values) => {
    capturedValues = values;
    return {
      rowCount: 1,
      rows: [
        {
          id: 500,
          recipient_admin_id: 99,
          type: "admin_request",
          title: "Admin Access Request",
          message: "You have received an admin access request.",
          metadata: { admin_request_id: 42 },
          is_read: true,
          created_at: "2026-03-07T03:00:00.000Z",
        },
      ],
    };
  };

  const req = {
    params: { id: "500" },
    admin: { adminId: 99 },
  };
  const res = createRes();

  await patchNotificationReadHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(capturedValues, [500, 99]);
  assert.equal(res.body.notification.is_read, true);
  assert.equal(res.body.notification.recipient_admin_id, 99);
  assert.equal(res.get("cache-control"), "no-store, private, max-age=0");
  assert.equal(res.get("pragma"), "no-cache");
  assert.equal(res.get("vary"), "Authorization");
});

test("PATCH /admin/notifications/:id/read returns 404 for non-recipient admin", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 0,
    rows: [],
  });

  const req = {
    params: { id: "500" },
    admin: { adminId: 11 },
  };
  const res = createRes();

  await patchNotificationReadHandler(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Notification not found" });
});
