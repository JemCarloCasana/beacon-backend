import test from "node:test";
import assert from "node:assert/strict";

import notificationRouter from "../src/routes/notificationRoutes.js";
import { Counter } from "../src/models/Counter.js";
import { UserNotification } from "../src/models/UserNotification.js";
import { Device, UserProfile } from "../src/models/Remaining.js";
import { buildUserLifecycleNotification, notifyUserLifecycleEvent, setUserNotificationMulticastSenderForTests } from "../src/services/userNotifications.js";

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

test("buildUserLifecycleNotification returns the app's SOS notification payload", () => {
  const built = buildUserLifecycleNotification({ recipient_user_id: 9, entity_type: "sos", entity_id: 81, status: "safe", assigned_unit: "Police Personnel" });
  assert.equal(built.recipientUserId, 9);
  assert.equal(built.type, "sos_update");
  assert.equal(built.message, "Your SOS has been marked safe.");
  assert.deepEqual(built.metadata, { sos_id: 81, status: "safe", assigned_unit: "Police Personnel", fallback_route: "/sos/81" });
  assert.equal(built.data.type, "sos_update");
});

test("notifyUserLifecycleEvent stores the notification in Mongo when no device token exists", async (t) => {
  let created;
  stub(t, Counter, "nextPublicId", async () => 44);
  stub(t, UserNotification, "create", async (doc) => { created = doc; return doc; });
  stub(t, Device, "find", (filter) => { assert.deepEqual(filter, { user_id: 9, is_active: true }); return { select: () => ({ lean: async () => [] }) }; });
  const result = await notifyUserLifecycleEvent({ recipient_user_id: 9, entity_type: "incident", entity_id: 81, status: "dispatched", assigned_department: "Fire" });
  assert.equal(created.public_id, 44);
  assert.equal(created.recipient_user_id, 9);
  assert.equal(created.metadata.incident_id, 81);
  assert.equal(result.notification.id, 44);
  assert.deepEqual(result.push, { attempted: false, reason: "no_device_tokens" });
});

test("notifyUserLifecycleEvent deactivates invalid Mongo device tokens", async (t) => {
  const originalSender = null;
  let deactivated;
  t.after(() => setUserNotificationMulticastSenderForTests(originalSender));
  setUserNotificationMulticastSenderForTests(async ({ tokens }) => ({
    successCount: 1, failureCount: 1,
    responses: [{ success: true }, { success: false, error: { code: "messaging/registration-token-not-registered" } }],
    sentTokens: tokens,
  }));
  stub(t, Counter, "nextPublicId", async () => 45);
  stub(t, UserNotification, "create", async (doc) => doc);
  stub(t, Device, "find", () => ({ select: () => ({ lean: async () => [{ fcm_token: "good" }, { fcm_token: "bad" }] }) }));
  stub(t, Device, "updateMany", async (filter, update) => { deactivated = { filter, update }; return { modifiedCount: 1 }; });
  const result = await notifyUserLifecycleEvent({ recipient_user_id: 9, entity_type: "sos", entity_id: 82, status: "resolved" });
  assert.deepEqual(deactivated.filter, { fcm_token: { $in: ["bad"] } });
  assert.equal(deactivated.update.$set.is_active, false);
  assert.equal(result.push.removedTokensCount, 1);
});

test("GET /notifications lists the authenticated user's Mongo notifications newest first", async (t) => {
  stub(t, UserProfile, "findOne", async () => ({ public_id: 9 }));
  stub(t, UserNotification, "find", (filter) => { assert.deepEqual(filter, { recipient_user_id: 9 }); return { sort: () => ({ lean: async () => [{ public_id: 44, recipient_user_id: 9, type: "sos_update", title: "SOS", message: "Safe", metadata: { sos_id: "81" }, is_read: false, created_at: "2026-01-01T00:00:00.000Z" }] }) }; });
  const res = response();
  await handler("/notifications", "get")({ auth: { uid: "uid-9" } }, res);
  assert.equal(res.body[0].id, 44);
  assert.equal(res.body[0].is_read, false);
  assert.equal(res.body[0].metadata.sos_id, 81);
  assert.equal(res.headers["Cache-Control"], "no-store, private, max-age=0");
});

test("PATCH /notifications/:id/read scopes Mongo update to the current recipient", async (t) => {
  stub(t, UserProfile, "findOne", async () => ({ public_id: 9 }));
  let filter;
  stub(t, UserNotification, "findOneAndUpdate", (value) => { filter = value; return { lean: async () => ({ public_id: 44, recipient_user_id: 9, type: "incident_update", title: "Update", message: "Sent", metadata: { incident_id: 81 }, is_read: true }) }; });
  const res = response();
  await handler("/notifications/:id/read", "patch")({ auth: { uid: "uid-9" }, params: { id: "44" } }, res);
  assert.deepEqual(filter, { public_id: 44, recipient_user_id: 9 });
  assert.equal(res.body.notification.is_read, true);
});
