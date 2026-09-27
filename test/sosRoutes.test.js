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
  await handler("/sos", "post")({ auth: { uid: "uid-10" }, body: { category: "medical", latitude: 1.2, longitude: 2.3 } }, res);
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
