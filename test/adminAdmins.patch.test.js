import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import router from "../src/routes/adminAdminsRoutes.js";
import { AdminRecord, Notification } from "../src/models/Reduced.js";
import { OPS_SUITE_PERMISSIONS } from "../src/utils/adminAuthValidation.js";

function route(path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} exists`);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function stub(t, model, method, replacement) {
  const original = model[method];
  model[method] = replacement;
  t.after(() => { model[method] = original; });
}

const lean = (value) => ({ lean: async () => value });

test("POST /admin/admins creates an admin account with an ObjectId string", async (t) => {
  let createArgs;
  const id = new mongoose.Types.ObjectId();
  stub(t, AdminRecord, "findOne", () => lean(null));
  stub(t, AdminRecord, "create", async (value) => { createArgs = value; return { ...value, _id: id, created_at: new Date("2026-03-22T00:00:00.000Z") }; });

  const res = response();
  await route("/admin/admins", "post")({ body: { full_name: "Personnel User", email: "Personnel@example.com", password: "SecurePass1!", role: "personnel" }, admin: { adminId: id.toString() } }, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual({ id: res.body.id, email: res.body.email, full_name: res.body.full_name, role: res.body.role, permissions: res.body.permissions }, {
    id: id.toString(), email: "personnel@example.com", full_name: "Personnel User", role: "personnel", permissions: [],
  });
  assert.match(createArgs.password_hash, /^\$2/);
  assert.equal(createArgs.record_type, "account");
  assert.deepEqual(createArgs.permissions, []);
});

test("GET /admin/admins applies status filtering and keeps the public response shape", async (t) => {
  let filter;
  const id = new mongoose.Types.ObjectId();
  const rows = [{ _id: id, email: "staff@example.com", full_name: "Staff", role: "personnel", created_at: "2026-01-01", status: "active", permissions: ["manage_sos", "view_incidents"] }];
  stub(t, AdminRecord, "find", (value) => { filter = value; return { sort: () => lean(rows) }; });
  const res = response();
  await route("/admin/admins", "get")({ query: { status: "ACTIVE" } }, res);
  assert.deepEqual(filter, { record_type: "account", status: "active" });
  assert.deepEqual(res.body, [{ id: id.toString(), email: "staff@example.com", full_name: "Staff", role: "personnel", created_at: "2026-01-01", status: "active", permissions: ["manage_sos", "view_incidents"] }]);
});

test("GET /admin/admins coerces a missing permissions array to an empty array", async (t) => {
  const id = new mongoose.Types.ObjectId();
  const rows = [{ _id: id, email: "legacy@example.com", full_name: "Legacy", role: "personnel", created_at: "2026-01-01", status: "active" }];
  stub(t, AdminRecord, "find", () => ({ sort: () => lean(rows) }));
  const res = response();
  await route("/admin/admins", "get")({ query: {} }, res);
  assert.deepEqual(res.body[0].permissions, []);
});

test("PATCH /admin/admins/:id updates normalized Mongo account fields", async (t) => {
  const id = new mongoose.Types.ObjectId();
  const current = { _id: id, email: "old@example.com", full_name: "Old Name", role: "personnel", created_at: "2026-01-01" };
  let update;
  stub(t, AdminRecord, "findOne", () => lean(current));
  stub(t, AdminRecord, "exists", async () => false);
  stub(t, AdminRecord, "findOneAndUpdate", (_filter, value) => { update = value; return lean({ ...current, ...value.$set }); });
  const res = response();
  await route("/admin/admins/:id", "patch")({ params: { id: id.toString() }, body: { full_name: " New Name ", email: "NEW@example.com" }, admin: { adminId: id.toString() } }, res);
  assert.equal(update.$set.full_name, "New Name");
  assert.equal(update.$set.email, "new@example.com");
  assert.deepEqual(res.body, { id: id.toString(), email: "new@example.com", full_name: "New Name", created_at: "2026-01-01" });
});

test("POST /admin/admin-requests persists a pending Mongo request and notification", async (t) => {
  let requestDoc;
  let notificationDoc;
  const personnelId = new mongoose.Types.ObjectId();
  const requesterId = new mongoose.Types.ObjectId();
  const requestId = new mongoose.Types.ObjectId();
  stub(t, AdminRecord, "findOne", () => lean({ _id: personnelId, role: "personnel" }));
  stub(t, AdminRecord, "exists", async () => false);
  stub(t, AdminRecord, "create", async (value) => { requestDoc = { ...value, _id: requestId }; return requestDoc; });
  stub(t, Notification, "create", async (value) => { notificationDoc = value; return value; });
  const res = response();
  await route("/admin/admin-requests", "post")({ body: { personnel_id: personnelId.toString(), note: "Please review" }, admin: { adminId: requesterId.toString() } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual({ id: res.body.request.id, personnel: requestDoc.personnel_admin_id.toString(), requester: requestDoc.requested_by_admin_id.toString(), status: requestDoc.status, note: requestDoc.note }, { id: requestId.toString(), personnel: personnelId.toString(), requester: requesterId.toString(), status: "pending", note: "Please review" });
  assert.deepEqual(notificationDoc.metadata, { admin_request_id: requestId.toString(), requested_by_admin_id: requesterId.toString() });
});

test("PATCH /admin/admin-requests/:id/reject updates only a pending Mongo request", async (t) => {
  const id = new mongoose.Types.ObjectId();
  const personnelId = new mongoose.Types.ObjectId();
  const current = { _id: id, personnel_admin_id: personnelId, status: "pending" };
  let updateFilter;
  stub(t, AdminRecord, "findOne", () => lean(current));
  stub(t, AdminRecord, "findOneAndUpdate", (filter, update) => { updateFilter = filter; return lean({ ...current, ...update.$set }); });
  const res = response();
  await route("/admin/admin-requests/:id/reject", "patch")({ params: { id: id.toString() }, body: { note: "Reviewed" }, admin: { adminId: personnelId.toString() } }, res);
  assert.equal(updateFilter._id.toString(), id.toString());
  assert.equal(updateFilter.record_type, "access_request");
  assert.equal(updateFilter.status, "pending");
  assert.equal(res.body.request.status, "rejected");
  assert.equal(res.body.request.personnel_id, personnelId.toString());
});

test("POST /admin/admins defaults admin-role accounts to the ops permission suite", async (t) => {
  let createArgs;
  const id = new mongoose.Types.ObjectId();
  stub(t, AdminRecord, "findOne", () => lean(null));
  stub(t, AdminRecord, "create", async (value) => { createArgs = value; return { ...value, _id: id, created_at: new Date("2026-03-22T00:00:00.000Z") }; });
  const res = response();
  await route("/admin/admins", "post")({ body: { full_name: "Admin User", email: "Admin@example.com", password: "SecurePass1!", role: "admin" }, admin: { adminId: id.toString() } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(createArgs.permissions, OPS_SUITE_PERMISSIONS);
});

test("POST /admin/admins honors an explicit permissions array", async (t) => {
  let createArgs;
  const id = new mongoose.Types.ObjectId();
  stub(t, AdminRecord, "findOne", () => lean(null));
  stub(t, AdminRecord, "create", async (value) => { createArgs = value; return { ...value, _id: id, created_at: new Date("2026-03-22T00:00:00.000Z") }; });
  const res = response();
  await route("/admin/admins", "post")({ body: { full_name: "Admin User", email: "Admin2@example.com", password: "SecurePass1!", role: "admin", permissions: ["manage_sos", "view_incidents"] }, admin: { adminId: id.toString() } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(createArgs.permissions, ["manage_sos", "view_incidents"]);
});

test("POST /admin/admins rejects unknown permissions", async (t) => {
  const id = new mongoose.Types.ObjectId();
  stub(t, AdminRecord, "findOne", () => lean(null));
  const res = response();
  await route("/admin/admins", "post")({ body: { full_name: "Admin User", email: "Admin3@example.com", password: "SecurePass1!", role: "admin", permissions: ["nope"] }, admin: { adminId: id.toString() } }, res);
  assert.equal(res.statusCode, 422);
});

test("PATCH /admin/admins/:id updates permissions", async (t) => {
  const id = new mongoose.Types.ObjectId();
  const current = { _id: id, email: "old@example.com", full_name: "Old Name", role: "admin", created_at: "2026-01-01" };
  let update;
  stub(t, AdminRecord, "findOne", () => lean(current));
  stub(t, AdminRecord, "exists", async () => false);
  stub(t, AdminRecord, "findOneAndUpdate", (_filter, value) => { update = value; return lean({ ...current, ...value.$set }); });
  const res = response();
  await route("/admin/admins/:id", "patch")({ params: { id: id.toString() }, body: { permissions: ["manage_sos", "view_incidents"] }, admin: { adminId: "other-admin-id" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(update.$set.permissions, ["manage_sos", "view_incidents"]);
});

test("PATCH /admin/admins/:id cannot change your own permissions", async (t) => {
  const id = new mongoose.Types.ObjectId();
  const current = { _id: id, email: "old@example.com", full_name: "Old Name", role: "admin", created_at: "2026-01-01" };
  stub(t, AdminRecord, "findOne", () => lean(current));
  const res = response();
  await route("/admin/admins/:id", "patch")({ params: { id: id.toString() }, body: { permissions: ["manage_sos"] }, admin: { adminId: id.toString() } }, res);
  assert.equal(res.statusCode, 403);
});

test("PATCH /admin/admins/:id rejects unknown permissions", async (t) => {
  const id = new mongoose.Types.ObjectId();
  const current = { _id: id, email: "old@example.com", full_name: "Old Name", role: "admin", created_at: "2026-01-01" };
  stub(t, AdminRecord, "findOne", () => lean(current));
  const res = response();
  await route("/admin/admins/:id", "patch")({ params: { id: id.toString() }, body: { permissions: ["nope"] }, admin: { adminId: "other-admin-id" } }, res);
  assert.equal(res.statusCode, 422);
});

test("PATCH /admin/admin-requests/:id/accept grants the ops suite by default", async (t) => {
  const originalSession = mongoose.startSession;
  t.after(() => { mongoose.startSession = originalSession; });
  const session = { withTransaction: async (cb) => cb(), endSession: async () => {} };
  mongoose.startSession = async () => session;
  const requestId = new mongoose.Types.ObjectId();
  const personnelId = new mongoose.Types.ObjectId();
  const current = { _id: requestId, personnel_admin_id: personnelId, status: "pending" };
  let promotedUpdate;
  stub(t, AdminRecord, "findOne", () => lean(current));
  stub(t, AdminRecord, "findOneAndUpdate", (filter, value) => {
    if (filter?.role === "personnel") { promotedUpdate = value; return lean({ _id: personnelId, ...value.$set }); }
    return lean({ _id: requestId, personnel_admin_id: personnelId, status: "approved" });
  });
  const res = response();
  await route("/admin/admin-requests/:id/accept", "patch")({ params: { id: requestId.toString() }, body: {}, admin: { adminId: personnelId.toString() } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(promotedUpdate.$set.permissions, OPS_SUITE_PERMISSIONS);
});

test("PATCH /admin/admin-requests/:id/accept honors provided permissions", async (t) => {
  const originalSession = mongoose.startSession;
  t.after(() => { mongoose.startSession = originalSession; });
  const session = { withTransaction: async (cb) => cb(), endSession: async () => {} };
  mongoose.startSession = async () => session;
  const requestId = new mongoose.Types.ObjectId();
  const personnelId = new mongoose.Types.ObjectId();
  const current = { _id: requestId, personnel_admin_id: personnelId, status: "pending" };
  let promotedUpdate;
  stub(t, AdminRecord, "findOne", () => lean(current));
  stub(t, AdminRecord, "findOneAndUpdate", (filter, value) => {
    if (filter?.role === "personnel") { promotedUpdate = value; return lean({ _id: personnelId, ...value.$set }); }
    return lean({ _id: requestId, personnel_admin_id: personnelId, status: "approved" });
  });
  const res = response();
  await route("/admin/admin-requests/:id/accept", "patch")({ params: { id: requestId.toString() }, body: { permissions: ["manage_reports"] }, admin: { adminId: personnelId.toString() } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(promotedUpdate.$set.permissions, ["manage_reports"]);
});

test("GET /admin/notifications returns string target ids even for numeric-looking ObjectIds", async (t) => {
  const adminId = new mongoose.Types.ObjectId();
  const numericHex = "123456789012345678901234";
  stub(t, AdminRecord, "findOne", () => ({ select: () => ({ lean: async () => ({ permissions: ["manage_sos", "view_incidents"] }) }) }));
  stub(t, Notification, "find", () => ({
    sort: () => ({ lean: async () => [{ _id: new mongoose.Types.ObjectId(), recipient_id: adminId, type: "sos", title: "SOS", message: "New SOS", metadata: { admin_request_id: "56", sos_id: numericHex }, is_read: false, created_at: "2026-01-01" }] }),
  }));
  const res = response();
  await route("/admin/notifications", "get")({ admin: { adminId: adminId.toString() } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body[0].metadata.admin_request_id, "56");
  assert.equal(res.body[0].metadata.sos_id, numericHex);
  assert.equal(res.body[0].metadata.fallback_route, `/admin/sos/${numericHex}`);
});
