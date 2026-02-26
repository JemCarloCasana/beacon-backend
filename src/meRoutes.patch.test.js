import test from "node:test";
import assert from "node:assert/strict";

import router from "./routes/meRoutes.js";
import { pool } from "./db.js";
import { requireAuth } from "./middleware/requireAuth.js";

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
    }
  };
}

const patchMeHandler = findRouteHandler("/me", "patch");

test("PATCH /me success update one field", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        id: 10,
        firebase_uid: "uid-1",
        email: "user@example.com",
        full_name: "Updated Name",
        phone_number: "+12345678901",
        role: "student",
        profile_image_url: null
      }
    ]
  });

  const req = {
    auth: { uid: "uid-1" },
    body: { full_name: "Updated Name" }
  };
  const res = createRes();

  await patchMeHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    id: 10,
    firebase_uid: "uid-1",
    email: "user@example.com",
    full_name: "Updated Name",
    phone_number: "+12345678901",
    role: "student",
    profile_image_url: null
  });
});

test("PATCH /me success update all fields", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rowCount: 1,
    rows: [
      {
        id: 11,
        firebase_uid: "uid-2",
        email: "allfields@example.com",
        full_name: "All Fields",
        phone_number: "+19995554444",
        role: "student",
        profile_image_url: "https://cdn.example.com/p.jpg"
      }
    ]
  });

  const req = {
    auth: { uid: "uid-2" },
    body: {
      full_name: "All Fields",
      email: "allfields@example.com",
      phone_number: "+19995554444",
      profile_image_url: "https://cdn.example.com/p.jpg"
    }
  };
  const res = createRes();

  await patchMeHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    id: 11,
    firebase_uid: "uid-2",
    email: "allfields@example.com",
    full_name: "All Fields",
    phone_number: "+19995554444",
    role: "student",
    profile_image_url: "https://cdn.example.com/p.jpg"
  });
});

test("requireAuth returns 401 without token", async () => {
  const req = { headers: {} };
  const res = createRes();
  let nextCalled = false;

  await requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: "Missing Bearer token" });
});

test("PATCH /me returns 400 for invalid email / invalid phone / invalid URL", async () => {
  const invalidCases = [
    { email: "invalid-email" },
    { phone_number: "abc123" },
    { profile_image_url: "not-a-url" }
  ];

  for (const body of invalidCases) {
    const req = {
      auth: { uid: "uid-3" },
      body
    };
    const res = createRes();

    await patchMeHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(typeof res.body?.message, "string");
    assert.match(res.body.message, /^Invalid /);
  }
});
