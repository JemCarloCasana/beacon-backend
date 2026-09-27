import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import notificationRouter from "../src/routes/notificationRoutes.js";
import { Notification, ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";
import { buildUserLifecycleNotification, notifyUserLifecycleEvent, setUserNotificationMulticastSenderForTests } from "../src/services/userNotifications.js";

const id = (value) => new mongoose.Types.ObjectId(value);
const recipientId = id("111111111111111111111111");
const entityId = id("222222222222222222222222");
const notificationId = id("333333333333333333333333");

function handler(path, method) {
  const layer = notificationRouter.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} exists`);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return { statusCode: 200, body: null, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set(name, value) { this.headers[name] = value; return this; } };
}

function stub(t, model, method, replacement) {
  const original = model[method];
  model[method] = replacement;
  t.after(() => { model[method] = original; });
}

test("buildUserLifecycleNotification returns an ObjectId-string notification payload", () => {
  const built = buildUserLifecycleNotification({ recipient_user_id: recipientId.toString(), entity_type: "sos", entity_id: entityId.toString(), status: "safe", assigned_unit: "Police Personnel" });
  assert.equal(built.recipientUserId, recipientId.toString());
  assert.equal(built.type, "sos_update");
  assert.equal(built.message, "Your SOS has been marked safe.");
  assert.deepEqual(built.metadata, { sos_id: entityId.toString(), status: "safe", assigned_unit: "Police Personnel", fallback_route: `/sos/${entityId}` });
  assert.equal(built.data.type, "sos_update");
});

test("notifyUserLifecycleEvent stores the notification when no device token exists", async (t) => {
  let created;
  stub(t, Notification, "create", async (doc) => {
    created = { ...doc, _id: notificationId, toObject() { return this; } };
    return created;
  });
  stub(t, UserProfile, "findById", (value) => {
    assert.equal(value, recipientId.toString());
    return { select: () => ({ lean: async () => ({ devices: [] }) }) };
  });
  const result = await notifyUserLifecycleEvent({ recipient_user_id: recipientId.toString(), entity_type: "incident", entity_id: entityId.toString(), status: "dispatched", assigned_department: "Fire" });
  assert.equal(created.record_type, "user");
  assert.equal(created.recipient_id.toString(), recipientId.toString());
  assert.equal(created.metadata.incident_id, entityId.toString());
  assert.equal(result.notification.id, notificationId.toString());
  assert.equal(result.notification.recipient_user_id, recipientId.toString());
  assert.deepEqual(result.push, { attempted: false, reason: "no_device_tokens" });
});

test("notifyUserLifecycleEvent deactivates invalid embedded device tokens", async (t) => {
  let deactivated;
  t.after(() => setUserNotificationMulticastSenderForTests(null));
  setUserNotificationMulticastSenderForTests(async ({ tokens }) => ({
    successCount: 1, failureCount: 1,
    responses: [{ success: true }, { success: false, error: { code: "messaging/registration-token-not-registered" } }],
    sentTokens: tokens,
  }));
  stub(t, Notification, "create", async (doc) => ({ ...doc, _id: notificationId, toObject() { return this; } }));
  stub(t, UserProfile, "findById", () => ({ select: () => ({ lean: async () => ({ devices: [{ fcm_token: "good", is_active: true }, { fcm_token: "bad", is_active: true }] }) }) }));
  stub(t, UserProfile, "updateMany", async (filter, update, options) => { deactivated = { filter, update, options }; return { modifiedCount: 1 }; });
  const result = await notifyUserLifecycleEvent({ recipient_user_id: recipientId.toString(), entity_type: "sos", entity_id: entityId.toString(), status: "resolved" });
  assert.deepEqual(deactivated.filter, { "devices.fcm_token": { $in: ["bad"] } });
  assert.equal(deactivated.update.$set["devices.$[device].is_active"], false);
  assert.deepEqual(deactivated.options.arrayFilters, [{ "device.fcm_token": { $in: ["bad"] } }]);
  assert.equal(result.push.removedTokensCount, 1);
});

test("GET /notifications lists the authenticated user's notifications newest first", async (t) => {
  stub(t, UserProfile, "findOne", async (filter) => {
    assert.deepEqual(filter, { firebase_uid: "uid-1" });
    return { _id: recipientId };
  });
  stub(t, Notification, "find", (filter) => {
    assert.deepEqual(filter, { record_type: "user", recipient_type: "user", recipient_id: recipientId });
    return { sort: (sort) => {
      assert.deepEqual(sort, { created_at: -1, _id: -1 });
      return { lean: async () => [{ _id: notificationId, recipient_id: recipientId, record_type: "user", type: "sos_update", title: "SOS", message: "Safe", metadata: { sos_id: entityId }, is_read: false, created_at: "2026-01-01T00:00:00.000Z" }] };
    } };
  });
  const res = response();
  await handler("/notifications", "get")({ auth: { uid: "uid-1" } }, res);
  assert.equal(res.body[0].id, notificationId.toString());
  assert.equal(res.body[0].recipient_user_id, recipientId.toString());
  assert.equal(res.body[0].is_read, false);
  assert.equal(res.body[0].metadata.sos_id, entityId.toString());
  assert.equal(res.headers["Cache-Control"], "no-store, private, max-age=0");
});

test("PATCH /notifications/:id/read scopes the ObjectId update to the current recipient", async (t) => {
  stub(t, UserProfile, "findOne", async () => ({ _id: recipientId }));
  let filter;
  stub(t, Notification, "findOneAndUpdate", (value, update, options) => {
    filter = value;
    assert.equal(update.$set.is_read, true);
    assert.equal(options.new, true);
    return { lean: async () => ({ _id: notificationId, recipient_id: recipientId, record_type: "user", type: "incident_update", title: "Update", message: "Sent", metadata: { incident_id: entityId }, is_read: true }) };
  });
  const res = response();
  await handler("/notifications/:id/read", "patch")({ auth: { uid: "uid-1" }, params: { id: notificationId.toString() } }, res);
  assert.deepEqual(filter, { _id: notificationId, record_type: "user", recipient_id: recipientId });
  assert.equal(res.body.notification.id, notificationId.toString());
  assert.equal(res.body.notification.is_read, true);
});
