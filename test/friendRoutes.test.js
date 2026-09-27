import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/friendRoutes.js";
import { mongoose } from "../src/mongo.js";
import { Counter } from "../src/models/Counter.js";
import { FriendRequest, Friendship, UserProfile } from "../src/models/Remaining.js";

function handler(path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} exists`);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function stub(t, model, method, replacement) {
  const original = model[method];
  model[method] = replacement;
  t.after(() => { model[method] = original; });
}

test("POST /friends/request creates a Mongo pending request using normalized beacon code", async (t) => {
  stub(t, UserProfile, "findOne", (filter) => {
    if (filter.firebase_uid) return Promise.resolve({ public_id: 10 });
    assert.deepEqual(filter, { beacon_code: "ABC123" });
    return { select: () => ({ lean: async () => ({ public_id: 20 }) }) };
  });
  stub(t, Friendship, "findOne", () => ({ lean: async () => null }));
  stub(t, FriendRequest, "findOne", () => ({ sort: () => ({ lean: async () => null }) }));
  stub(t, Counter, "nextPublicId", async () => 71);
  stub(t, FriendRequest, "create", async (doc) => ({ ...doc, created_at: "2026-03-20T01:00:00.000Z" }));
  const res = response();
  await handler("/friends/request", "post")({ auth: { uid: "firebase-uid-1" }, body: { beacon_code: " abc123 " } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { id: 71, requester_user_id: 10, addressee_user_id: 20, status: "pending", created_at: "2026-03-20T01:00:00.000Z" });
});

test("GET /friends/requests/incoming returns pending requests with Mongo profile details", async (t) => {
  stub(t, UserProfile, "findOne", async () => ({ public_id: 10 }));
  stub(t, FriendRequest, "find", (filter) => {
    assert.deepEqual(filter, { addressee_user_id: 10, status: "pending" });
    return { sort: () => ({ lean: async () => [{ public_id: 71, requester_user_id: 20, addressee_user_id: 10, status: "pending", created_at: "now" }] }) };
  });
  stub(t, UserProfile, "find", (filter) => {
    assert.deepEqual(filter, { public_id: { $in: [20] } });
    return { select: () => ({ lean: async () => [{ public_id: 20, full_name: "Alex User", beacon_code: "ABC123" }] }) };
  });
  const res = response();
  await handler("/friends/requests/incoming", "get")({ auth: { uid: "uid-10" } }, res);
  assert.deepEqual(res.body, [{ id: 71, requester_user_id: 20, addressee_user_id: 10, requester_name: "Alex User", requester_beacon_code: "ABC123", status: "pending", created_at: "now" }]);
});

test("accepting a Mongo friend request creates the canonical friendship and updates request atomically", async (t) => {
  const originalSession = mongoose.startSession;
  t.after(() => { mongoose.startSession = originalSession; });
  let inTransaction = false;
  const session = { withTransaction: async (callback) => { inTransaction = true; return callback(); }, endSession: async () => {} };
  mongoose.startSession = async () => session;
  stub(t, UserProfile, "findOne", async () => ({ public_id: 10 }));
  stub(t, FriendRequest, "findOne", (filter) => ({
    sort() { return this; },
    session() { return this; },
    lean: async () => filter.public_id ? { _id: "r1", public_id: 71, requester_user_id: 20, addressee_user_id: 10, status: "pending" } : { public_id: 71, requester_user_id: 20, addressee_user_id: 10, status: "pending" },
  }));
  stub(t, Friendship, "findOne", () => ({ session: () => ({ lean: async () => null }), lean: async () => null }));
  stub(t, Friendship, "create", async (docs, options) => { assert.equal(inTransaction, true); assert.deepEqual({ user_id: docs[0].user_id, friend_user_id: docs[0].friend_user_id }, { user_id: 10, friend_user_id: 20 }); assert.equal(options.session, session); });
  stub(t, FriendRequest, "updateOne", async (filter, update, options) => { assert.equal(inTransaction, true); assert.deepEqual(filter, { _id: "r1", status: "pending" }); assert.equal(update.$set.status, "accepted"); assert.equal(options.session, session); return { modifiedCount: 1 }; });
  const res = response();
  await handler("/friends/requests/:id/accept", "post")({ auth: { uid: "uid-10" }, params: { id: "71" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("GET /friends resolves canonical friendship rows to sorted Mongo profiles", async (t) => {
  stub(t, UserProfile, "findOne", async () => ({ public_id: 10 }));
  stub(t, Friendship, "find", () => ({ lean: async () => [{ user_id: 20, friend_user_id: 10 }, { user_id: 10, friend_user_id: 30 }] }));
  stub(t, UserProfile, "find", (filter) => {
    assert.deepEqual(filter, { public_id: { $in: [20, 30] } });
    return { lean: async () => [{ public_id: 30, full_name: "Zed", email: "z@example.com" }, { public_id: 20, full_name: "Amy", email: "a@example.com" }] };
  });
  const res = response();
  await handler("/friends", "get")({ auth: { uid: "uid-10" } }, res);
  assert.deepEqual(res.body.map(({ id, full_name }) => ({ id, full_name })), [{ id: 20, full_name: "Amy" }, { id: 30, full_name: "Zed" }]);
});
