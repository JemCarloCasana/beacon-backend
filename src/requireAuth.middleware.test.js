import test from "node:test";
import assert from "node:assert/strict";

import { requireAuth, setVerifyIdTokenForTests } from "./middleware/requireAuth.js";

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
