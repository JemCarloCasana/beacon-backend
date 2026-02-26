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

const adminAdminsPatchStack = findRouteLayer("/admin/admins/:id", "patch");
const patchAdminAdminPermissionMiddleware = adminAdminsPatchStack[1].handle;
const patchAdminAdminHandler = adminAdminsPatchStack[adminAdminsPatchStack.length - 1].handle;

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
