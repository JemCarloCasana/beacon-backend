import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/friendRoutes.js";
import { mongoose } from "../src/mongo.js";
import { FriendConnection, ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";

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

test("POST /friends/request creates an ObjectId request from a normalized beacon code", async (t) => {
  const requester = new mongoose.Types.ObjectId();
  const recipient = new mongoose.Types.ObjectId();
  const requestId = new mongoose.Types.ObjectId();
  stub(t, UserProfile, "findOne", (filter) => {
    if (filter.firebase_uid) return Promise.resolve({ _id: requester });
    assert.deepEqual(filter, { beacon_code: "ABC123" });
    return { select: () => ({ lean: async () => ({ _id: recipient }) }) };
  });
  stub(t, FriendConnection, "findOne", () => ({ lean: async () => null, sort() { return this; } }));
  stub(t, FriendConnection, "create", async (doc) => ({ ...doc, _id: requestId, created_at: "2026-03-20T01:00:00.000Z" }));
  const res = response();
  await handler("/friends/request", "post")({ auth: { uid: "firebase-uid-1" }, body: { beacon_code: " abc123 " } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { id: requestId.toString(), requester_user_id: requester.toString(), addressee_user_id: recipient.toString(), status: "pending", created_at: "2026-03-20T01:00:00.000Z" });
});

test("GET /friends/requests/incoming returns pending requests with profile details", async (t) => {
  const me = new mongoose.Types.ObjectId();
  const requester = new mongoose.Types.ObjectId();
  const requestId = new mongoose.Types.ObjectId();
  stub(t, UserProfile, "findOne", async () => ({ _id: me }));
  stub(t, FriendConnection, "find", (filter) => {
    assert.equal(filter.record_type, "request");
    assert.equal(filter.recipient.toString(), me.toString());
    return { sort: () => ({ lean: async () => [{ _id: requestId, requested_by: requester, recipient: me, status: "pending", created_at: "now" }] }) };
  });
  stub(t, UserProfile, "find", (filter) => {
    assert.equal(filter._id.$in[0].toString(), requester.toString());
    return { select: () => ({ lean: async () => [{ _id: requester, full_name: "Alex User", beacon_code: "ABC123" }] }) };
  });
  const res = response();
  await handler("/friends/requests/incoming", "get")({ auth: { uid: "uid-10" } }, res);
  assert.deepEqual(res.body, [{ id: requestId.toString(), requester_user_id: requester.toString(), addressee_user_id: me.toString(), requester_name: "Alex User", requester_beacon_code: "ABC123", status: "pending", created_at: "now" }]);
});

test("accepting a friend request creates a typed friendship and updates the request atomically", async (t) => {
  const originalSession = mongoose.startSession;
  t.after(() => { mongoose.startSession = originalSession; });
  let inTransaction = false;
  const session = { withTransaction: async (callback) => { inTransaction = true; return callback(); }, endSession: async () => {} };
  mongoose.startSession = async () => session;
  const me = new mongoose.Types.ObjectId();
  const requester = new mongoose.Types.ObjectId();
  const requestId = new mongoose.Types.ObjectId();
  const request = { _id: requestId, requested_by: requester, recipient: me, user_ids: [requester, me], status: "pending" };
  stub(t, UserProfile, "findOne", async () => ({ _id: me }));
  stub(t, FriendConnection, "findOne", (filter) => ({
    sort() { return this; },
    session() { return this; },
    lean: async () => filter.record_type === "friendship" ? null : request,
  }));
  stub(t, FriendConnection, "updateOne", async (filter, update, options) => {
    assert.equal(inTransaction, true);
    assert.equal(filter._id.toString(), requestId.toString());
    assert.equal(update.$set.status, "accepted");
    assert.equal(options.session, session);
    return { modifiedCount: 1 };
  });
  stub(t, FriendConnection, "create", async (docs, options) => {
    assert.equal(inTransaction, true);
    assert.equal(docs[0].record_type, "friendship");
    assert.deepEqual(docs[0].user_ids.map(String).sort(), [me.toString(), requester.toString()].sort());
    assert.equal(options.session, session);
  });
  const res = response();
  await handler("/friends/requests/:id/accept", "post")({ auth: { uid: "uid-10" }, params: { id: requestId.toString() } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("GET /friends resolves friendship records to sorted profiles", async (t) => {
  const me = new mongoose.Types.ObjectId();
  const amy = new mongoose.Types.ObjectId();
  const zed = new mongoose.Types.ObjectId();
  stub(t, UserProfile, "findOne", async () => ({ _id: me }));
  stub(t, FriendConnection, "find", () => ({ lean: async () => [{ user_ids: [amy, me] }, { user_ids: [me, zed] }] }));
  stub(t, UserProfile, "find", (filter) => {
    assert.deepEqual(filter._id.$in.map(String).sort(), [amy.toString(), zed.toString()].sort());
    return { lean: async () => [{ _id: zed, full_name: "Zed", email: "z@example.com" }, { _id: amy, full_name: "Amy", email: "a@example.com" }] };
  });
  const res = response();
  await handler("/friends", "get")({ auth: { uid: "uid-10" } }, res);
  assert.deepEqual(res.body.map(({ id, full_name }) => ({ id, full_name })), [{ id: amy.toString(), full_name: "Amy" }, { id: zed.toString(), full_name: "Zed" }]);
});
