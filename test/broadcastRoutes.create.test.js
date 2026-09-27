import test from "node:test";
import assert from "node:assert/strict";

import broadcastRouter from "../src/routes/broadcastRoutes.js";
import { mongoose } from "../src/mongo.js";
import { Broadcast } from "../src/models/Broadcast.js";
import { BroadcastDelivery } from "../src/models/BroadcastDelivery.js";
import { Counter } from "../src/models/Counter.js";
import { UserProfile } from "../src/models/Remaining.js";
import { sendBroadcastByPublicId } from "../src/services/broadcastSend.js";

function handler(path, method) {
  const layer = broadcastRouter.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
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

test("POST /admin/broadcasts stores a normalized Mongo audience with numeric ID", async (t) => {
  let created;
  stub(t, Counter, "nextPublicId", async () => 8);
  stub(t, Broadcast, "create", async (doc) => { created = doc; return { toObject: () => ({ ...doc, created_at: new Date("2026-03-11T00:00:00.000Z") }) }; });
  const res = response();
  await handler("/admin/broadcasts", "post")({ admin: { adminId: 9 }, body: { title: "Campus Alert", body: "Classes suspended", severity: "Danger", audience_type: "role", audience_roles: [" Citizen ", "student", "CITIZEN"] } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(created.public_id, 8);
  assert.deepEqual(created.audience_roles, ["citizen", "student"]);
  assert.equal(res.body.id, 8);
});

test("POST /admin/broadcasts rejects a role audience without recipients", async () => {
  const res = response();
  await handler("/admin/broadcasts", "post")({ admin: { adminId: 5 }, body: { title: "Alert", body: "Body", severity: "announcement", audience_type: "role" } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /audience_roles is required/i);
});

test("broadcast publishing marks the Mongo broadcast and creates Mongo deliveries in one transaction", async (t) => {
  const originalSession = mongoose.startSession;
  t.after(() => { mongoose.startSession = originalSession; });
  let sessionOptions;
  const session = { withTransaction: async (callback) => callback(), endSession: async () => {} };
  mongoose.startSession = async () => session;
  stub(t, Broadcast, "findOneAndUpdate", (filter, update, options) => {
    assert.deepEqual(filter, { public_id: 12, sent_at: null });
    assert.ok(update.$set.sent_at instanceof Date);
    sessionOptions = options;
    return { lean: async () => ({ _id: "b12", public_id: 12, title: "Alert", body: "Body", severity: "warning", audience_type: "all", sent_at: update.$set.sent_at }) };
  });
  stub(t, UserProfile, "find", (filter) => {
    assert.deepEqual(filter, { status: { $ne: "deactivated" } });
    return { select: () => ({ lean: async () => [{ public_id: 31 }, { public_id: 32 }] }) };
  });
  let docs;
  let options;
  stub(t, BroadcastDelivery, "insertMany", async (value, opts) => { docs = value; options = opts; return value; });
  const result = await sendBroadcastByPublicId(12);
  assert.equal(result.status, "sent");
  assert.equal(result.deliveredCount, 2);
  assert.deepEqual(docs.map((doc) => doc.recipient_user_id), [31, 32]);
  assert.equal(options.session, session);
  assert.equal(sessionOptions.session, session);
});
