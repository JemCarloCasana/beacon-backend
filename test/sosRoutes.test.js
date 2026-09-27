import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/sosRoutes.js";
import { mongoose } from "../src/mongo.js";
import { Counter } from "../src/models/Counter.js";
import { UserProfile, Friendship, AdminAccount, SosEvent, SosThread } from "../src/models/Remaining.js";

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

test("POST /sos creates a Mongo thread and root event using numeric public IDs", async (t) => {
  let id = 40;
  let transactionPayload;
  const originalSession = mongoose.startSession;
  const session = { withTransaction: async (callback) => callback(), endSession: async () => {} };
  mongoose.startSession = async () => session;
  t.after(() => { mongoose.startSession = originalSession; });
  stub(t, UserProfile, "findOne", async () => ({ public_id: 10, full_name: "Alex" }));
  stub(t, Counter, "nextPublicId", async (key) => { assert.ok(["sos_events", "sos_threads"].includes(key)); return id++; });
  stub(t, AdminAccount, "find", () => ({ select: () => ({ lean: async () => [] }) }));
  stub(t, Friendship, "find", () => ({ lean: async () => [] }));
  stub(t, SosThread, "findOne", () => ({ lean: async () => null }));
  const res = response();
  stub(t, SosEvent, "create", async (docs, options) => { transactionPayload = { ...transactionPayload, event: docs[0] }; assert.equal(options.session, session); return [docs[0]]; });
  stub(t, SosThread, "create", async (docs, options) => { transactionPayload = { ...transactionPayload, thread: docs[0] }; assert.equal(options.session, session); return [docs[0]]; });
  await handler("/sos", "post")({ auth: { uid: "uid-10" }, body: { category: "medical", latitude: 1.2, longitude: 2.3 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sos_id, "40");
  assert.equal(transactionPayload.event.user_id, 10);
  assert.equal(transactionPayload.event.event_type, "report_created");
  assert.equal(transactionPayload.thread.public_id, 41);
});

test("PATCH /sos/:sosId/status rejects invalid terminal status before database access", async () => {
  const res = response();
  await handler("/sos/:sosId/status", "patch")({ params: { sosId: "40" }, body: { status: "active" }, auth: { uid: "uid-10" } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid status" });
});
