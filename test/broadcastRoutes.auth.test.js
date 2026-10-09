import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import router from "../src/routes/broadcastRoutes.js";
import { Notification, ReducedBroadcast as Broadcast, ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";

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

test("GET /admin/broadcasts/my/inbox resolves Firebase uid through Mongo profile", async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const broadcastId = new mongoose.Types.ObjectId();
  stub(t, UserProfile, "findOne", async (filter) => { assert.deepEqual(filter, { firebase_uid: "firebase-uid-1" }); return { _id: userId }; });
  stub(t, Notification, "find", (filter) => {
    assert.equal(filter.record_type, "broadcast_delivery");
    assert.equal(filter.recipient_id.toString(), userId.toString());
    return { sort: () => ({ lean: async () => [{ source: { type: "broadcast", id: broadcastId }, delivered_at: "2026-02-27T04:00:00.000Z", acknowledged_at: "2026-02-27T04:05:00.000Z" }] }) };
  });
  stub(t, Broadcast, "find", (filter) => {
    assert.equal(filter._id.$in[0].toString(), broadcastId.toString());
    return { lean: async () => [{ _id: broadcastId, title: "Broadcast", body: "Test", severity: "announcement", audience_type: "all", is_active: true }] };
  });
  const res = response();
  await handler("/admin/broadcasts/my/inbox", "get")({ auth: { uid: "firebase-uid-1" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body[0].id, broadcastId.toString());
  assert.equal(res.body[0].acknowledged_at, "2026-02-27T04:05:00.000Z");
});

test("POST /admin/broadcasts/:id/ack persists a Mongo delivery acknowledgement", async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const broadcastId = new mongoose.Types.ObjectId();
  stub(t, UserProfile, "findOne", async () => ({ _id: userId }));
  stub(t, Broadcast, "findById", (id) => { assert.equal(id.toString(), broadcastId.toString()); return { lean: async () => ({ _id: broadcastId }) }; });
  let filter;
  stub(t, Notification, "findOneAndUpdate", (value) => { filter = value; return { lean: async () => ({ acknowledged_at: "2026-03-23T12:00:00.000Z" }) }; });
  const res = response();
  await handler("/admin/broadcasts/:id/ack", "post")({ auth: { uid: "uid-2" }, params: { id: broadcastId.toString() } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(filter["source.id"].toString(), broadcastId.toString());
  assert.equal(filter.recipient_id.toString(), userId.toString());
  assert.deepEqual(res.body, { ok: true, broadcast_id: broadcastId.toString(), acknowledged_at: "2026-03-23T12:00:00.000Z" });
});

test("broadcast acknowledgement rejects users without a Mongo delivery", async (t) => {
  const broadcastId = new mongoose.Types.ObjectId();
  stub(t, UserProfile, "findOne", async () => ({ _id: new mongoose.Types.ObjectId() }));
  stub(t, Broadcast, "findById", () => ({ lean: async () => ({ _id: broadcastId }) }));
  stub(t, Notification, "findOneAndUpdate", () => ({ lean: async () => null }));
  const res = response();
  await handler("/admin/broadcasts/:id/ack", "post")({ auth: { uid: "uid-3" }, params: { id: broadcastId.toString() } }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Delivery not found" });
});

test("broadcast inbox and acknowledgement require a validated Beacon profile", async (t) => {
  stub(t, UserProfile, "findOne", async () => null);
  for (const [path, method] of [["/admin/broadcasts/my/inbox", "get"], ["/admin/broadcasts/:id/ack", "post"]]) {
    const res = response();
    await handler(path, method)({ auth: { uid: "firebase-only" }, params: { id: new mongoose.Types.ObjectId().toString() } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "PROFILE_SETUP_REQUIRED");
  }
});
