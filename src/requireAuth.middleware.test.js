import test from "node:test";
import assert from "node:assert/strict";

import { requireAuth, setVerifyIdTokenForTests } from "./middleware/requireAuth.js";
import { requireAppAuth } from "./middleware/requireAppAuth.js";
import { pool } from "./db.js";

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

test("requireAuth returns 401 for missing bearer token", async () => {
  const req = { headers: {}, method: "GET", ip: "127.0.0.1", url: "/me" };
  const res = createRes();
  let nextCalled = false;

  await requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: "Missing Bearer token" });
});

test("requireAuth returns 401 for malformed/invalid token", async () => {
  setVerifyIdTokenForTests(async () => {
    const err = new Error("bad token");
    err.code = "auth/argument-error";
    throw err;
  });

  const req = {
    headers: { authorization: "Bearer invalid-token" },
    method: "GET",
    ip: "127.0.0.1",
    url: "/me"
  };
  const res = createRes();
  let nextCalled = false;

  await requireAuth(req, res, () => {
    nextCalled = true;
  });

  setVerifyIdTokenForTests(null);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: "Invalid or expired token" });
});

test("requireAuth returns 401 for expired token", async () => {
  setVerifyIdTokenForTests(async () => {
    const err = new Error("expired token");
    err.code = "auth/id-token-expired";
    throw err;
  });

  const req = {
    headers: { authorization: "Bearer expired-token" },
    method: "GET",
    ip: "127.0.0.1",
    url: "/me"
  };
  const res = createRes();
  let nextCalled = false;

  await requireAuth(req, res, () => {
    nextCalled = true;
  });

  setVerifyIdTokenForTests(null);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: "Invalid or expired token" });
});

test("requireAppAuth bootstraps first-time user profile successfully", async (t) => {
  const originalPoolQuery = pool.query;
  let dbUpsertCalled = false;
  pool.query = async (text, values) => {
    if (text.includes("INSERT INTO users (firebase_uid, full_name, email, beacon_code)")) {
      dbUpsertCalled = true;
      assert.equal(values[0], "uid-app-1");
      assert.equal(values[1], "App User");
      assert.equal(values[2], "app@example.com");
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  };

  setVerifyIdTokenForTests(async () => ({
    uid: "uid-app-1",
    email: "app@example.com",
    name: "App User",
  }));

  t.after(() => {
    pool.query = originalPoolQuery;
    setVerifyIdTokenForTests(null);
  });

  const req = {
    headers: { authorization: "Bearer valid-token" },
    method: "GET",
    ip: "127.0.0.1",
    originalUrl: "/me",
    url: "/me",
  };
  const res = createRes();
  let nextCalled = false;

  await requireAppAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(dbUpsertCalled, true);
  assert.equal(req.auth.uid, "uid-app-1");
});
