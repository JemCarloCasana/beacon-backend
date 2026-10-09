import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/sosRoutes.js";
import { mongoose } from "../src/mongo.js";
import { AdminRecord, FriendConnection, ReducedUserProfile as UserProfile, SosRecord } from "../src/models/Reduced.js";

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

test("POST /sos creates a typed case and root event with ObjectId strings", async (t) => {
  const created = [];
  const originalSession = mongoose.startSession;
  const session = { withTransaction: async (callback) => callback(), endSession: async () => {} };
  mongoose.startSession = async () => session;
  t.after(() => { mongoose.startSession = originalSession; });
  const userId = new mongoose.Types.ObjectId();
  stub(t, UserProfile, "findOne", async () => ({ _id: userId, full_name: "Alex" }));
  stub(t, AdminRecord, "find", () => ({ select: () => ({ lean: async () => [] }) }));
  stub(t, FriendConnection, "find", () => ({ lean: async () => [] }));
  stub(t, SosRecord, "findOne", () => ({ lean: async () => null }));
  const res = response();
  stub(t, SosRecord, "create", async (docs, options) => { created.push(docs[0]); assert.equal(options.session, session); return docs; });
  await handler("/sos", "post")({ auth: { uid: "uid-10" }, body: { category: "medical", latitude: 16.0435, longitude: 120.3354 } }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.sos_id, /^[a-f\d]{24}$/i);
  assert.equal(created.length, 2);
  assert.equal(created[0].record_type, "event");
  assert.equal(created[0].user_id.toString(), userId.toString());
  assert.equal(created[0].event_type, "report_created");
  assert.equal(created[1].record_type, "case");
  assert.equal(created[1].root_event_id.toString(), res.body.sos_id);
});

test("PATCH /sos/:sosId/status rejects invalid terminal status before database access", async () => {
  const res = response();
  await handler("/sos/:sosId/status", "patch")({ params: { sosId: "640000000000000000000040" }, body: { status: "active" }, auth: { uid: "uid-10" } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid status" });
});

test("existing SOS can close after leaving Dagupan and retains its real last location", async t => {
  const userId = new mongoose.Types.ObjectId();
  const sosId = new mongoose.Types.ObjectId();
  const thread = { _id: new mongoose.Types.ObjectId(), user_id: userId, root_event_id: sosId, latest_status: "active" };
  const lastLocation = { latitude: 14.5995, longitude: 120.9842 };
  const session = { withTransaction: async callback => callback(), endSession: async () => {} };
  stub(t, mongoose, "startSession", async () => session);
  stub(t, UserProfile, "findOne", async () => ({ _id: userId }));
  let caseReads = 0;
  stub(t, SosRecord, "findOne", filter => {
    const value = filter.record_type === "case" ? (++caseReads === 1 ? thread : null) : lastLocation;
    const query = { lean: async () => value, sort: () => query, session: () => query };
    return query;
  });
  stub(t, SosRecord, "updateOne", async (_filter, update) => {
    assert.equal(update.$set.latest_status, "resolved");
    return { modifiedCount: 1 };
  });
  let created;
  stub(t, SosRecord, "create", async docs => { [created] = docs; return docs; });
  const res = response();
  await handler("/sos/:sosId/status", "patch")({ params: { sosId: sosId.toString() }, body: { status: "safe", source: "android", ...lastLocation }, auth: { uid: "existing-user" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(created.latitude, lastLocation.latitude);
  assert.equal(created.longitude, lastLocation.longitude);
  assert.equal(created.status, "safe");
});
