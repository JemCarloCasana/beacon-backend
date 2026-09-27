import test from "node:test";
import assert from "node:assert/strict";

import contactRouter from "../src/routes/contactRoutes.js";
import deviceRouter from "../src/routes/deviceRoutes.js";
import { Counter } from "../src/models/Counter.js";
import { Device, EmergencyContact, UserProfile } from "../src/models/Remaining.js";

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

test("POST /contacts stores a normalized, user-owned Mongo contact", async (t) => {
  let created;
  stub(t, UserProfile, "findOne", async () => ({ public_id: 20 }));
  stub(t, EmergencyContact, "countDocuments", async () => 0);
  stub(t, Counter, "nextPublicId", async (name) => { assert.equal(name, "emergency_contacts"); return 31; });
  stub(t, EmergencyContact, "create", async (doc) => { created = doc; return { ...doc, created_at: "2026-01-01T00:00:00.000Z" }; });
  const res = response();
  await handler(contactRouter, "/contacts", "post")({ auth: { uid: "uid-20" }, body: { contact_name: "  Alex  ", phone_number: "09123456789", relation: " friend ", is_primary: true } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual({ id: res.body.id, contact_name: created.contact_name, phone_number: created.phone_number, relation: created.relation, owner: created.owner_user_id, is_primary: created.is_primary }, {
    id: 31, contact_name: "Alex", phone_number: "+639123456789", relation: "friend", owner: 20, is_primary: true,
  });
});

test("GET /contacts returns numeric-ID DTOs for the authenticated profile", async (t) => {
  stub(t, UserProfile, "findOne", async () => ({ public_id: 20 }));
  stub(t, EmergencyContact, "find", (filter) => {
    assert.deepEqual(filter, { owner_user_id: 20 });
    return { sort: () => ({ lean: async () => [{ public_id: 31, contact_name: "Alex", phone_number: "+639123456789", is_primary: true, created_at: "now" }] }) };
  });
  const res = response();
  await handler(contactRouter, "/contacts", "get")({ auth: { uid: "uid-20" } }, res);
  assert.deepEqual(res.body, [{ id: 31, contact_name: "Alex", phone_number: "+639123456789", relation: null, is_primary: true, created_at: "now" }]);
});

test("PATCH /contacts/:id updates only a contact owned by the authenticated profile", async (t) => {
  let filter;
  stub(t, UserProfile, "findOne", async () => ({ public_id: 20 }));
  stub(t, EmergencyContact, "findOneAndUpdate", (value, update, options) => {
    filter = value;
    assert.equal(update.$set.contact_name, "Alex Updated");
    assert.equal(update.$set.phone_number, "+639123456789");
    assert.equal(options.runValidators, true);
    return { lean: async () => ({ public_id: 31, contact_name: "Alex Updated", phone_number: "+639123456789", is_primary: false }) };
  });
  const res = response();
  await handler(contactRouter, "/contacts/:id", "patch")({ auth: { uid: "uid-20" }, params: { id: "31" }, body: { contact_name: "Alex Updated", phone_number: "09123456789" } }, res);
  assert.deepEqual(filter, { public_id: 31, owner_user_id: 20 });
  assert.equal(res.body.id, 31);
});

test("POST /devices/register reassigns a token and upserts the user's platform device", async (t) => {
  let deleteFilter;
  let upsert;
  stub(t, UserProfile, "findOne", async () => ({ public_id: 20 }));
  stub(t, Device, "deleteMany", async (filter) => { deleteFilter = filter; return { deletedCount: 1 }; });
  stub(t, Counter, "nextPublicId", async (name) => { assert.equal(name, "devices"); return 45; });
  stub(t, Device, "findOneAndUpdate", async (filter, update, options) => { upsert = { filter, update, options }; return { public_id: 45 }; });
  const res = response();
  const token = "x".repeat(24);
  await handler(deviceRouter, "/devices/register", "post")({ auth: { uid: "uid-20" }, body: { token: `  ${token}  `, platform: " IOS " } }, res);
  assert.deepEqual(deleteFilter, { fcm_token: token, user_id: { $ne: 20 } });
  assert.deepEqual(upsert.filter, { user_id: 20, platform: "ios" });
  assert.equal(upsert.update.$set.fcm_token, token);
  assert.equal(upsert.update.$setOnInsert.public_id, 45);
  assert.equal(upsert.options.upsert, true);
  assert.deepEqual(res.body, { ok: true });
});
