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

const adminUsersPatchStack = findRouteLayer("/admin/users/:id", "patch");
const patchAdminUserAuthMiddleware = adminUsersPatchStack[0].handle;
const patchAdminUserPermissionMiddleware = adminUsersPatchStack[1].handle;
const patchAdminUserHandler = adminUsersPatchStack[adminUsersPatchStack.length - 1].handle;

test("PATCH /admin/users/:id returns 200 for full_name update", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        id: 5,
        firebase_uid: "uid-5",
        email: "user5@example.com",
        full_name: "Updated Name",
        phone_number: "+10000000001",
        role: "student",
        profile_image_url: null
      }
    ]
  });

  const req = {
    params: { id: "5" },
    body: { full_name: "Updated Name" }
  };
  const res = createRes();

  await patchAdminUserHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    id: 5,
    firebase_uid: "uid-5",
    email: "user5@example.com",
    full_name: "Updated Name",
    phone_number: "+10000000001",
    role: "student",
    profile_image_url: null
  });
});

test("PATCH /admin/users/:id lowercases email and returns 200", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (_sql, values) => {
    assert.equal(values[0], "mixed@example.com");
    return {
      rowCount: 1,
      rows: [
        {
          id: 6,
          firebase_uid: "uid-6",
          email: "mixed@example.com",
          full_name: "Name Six",
          phone_number: null,
          role: "student",
          profile_image_url: null
        }
      ]
    };
  };

  const req = {
    params: { id: "6" },
    body: { email: "  MIXED@Example.COM " }
  };
  const res = createRes();

  await patchAdminUserHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.email, "mixed@example.com");
});

test("PATCH /admin/users/:id returns 200 for updating both fields", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        id: 7,
        firebase_uid: "uid-7",
        email: "both@example.com",
        full_name: "Both Fields",
        phone_number: null,
        role: "student",
        profile_image_url: null
      }
    ]
  });

  const req = {
    params: { id: "7" },
    body: { full_name: "Both Fields", email: "both@example.com" }
  };
  const res = createRes();

  await patchAdminUserHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.full_name, "Both Fields");
  assert.equal(res.body.email, "both@example.com");
});

test("PATCH /admin/users/:id returns 422 for invalid id", async () => {
  const req = {
    params: { id: "0" },
    body: { full_name: "Valid Name" }
  };
  const res = createRes();

  await patchAdminUserHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    message: "Validation failed",
    errors: { id: ["Must be a positive integer"] }
  });
});

test("PATCH /admin/users/:id returns 422 for empty body", async () => {
  const req = {
    params: { id: "8" },
    body: {}
  };
  const res = createRes();

  await patchAdminUserHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    message: "Validation failed",
    errors: { body: ["At least one of full_name or email is required"] }
  });
});

test("PATCH /admin/users/:id returns 422 for unknown fields", async () => {
  const req = {
    params: { id: "8" },
    body: { username: "x", full_name: "Valid Name" }
  };
  const res = createRes();

  await patchAdminUserHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    message: "Validation failed",
    errors: { username: ["Field is not allowed"] }
  });
});

test("PATCH /admin/users/:id returns 422 for invalid email", async () => {
  const req = {
    params: { id: "8" },
    body: { email: "invalid-email" }
  };
  const res = createRes();

  await patchAdminUserHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    message: "Validation failed",
    errors: { email: ["Invalid email format"] }
  });
});

test("PATCH /admin/users/:id returns 422 for invalid full_name", async () => {
  const req = {
    params: { id: "8" },
    body: { full_name: "A" }
  };
  const res = createRes();

  await patchAdminUserHandler(req, res);

  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.body, {
    message: "Validation failed",
    errors: { full_name: ["Must be between 2 and 50 characters"] }
  });
});

test("PATCH /admin/users/:id returns 404 when user is missing", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 0,
    rows: []
  });

  const req = {
    params: { id: "9999" },
    body: { full_name: "No User" }
  };
  const res = createRes();

  await patchAdminUserHandler(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "User not found" });
});

test("PATCH /admin/users/:id returns 409 on unique email conflict", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => {
    const err = new Error("duplicate key");
    err.code = "23505";
    throw err;
  };

  const req = {
    params: { id: "9" },
    body: { email: "existing@example.com" }
  };
  const res = createRes();

  await patchAdminUserHandler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { message: "Email already exists" });
});

test("PATCH /admin/users/:id middleware returns 401 when token is missing", async () => {
  const req = { headers: {} };
  const res = createRes();
  let nextCalled = false;

  await patchAdminUserAuthMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: "Missing Bearer token" });
});

test("PATCH /admin/users/:id middleware returns 403 without manage_users", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [{ permissions: ["manage_admins"] }]
  });

  const req = {
    admin: { adminId: 123 }
  };
  const res = createRes();
  let nextCalled = false;

  await patchAdminUserPermissionMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { message: "Insufficient permissions" });
});
