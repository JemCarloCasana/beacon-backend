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

function createAppAuthReq() {
  return {
    headers: { authorization: "Bearer valid-token" },
    method: "GET",
    ip: "127.0.0.1",
    originalUrl: "/me",
    url: "/me",
  };
}

async function runRequireAppAuthWithDbStub(t, {
  decoded,
  onQuery,
}) {
  const originalPoolQuery = pool.query;
  pool.query = onQuery;
  setVerifyIdTokenForTests(async () => decoded);

  t.after(() => {
    pool.query = originalPoolQuery;
    setVerifyIdTokenForTests(null);
  });

  const req = createAppAuthReq();
  const res = createRes();
  let nextCalled = false;
  let nextResolved;
  const nextPromise = new Promise((resolve) => {
    nextResolved = resolve;
  });

  await requireAppAuth(req, res, () => {
    nextCalled = true;
    nextResolved();
  });

  await nextPromise;

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.auth.uid, decoded.uid);
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
  let dbUpsertCalled = false;

  await runRequireAppAuthWithDbStub(t, {
    decoded: {
      uid: "uid-app-1",
      email: "app@example.com",
      name: "App User",
    },
    onQuery: async (text, values) => {
      if (text.includes("SELECT full_name FROM users WHERE firebase_uid = $1")) {
        assert.deepEqual(values, ["uid-app-1"]);
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("INSERT INTO users (firebase_uid, full_name, email, beacon_code)")) {
        dbUpsertCalled = true;
        assert.equal(values[0], "uid-app-1");
        assert.equal(values[1], "App User");
        assert.equal(values[2], "app@example.com");
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${text}`);
    }
  });

  assert.equal(dbUpsertCalled, true);
});

test("requireAppAuth falls back to email-derived name when token name is placeholder", async (t) => {
  await runRequireAppAuthWithDbStub(t, {
    decoded: {
      uid: "uid-app-2",
      email: "jane.doe@example.com",
      name: "User 12345",
    },
    onQuery: async (text, values) => {
      if (text.includes("SELECT full_name FROM users WHERE firebase_uid = $1")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("INSERT INTO users (firebase_uid, full_name, email, beacon_code)")) {
        assert.equal(values[1], "jane doe");
        assert.equal(values[2], "jane.doe@example.com");
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${text}`);
    }
  });
});

test("requireAppAuth preserves existing real name when token name is placeholder", async (t) => {
  await runRequireAppAuthWithDbStub(t, {
    decoded: {
      uid: "uid-app-3",
      email: "person@example.com",
      name: "User 54321",
    },
    onQuery: async (text, values) => {
      if (text.includes("SELECT full_name FROM users WHERE firebase_uid = $1")) {
        return { rowCount: 1, rows: [{ full_name: "Real Person" }] };
      }
      if (text.includes("INSERT INTO users (firebase_uid, full_name, email, beacon_code)")) {
        assert.equal(values[1], "Real Person");
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${text}`);
    }
  });
});

test("requireAppAuth upgrades placeholder DB name when token name is valid", async (t) => {
  await runRequireAppAuthWithDbStub(t, {
    decoded: {
      uid: "uid-app-4",
      email: "person@example.com",
      name: "Valid Person",
    },
    onQuery: async (text, values) => {
      if (text.includes("SELECT full_name FROM users WHERE firebase_uid = $1")) {
        return { rowCount: 1, rows: [{ full_name: "User 99887" }] };
      }
      if (text.includes("INSERT INTO users (firebase_uid, full_name, email, beacon_code)")) {
        assert.equal(values[1], "Valid Person");
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${text}`);
    }
  });
});

test("requireAppAuth upgrades placeholder DB name from email fallback when token name is invalid", async (t) => {
  await runRequireAppAuthWithDbStub(t, {
    decoded: {
      uid: "uid-app-5",
      email: "sam_smith@example.com",
      name: "User 11111",
    },
    onQuery: async (text, values) => {
      if (text.includes("SELECT full_name FROM users WHERE firebase_uid = $1")) {
        return { rowCount: 1, rows: [{ full_name: "User 22222" }] };
      }
      if (text.includes("INSERT INTO users (firebase_uid, full_name, email, beacon_code)")) {
        assert.equal(values[1], "sam smith");
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${text}`);
    }
  });
});
