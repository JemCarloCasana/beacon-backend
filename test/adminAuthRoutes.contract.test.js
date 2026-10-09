import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

if (!process.env.ADMIN_JWT_SECRET) {
  process.env.ADMIN_JWT_SECRET = "test-admin-secret";
}

const { default: adminAuthRouter } = await import("../src/routes/adminAuthRoutes.js");
const { default: adminMeRouter } = await import("../src/routes/adminMeRoutes.js");
const { AdminRecord } = await import("../src/models/Reduced.js");

function queryResult(value) {
  return { select() { return this; }, lean: async () => value };
}

function findRouteStack(router, path, method) {
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

const loginHandler = findRouteStack(adminAuthRouter, "/admin/auth/login", "post")[0].handle;
const adminMeStack = findRouteStack(adminMeRouter, "/admin/me", "get");
const adminMeAuthMiddleware = adminMeStack[0].handle;
const adminMeHandler = adminMeStack[adminMeStack.length - 1].handle;

test("login rejects missing fields", async () => {
  const req = { body: {} };
  const res = createRes();

  await loginHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.message, "Validation failed");
  assert.equal(typeof res.body.errors.email, "string");
  assert.equal(typeof res.body.errors.password, "string");
});

test("login rejects bad credentials", async (t) => {
  const originalFindOne = AdminRecord.findOne;
  t.after(() => {
    AdminRecord.findOne = originalFindOne;
  });

  AdminRecord.findOne = () => queryResult(null);

  const req = {
    body: {
      email: "missing@example.com",
      password: "Abcdef123!"
    }
  };
  const res = createRes();

  await loginHandler(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: "Invalid credentials" });
});

test("login accepts valid credentials and returns token", async (t) => {
  const originalFindOne = AdminRecord.findOne;
  t.after(() => {
    AdminRecord.findOne = originalFindOne;
  });

  const passwordHash = await bcrypt.hash("Abcdef123!", 12);
  const adminId = new mongoose.Types.ObjectId();
  AdminRecord.findOne = () => queryResult({ _id: adminId, record_type: "account", email: "valid@example.com", full_name: "Valid Admin", password_hash: passwordHash, token_version: 0, status: "active", role: "personnel", permissions: ["manage_users"] });

  const req = {
    body: {
      email: "VALID@example.com",
      password: "Abcdef123!"
    }
  };
  const res = createRes();

  await loginHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body.token, "string");
  assert.equal(res.body.admin.id, adminId.toString());
  assert.deepEqual(res.body.admin.permissions, ["manage_users"]);
});

test("login rejects deactivated account with 403", async (t) => {
  const originalFindOne = AdminRecord.findOne;
  t.after(() => {
    AdminRecord.findOne = originalFindOne;
  });

  const passwordHash = await bcrypt.hash("Abcdef123!", 12);
  AdminRecord.findOne = () => queryResult({ _id: new mongoose.Types.ObjectId(), record_type: "account", email: "deactivated@example.com", full_name: "Deactivated User", password_hash: passwordHash, status: "deactivated", role: "personnel" });

  const req = {
    body: {
      email: "deactivated@example.com",
      password: "Abcdef123!"
    }
  };
  const res = createRes();

  await loginHandler(req, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { message: "Account is deactivated" });
});

test("/admin/me returns 401 without token", async () => {
  const req = { headers: {} };
  const res = createRes();
  let nextCalled = false;

  await adminMeAuthMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("/admin/me returns 401 with invalid token", async () => {
  const req = {
    headers: { authorization: "Bearer invalid.token.value" }
  };
  const res = createRes();
  let nextCalled = false;

  await adminMeAuthMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("/admin/me returns role and permissions for valid token", async (t) => {
  const originalFindOne = AdminRecord.findOne;
  t.after(() => {
    AdminRecord.findOne = originalFindOne;
  });

  const adminId = new mongoose.Types.ObjectId();
  const token = jwt.sign(
    { sub: adminId.toString(), role: "personnel", token_version: 0 },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "1h" }
  );

  AdminRecord.findOne = () => queryResult({ _id: adminId, record_type: "account", status: "active", email: "p@example.com", full_name: "P User", role: "personnel", permissions: ["manage_reports"] });

  const req = {
    headers: {
      authorization: `Bearer ${token}`
    }
  };
  const res = createRes();

  await adminMeAuthMiddleware(req, res, () => {});
  await adminMeHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.role, "personnel");
  assert.deepEqual(res.body.permissions, ["manage_reports"]);
});

test("/admin/me middleware returns 403 for deactivated account", async (t) => {
  const originalFindOne = AdminRecord.findOne;
  t.after(() => {
    AdminRecord.findOne = originalFindOne;
  });

  const adminId = new mongoose.Types.ObjectId();
  const token = jwt.sign(
    { sub: adminId.toString(), role: "personnel", token_version: 0 },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "1h" }
  );

  AdminRecord.findOne = () => queryResult({ _id: adminId, record_type: "account", status: "deactivated" });

  const req = {
    headers: {
      authorization: `Bearer ${token}`
    }
  };
  const res = createRes();
  let nextCalled = false;

  await adminMeAuthMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { message: "Account is deactivated" });
});
