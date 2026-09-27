import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/broadcastRoutes.js";
import { Broadcast } from "../src/models/Broadcast.js";
import { BroadcastDelivery } from "../src/models/BroadcastDelivery.js";
import { UserProfile } from "../src/models/Remaining.js";

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
  stub(t, UserProfile, "findOne", async (filter) => { assert.deepEqual(filter, { firebase_uid: "firebase-uid-1" }); return { public_id: 42 }; });
  stub(t, BroadcastDelivery, "find", (filter) => {
    assert.deepEqual(filter, { recipient_user_id: 42 });
    return { sort: () => ({ lean: async () => [{ broadcast_id: "b5", broadcast_public_id: 5, delivered_at: "2026-02-27T04:00:00.000Z", acknowledged_at: "2026-02-27T04:05:00.000Z" }] }) };
  });
  stub(t, Broadcast, "find", (filter) => {
    assert.deepEqual(filter, { _id: { $in: ["b5"] } });
    return { lean: async () => [{ _id: "b5", public_id: 5, title: "Broadcast", body: "Test", severity: "announcement", audience_type: "all", created_by_admin_id: 2, is_active: true }] };
  });
  const res = response();
  await handler("/admin/broadcasts/my/inbox", "get")({ auth: { uid: "firebase-uid-1" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body[0].id, 5);
  assert.equal(res.body[0].acknowledged_at, "2026-02-27T04:05:00.000Z");
});

test("POST /admin/broadcasts/:id/ack persists a Mongo delivery acknowledgement", async (t) => {
  stub(t, UserProfile, "findOne", async () => ({ public_id: 100 }));
  stub(t, Broadcast, "findOne", (filter) => { assert.deepEqual(filter, { public_id: 7 }); return { lean: async () => ({ public_id: 7 }) }; });
  let filter;
  stub(t, BroadcastDelivery, "findOneAndUpdate", (value) => { filter = value; return { lean: async () => ({ acknowledged_at: "2026-03-23T12:00:00.000Z" }) }; });
  const res = response();
  await handler("/admin/broadcasts/:id/ack", "post")({ auth: { uid: "uid-2" }, params: { id: "7" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(filter, { broadcast_public_id: 7, recipient_user_id: 100 });
  assert.deepEqual(res.body, { ok: true, broadcast_id: 7, acknowledged_at: "2026-03-23T12:00:00.000Z" });
});

test("broadcast acknowledgement rejects users without a Mongo delivery", async (t) => {
  stub(t, UserProfile, "findOne", async () => ({ public_id: 200 }));
  stub(t, Broadcast, "findOne", () => ({ lean: async () => ({ public_id: 9 }) }));
  stub(t, BroadcastDelivery, "findOneAndUpdate", () => ({ lean: async () => null }));
  const res = response();
  await handler("/admin/broadcasts/:id/ack", "post")({ auth: { uid: "uid-3" }, params: { id: "9" } }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { message: "Delivery not found" });
});
