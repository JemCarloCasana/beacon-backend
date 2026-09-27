import test from "node:test";
import assert from "node:assert/strict";

import broadcastRouter from "../src/routes/broadcastRoutes.js";
import { mongoose } from "../src/mongo.js";
import { Notification, ReducedBroadcast as Broadcast, ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";
import { sendBroadcastById } from "../src/services/broadcastSend.js";

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

test("POST /admin/broadcasts stores a normalized audience with an ObjectId string", async (t) => {
  let created;
  const id = new mongoose.Types.ObjectId();
  stub(t, Broadcast, "create", async (doc) => { created = { ...doc, _id: id }; return { _id: id, toObject: () => ({ ...created, created_at: new Date("2026-03-11T00:00:00.000Z") }) }; });
  const res = response();
  await handler("/admin/broadcasts", "post")({ admin: { adminId: id.toString() }, body: { title: "Campus Alert", body: "Classes suspended", severity: "Danger", audience_type: "role", audience_roles: [" Citizen ", "student", "CITIZEN"] } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(created.created_by_admin_id.toString(), id.toString());
  assert.deepEqual(created.audience_roles, ["citizen", "student"]);
  assert.equal(res.body.id, id.toString());
});

test("POST /admin/broadcasts rejects a role audience without recipients", async () => {
  const res = response();
  const adminId = new mongoose.Types.ObjectId();
  await handler("/admin/broadcasts", "post")({ admin: { adminId: adminId.toString() }, body: { title: "Alert", body: "Body", severity: "announcement", audience_type: "role" } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /audience_roles is required/i);
});

test("broadcast publishing creates unified delivery notifications in one transaction", async (t) => {
  const originalSession = mongoose.startSession;
  t.after(() => { mongoose.startSession = originalSession; });
  let sessionOptions;
  const session = { withTransaction: async (callback) => callback(), endSession: async () => {} };
  mongoose.startSession = async () => session;
  const id = new mongoose.Types.ObjectId();
  const userIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  stub(t, Broadcast, "findOneAndUpdate", (filter, update, options) => {
    assert.equal(filter._id.toString(), id.toString());
    assert.equal(filter.sent_at, null);
    assert.ok(update.$set.sent_at instanceof Date);
    sessionOptions = options;
    return { lean: async () => ({ _id: id, title: "Alert", body: "Body", severity: "warning", audience_type: "all", sent_at: update.$set.sent_at }) };
  });
  stub(t, Broadcast, "findById", () => ({ lean: async () => null }));
  stub(t, UserProfile, "find", (filter) => {
    assert.deepEqual(filter, { status: { $ne: "deactivated" } });
    return { select: () => ({ lean: async () => userIds.map((_id) => ({ _id })) }) };
  });
  let docs;
  let options;
  stub(t, Notification, "insertMany", async (value, opts) => { docs = value; options = opts; return value; });
  const result = await sendBroadcastById(id);
  assert.equal(result.status, "sent");
  assert.equal(result.deliveredCount, 2);
  assert.deepEqual(docs.map((doc) => doc.recipient_id.toString()), userIds.map((value) => value.toString()));
  assert.equal(docs[0].record_type, "broadcast_delivery");
  assert.equal(options.session, session);
  assert.equal(sessionOptions.session, session);
});
