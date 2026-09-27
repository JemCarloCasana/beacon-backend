import test from "node:test";
import assert from "node:assert/strict";

import contactRouter from "../src/routes/contactRoutes.js";
import deviceRouter from "../src/routes/deviceRoutes.js";
import { ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";

function handler(router, path, method) {
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

function profile() {
  const value = new UserProfile({ firebase_uid: "uid-20", full_name: "User", email: "user@example.com" });
  value.save = async () => {};
  return value;
}

test("POST /contacts embeds a normalized contact under the authenticated profile", async (t) => {
  const user = profile();
  stub(t, UserProfile, "findOne", async () => user);
  const res = response();
  await handler(contactRouter, "/contacts", "post")({ auth: { uid: "uid-20" }, body: { contact_name: "  Alex  ", phone_number: "09123456789", relation: " friend ", is_primary: true } }, res);
  assert.equal(res.statusCode, 201);
  assert.match(res.body.id, /^[a-f\d]{24}$/i);
  assert.equal(user.emergency_contacts[0].contact_name, "Alex");
  assert.equal(user.emergency_contacts[0].phone_number, "+639123456789");
  assert.equal(user.emergency_contacts[0].relation, "friend");
  assert.equal(user.emergency_contacts[0].is_primary, true);
});

test("GET /contacts returns ObjectId string DTOs for the authenticated profile", async (t) => {
  const user = profile();
  user.emergency_contacts.push({ contact_name: "Alex", phone_number: "+639123456789", is_primary: true, created_at: new Date("2026-01-01") });
  stub(t, UserProfile, "findOne", async () => user);
  const res = response();
  await handler(contactRouter, "/contacts", "get")({ auth: { uid: "uid-20" } }, res);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, user.emergency_contacts[0]._id.toString());
  assert.equal(res.body[0].contact_name, "Alex");
});

test("PATCH /contacts/:id updates only a contact embedded in the authenticated profile", async (t) => {
  const user = profile();
  user.emergency_contacts.push({ contact_name: "Alex", phone_number: "+639123456789", is_primary: false });
  stub(t, UserProfile, "findOne", async () => user);
  const res = response();
  const id = user.emergency_contacts[0]._id.toString();
  await handler(contactRouter, "/contacts/:id", "patch")({ auth: { uid: "uid-20" }, params: { id }, body: { contact_name: "Alex Updated", phone_number: "09123456789" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, id);
  assert.equal(user.emergency_contacts[0].contact_name, "Alex Updated");
});

test("POST /devices/register updates an embedded platform device", async (t) => {
  const user = profile();
  let updateFilter;
  stub(t, UserProfile, "findOne", async () => user);
  stub(t, UserProfile, "updateMany", async (filter) => { updateFilter = filter; });
  const res = response();
  const token = "x".repeat(24);
  await handler(deviceRouter, "/devices/register", "post")({ auth: { uid: "uid-20" }, body: { token: `  ${token}  `, platform: " IOS " } }, res);
  assert.equal(updateFilter["devices.fcm_token"], token);
  assert.equal(updateFilter._id.$ne.toString(), user._id.toString());
  assert.equal(user.devices[0].fcm_token, token);
  assert.equal(user.devices[0].platform, "ios");
  assert.deepEqual(res.body, { ok: true });
});
