import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

if (!process.env.ADMIN_JWT_SECRET) {
  process.env.ADMIN_JWT_SECRET = "test-admin-secret";
}

const { default: adminAuthRouter } = await import("../src/routes/adminAuthRoutes.js");
const { default: adminMeRouter } = await import("../src/routes/adminMeRoutes.js");
const { AdminAccount, Role } = await import("../src/models/Remaining.js");

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

const signupHandler = findRouteStack(adminAuthRouter, "/admin/auth/signup", "post")[0].handle;
const loginHandler = findRouteStack(adminAuthRouter, "/admin/auth/login", "post")[0].handle;
const adminMeStack = findRouteStack(adminMeRouter, "/admin/me", "get");
const adminMeAuthMiddleware = adminMeStack[0].handle;
const adminMeHandler = adminMeStack[adminMeStack.length - 1].handle;

test("signup rejects invalid email", async () => {
  const req = {
    body: {
      full_name: "Valid Person",
      email: "invalid-email",
      password: "Abcdef123!",
      role: "personnel"
    }
  };
  const res = createRes();

  await signupHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.message, "Validation failed");
  assert.equal(typeof res.body.errors.email, "string");
});

test("signup rejects invalid full_name characters", async () => {
  const req = {
    body: {
      full_name: "Jane_Doe",
      email: "jane@example.com",
      password: "Abcdef123!",
      role: "personnel"
    }
  };
  const res = createRes();

  await signupHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.message, "Validation failed");
  assert.equal(typeof res.body.errors.full_name, "string");
});

test("signup rejects password shorter than 10 chars", async () => {
  const req = {
    body: {
      full_name: "Valid Name",
      email: "valid@example.com",
      password: "Abc12!",
      role: "personnel"
    }
  };
  const res = createRes();

  await signupHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.message, "Validation failed");
  assert.equal(res.body.errors.password, "Password must be at least 10 characters");
});

test("signup rejects password with fewer than 3 classes", async () => {
  const req = {
    body: {
      full_name: "Valid Name",
      email: "valid@example.com",
      password: "abcdefghij",
      role: "personnel"
    }
  };
  const res = createRes();

  await signupHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.message, "Validation failed");
  assert.equal(typeof res.body.errors.password, "string");
});

test("signup rejects duplicate email with 409", async (t) => {
  const originalRoleFindOne = Role.findOne;
  const originalAdminFindOne = AdminAccount.findOne;
  t.after(() => {
    Role.findOne = originalRoleFindOne;
    AdminAccount.findOne = originalAdminFindOne;
  });

  Role.findOne = () => queryResult({ public_id: 2 });
  AdminAccount.findOne = () => queryResult({ public_id: 9 });

  const req = {
    body: {
      full_name: "Valid Name",
      email: "existing@example.com",
      password: "Abcdef123!",
      role: "personnel"
    }
  };
  const res = createRes();

  await signupHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { message: "Email already registered" });
});

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
  const originalFindOne = AdminAccount.findOne;
  t.after(() => {
    AdminAccount.findOne = originalFindOne;
  });

  AdminAccount.findOne = () => queryResult(null);

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
  const originalFindOne = AdminAccount.findOne;
  t.after(() => {
    AdminAccount.findOne = originalFindOne;
  });

  const passwordHash = await bcrypt.hash("Abcdef123!", 12);
  AdminAccount.findOne = () => queryResult({ public_id: 17, email: "valid@example.com", full_name: "Valid Admin", password_hash: passwordHash, role_id: 1, status: "active", role: "personnel", permission_names: ["manage_users"] });

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
  assert.equal(res.body.admin.id, 17);
  assert.deepEqual(res.body.admin.permissions, ["manage_users"]);
});

test("login rejects deactivated account with 403", async (t) => {
  const originalFindOne = AdminAccount.findOne;
  t.after(() => {
    AdminAccount.findOne = originalFindOne;
  });

  const passwordHash = await bcrypt.hash("Abcdef123!", 12);
  AdminAccount.findOne = () => queryResult({ public_id: 18, email: "deactivated@example.com", full_name: "Deactivated User", password_hash: passwordHash, role_id: 2, status: "deactivated", role: "personnel" });

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
  const originalFindOne = AdminAccount.findOne;
  t.after(() => {
    AdminAccount.findOne = originalFindOne;
  });

  const token = jwt.sign(
    { sub: "5", role: "personnel", roleId: 2 },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "1h" }
  );

  AdminAccount.findOne = () => queryResult({ public_id: 5, status: "active", email: "p@example.com", full_name: "P User", role_id: 2, role: "personnel", permission_names: ["manage_reports"] });

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
  const originalFindOne = AdminAccount.findOne;
  t.after(() => {
    AdminAccount.findOne = originalFindOne;
  });

  const token = jwt.sign(
    { sub: "6", role: "personnel", roleId: 2 },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "1h" }
  );

  AdminAccount.findOne = () => queryResult({ public_id: 6, status: "deactivated" });

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
