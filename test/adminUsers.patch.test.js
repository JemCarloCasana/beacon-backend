import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import router from "../src/routes/adminAdminsRoutes.js";
import { AdminRecord, ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";

function route(path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
  assert.ok(layer, `missing ${method.toUpperCase()} ${path}`);
  return layer.route.stack;
}

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function query(value) {
  return { select() { return this; }, lean: async () => value };
}

function stub(t, model, method, fn) {
  const original = model[method];
  model[method] = fn;
  t.after(() => { model[method] = original; });
}

function user(values = {}) {
  return { _id: new mongoose.Types.ObjectId("640000000000000000000011"), firebase_uid: "uid-11", email: "user@example.com", full_name: "User Eleven", phone_number: "+639171234567", role: "student", profile_image_url: null, status: "active", ...values };
}

const USER_ID = "640000000000000000000011";
const PERSONNEL_ID = "640000000000000000000010";
const ADMIN_ID = "640000000000000000000012";

const getStack = route("/admin/users/:id", "get");
const patchStack = route("/admin/users/:id", "patch");
const getHandler = getStack.at(-1).handle;
const patchHandler = patchStack.at(-1).handle;
const getAuth = getStack[0].handle;
const getPermission = getStack[1].handle;
const patchAuth = patchStack[0].handle;
const patchPermission = patchStack[1].handle;

test("GET /admin/users/:id returns the Mongo user profile", async (t) => {
  stub(t, UserProfile, "findById", (id) => { assert.equal(id.toString(), USER_ID); return query(user()); });
  const res = response();
  await getHandler({ params: { id: USER_ID } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { id: USER_ID, firebase_uid: "uid-11", email: "user@example.com", full_name: "User Eleven", phone_number: "+639171234567", role: "student", profile_image_url: null, status: "active" });
});

test("GET /admin/users/:id rejects invalid and missing IDs", async (t) => {
  const invalid = response();
  await getHandler({ params: { id: "0" } }, invalid);
  assert.equal(invalid.statusCode, 422);
  assert.deepEqual(invalid.body.errors, { id: ["Must be a valid ObjectId"] });

  stub(t, UserProfile, "findById", () => query(null));
  const missing = response();
  await getHandler({ params: { id: "640000000000000000009999" } }, missing);
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.body, { message: "User not found" });
});

test("admin user auth rejects missing tokens", async () => {
  for (const middleware of [getAuth, patchAuth]) {
    const res = response();
    let nextCalled = false;
    await middleware({ headers: {} }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  }
});

test("admin user permission middleware rejects accounts without manage_users", async (t) => {
  stub(t, AdminRecord, "findOne", () => query({ permissions: ["manage_admins"] }));
  for (const middleware of [getPermission, patchPermission]) {
    const res = response();
    let nextCalled = false;
    await middleware({ admin: { adminId: ADMIN_ID } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { message: "Insufficient permissions" });
  }
});

test("PATCH /admin/users/:id updates a profile and normalizes the email", async (t) => {
  const current = user({ email: "old@example.com" });
  const updated = user({ email: "mixed@example.com", full_name: "Updated Name" });
  stub(t, UserProfile, "findById", () => query(current));
  stub(t, UserProfile, "exists", async () => false);
  stub(t, UserProfile, "findByIdAndUpdate", (filter, update) => {
    assert.equal(filter.toString(), USER_ID);
    assert.deepEqual(update.$set, { full_name: "Updated Name", email: "mixed@example.com", updated_at: update.$set.updated_at });
    return query(updated);
  });
  const res = response();
  await patchHandler({ params: { id: USER_ID }, body: { full_name: " Updated Name ", email: " MIXED@Example.com " } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { id: USER_ID, firebase_uid: "uid-11", email: "mixed@example.com", full_name: "Updated Name", phone_number: "+639171234567", role: "student", profile_image_url: null, status: "active" });
});

test("PATCH /admin/users/:id rejects invalid IDs, empty bodies, and unknown fields", async () => {
  for (const [params, body] of [[{ id: "0" }, { full_name: "Name" }], [{ id: USER_ID }, {}], [{ id: USER_ID }, { role: "admin" }]]) {
    const res = response();
    await patchHandler({ params, body }, res);
    assert.equal(res.statusCode, 422);
  }
});

test("PATCH /admin/users/:id rejects invalid email, name, and status values", async () => {
  for (const body of [{ email: "bad" }, { full_name: "x" }, { status: "paused" }]) {
    const res = response();
    await patchHandler({ params: { id: USER_ID }, body }, res);
    assert.equal(res.statusCode, 422);
  }
});

test("PATCH /admin/users/:id preserves email conflicts and missing-user responses", async (t) => {
  stub(t, UserProfile, "findById", () => query(user({ email: "old@example.com" })));
  stub(t, UserProfile, "exists", async () => true);
  const conflict = response();
  await patchHandler({ params: { id: USER_ID }, body: { email: "taken@example.com" } }, conflict);
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.body, { message: "Email already exists" });

  stub(t, UserProfile, "findById", () => query(null));
  const missing = response();
  await patchHandler({ params: { id: "640000000000000000009999" }, body: { full_name: "Valid Name" } }, missing);
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.body, { message: "User not found" });
});

test("PATCH /admin/users/:id changes personnel status on the admin account", async (t) => {
  stub(t, AdminRecord, "findOne", () => query({ _id: new mongoose.Types.ObjectId(PERSONNEL_ID), record_type: "account", email: "personnel@example.com", full_name: "Personnel", role: "personnel", status: "active" }));
  stub(t, AdminRecord, "findOneAndUpdate", (filter, update) => {
    assert.equal(filter._id.toString(), PERSONNEL_ID);
    assert.equal(filter.role, "personnel");
    assert.equal(update.$set.status, "deactivated");
    return query({ _id: new mongoose.Types.ObjectId(PERSONNEL_ID), email: "personnel@example.com", full_name: "Personnel", status: "deactivated" });
  });
  const res = response();
  await patchHandler({ params: { id: PERSONNEL_ID }, body: { status: "deactivated" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.role, "personnel");
  assert.equal(res.body.status, "deactivated");
});

test("PATCH /admin/users/:id changes app-user status when no admin account matches", async (t) => {
  const current = user();
  const updated = user({ status: "deactivated" });
  stub(t, AdminRecord, "findOne", () => query(null));
  stub(t, UserProfile, "findById", () => query(current));
  stub(t, UserProfile, "findByIdAndUpdate", (_filter, update) => {
    assert.equal(update.$set.status, "deactivated");
    return query(updated);
  });
  const res = response();
  await patchHandler({ params: { id: USER_ID }, body: { status: "deactivated" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.role, "student");
  assert.equal(res.body.status, "deactivated");
});

test("PATCH /admin/users/:id blocks admin-role status changes and returns 404 for absent users", async (t) => {
  stub(t, AdminRecord, "findOne", () => query({ role: "admin" }));
  const forbidden = response();
  await patchHandler({ params: { id: ADMIN_ID }, body: { status: "deactivated" } }, forbidden);
  assert.equal(forbidden.statusCode, 409);

  stub(t, AdminRecord, "findOne", () => query(null));
  stub(t, UserProfile, "findById", () => query(null));
  const missing = response();
  await patchHandler({ params: { id: "640000000000000000009999" }, body: { status: "deactivated" } }, missing);
  assert.equal(missing.statusCode, 404);
});
