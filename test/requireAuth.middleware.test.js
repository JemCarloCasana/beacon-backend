import test from "node:test";
import assert from "node:assert/strict";
import { requireAuth, setVerifyIdTokenForTests } from "../src/middleware/requireAuth.js";
import { requireAppAuth } from "../src/middleware/requireAppAuth.js";
import mongoose from "mongoose";
import { ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function stub(t, model, method, replacement) {
  const original = model[method];
  model[method] = replacement;
  t.after(() => { model[method] = original; });
}

async function runAppAuth(t, decoded, existing, onCreate = () => {}) {
  stub(t, UserProfile, "findOne", async () => existing);
  stub(t, UserProfile, "create", async (values) => {
    onCreate(values);
    return { _id: new mongoose.Types.ObjectId(), ...values };
  });
  setVerifyIdTokenForTests(async () => decoded);
  t.after(() => setVerifyIdTokenForTests(null));

  const req = { headers: { authorization: "Bearer valid-token" }, method: "GET", ip: "127.0.0.1", originalUrl: "/me", url: "/me" };
  const res = response();
  let nextCalled = false;
  await requireAppAuth(req, res, () => { nextCalled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.auth.uid, decoded.uid);
  return req;
}

test("requireAuth returns 401 for missing bearer token", async () => {
  const res = response();
  let nextCalled = false;
  await requireAuth({ headers: {}, method: "GET", ip: "127.0.0.1", url: "/me" }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { message: "Missing Bearer token" });
});

test("requireAuth returns 401 for malformed and expired tokens", async () => {
  for (const code of ["auth/argument-error", "auth/id-token-expired"]) {
    setVerifyIdTokenForTests(async () => { const error = new Error("invalid token"); error.code = code; throw error; });
    const res = response();
    let nextCalled = false;
    await requireAuth({ headers: { authorization: "Bearer invalid-token" }, method: "GET", ip: "127.0.0.1", url: "/me" }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { message: "Invalid or expired token" });
  }
  setVerifyIdTokenForTests(null);
});

test("requireAppAuth requires explicit profile setup instead of creating a profile from token claims", async (t) => {
  let creations = 0;
  stub(t, UserProfile, "findOne", async () => null);
  stub(t, UserProfile, "create", async () => { creations++; throw new Error("Implicit creation is forbidden"); });
  setVerifyIdTokenForTests(async () => ({ uid: "uid-app-1", email: "app@example.com", name: "App User" }));
  t.after(() => setVerifyIdTokenForTests(null));
  const res = response();
  let nextCalled = false;
  await requireAppAuth({ headers: { authorization: "Bearer valid-token" } }, res, () => { nextCalled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "PROFILE_SETUP_REQUIRED");
  assert.equal(nextCalled, false);
  assert.equal(creations, 0);
});

test("requireAppAuth preserves an existing real name when the token name is a placeholder", async (t) => {
  const existing = { full_name: "Real Person", beacon_code: "BCN-ABC123", save: async () => {} };
  await runAppAuth(t, { uid: "uid-app-3", email: "person@example.com", name: "User 54321" }, existing);
  assert.equal(existing.full_name, "Real Person");
});

test("requireAppAuth upgrades an existing placeholder name from the valid token name", async (t) => {
  const existing = { full_name: "User 99887", beacon_code: "BCN-ABC123", save: async () => {} };
  await runAppAuth(t, { uid: "uid-app-4", email: "person@example.com", name: "Valid Person" }, existing);
  assert.equal(existing.full_name, "Valid Person");
});

test("requireAppAuth upgrades an existing placeholder name from the email fallback", async (t) => {
  const existing = { full_name: "User 22222", beacon_code: "BCN-ABC123", save: async () => {} };
  await runAppAuth(t, { uid: "uid-app-5", email: "sam_smith@example.com", name: "User 11111" }, existing);
  assert.equal(existing.full_name, "sam smith");
});
