import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/adminAdminsRoutes.js";
import { AdminNotification } from "../src/models/AdminNotification.js";
import { Counter } from "../src/models/Counter.js";
import { AdminAccount, AdminAccessRequest, Role } from "../src/models/Remaining.js";

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

test("POST /admin/admins creates a Mongo admin account with a numeric public ID", async (t) => {
  let createArgs;
  stub(t, Role, "findOne", () => lean({ public_id: 2 }));
  stub(t, AdminAccount, "findOne", () => lean(null));
  stub(t, Counter, "nextPublicId", async (name) => { assert.equal(name, "admins"); return 14; });
  stub(t, AdminAccount, "create", async (value) => { createArgs = value; return { ...value, created_at: new Date("2026-03-22T00:00:00.000Z") }; });

  const res = response();
  await route("/admin/admins", "post")({ body: { full_name: "Personnel User", email: "Personnel@example.com", password: "SecurePass1!", role: "personnel" }, admin: { adminId: 5 } }, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual({ id: res.body.id, email: res.body.email, full_name: res.body.full_name, role_id: res.body.role_id, role: res.body.role }, {
    id: 14, email: "personnel@example.com", full_name: "Personnel User", role_id: 2, role: "personnel",
  });
  assert.match(createArgs.password_hash, /^\$2/);
  assert.equal(createArgs.public_id, 14);
  assert.deepEqual(createArgs.permission_names, []);
});

test("GET /admin/admins applies status filtering and keeps the public response shape", async (t) => {
  let filter;
  const rows = [{ public_id: 7, email: "staff@example.com", full_name: "Staff", role_id: 2, created_at: "2026-01-01", status: "active" }];
  stub(t, AdminAccount, "find", (value) => { filter = value; return { sort: () => lean(rows) }; });
  const res = response();
  await route("/admin/admins", "get")({ query: { status: "ACTIVE" } }, res);
  assert.deepEqual(filter, { status: "active" });
  assert.deepEqual(res.body, [{ id: 7, email: "staff@example.com", full_name: "Staff", role_id: 2, created_at: "2026-01-01", status: "active" }]);
});

test("PATCH /admin/admins/:id updates normalized Mongo account fields", async (t) => {
  const current = { public_id: 14, email: "old@example.com", full_name: "Old Name", role_id: 2, created_at: "2026-01-01" };
  let update;
  stub(t, AdminAccount, "findOne", () => lean(current));
  stub(t, AdminAccount, "exists", async () => false);
  stub(t, AdminAccount, "findOneAndUpdate", (_filter, value) => { update = value; return lean({ ...current, ...value.$set }); });
  const res = response();
  await route("/admin/admins/:id", "patch")({ params: { id: "14" }, body: { full_name: " New Name ", email: "NEW@example.com" }, admin: { adminId: 1 } }, res);
  assert.equal(update.$set.full_name, "New Name");
  assert.equal(update.$set.email, "new@example.com");
  assert.deepEqual(res.body, { id: 14, email: "new@example.com", full_name: "New Name", role_id: 2, created_at: "2026-01-01" });
});

test("POST /admin/admin-requests persists a pending Mongo request and notification", async (t) => {
  let requestDoc;
  let notificationDoc;
  stub(t, AdminAccount, "findOne", () => lean({ public_id: 19, role: "personnel" }));
  stub(t, AdminAccessRequest, "exists", async () => false);
  stub(t, Counter, "nextPublicId", async (name) => name === "admin_requests" ? 50 : 51);
  stub(t, AdminAccessRequest, "create", async (value) => { requestDoc = value; return value; });
  stub(t, AdminNotification, "create", async (value) => { notificationDoc = value; return value; });
  const res = response();
  await route("/admin/admin-requests", "post")({ body: { personnel_id: 19, note: "Please review" }, admin: { adminId: 4 } }, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual({ id: requestDoc.public_id, personnel: requestDoc.personnel_admin_id, requester: requestDoc.requested_by_admin_id, status: requestDoc.status, note: requestDoc.note }, { id: 50, personnel: 19, requester: 4, status: "pending", note: "Please review" });
  assert.deepEqual(notificationDoc.metadata, { admin_request_id: 50, requested_by_admin_id: 4 });
});

test("PATCH /admin/admin-requests/:id/reject updates only a pending Mongo request", async (t) => {
  const current = { public_id: 50, personnel_admin_id: 19, status: "pending" };
  let updateFilter;
  stub(t, AdminAccessRequest, "findOne", () => lean(current));
  stub(t, AdminAccessRequest, "findOneAndUpdate", (filter, update) => { updateFilter = filter; return lean({ ...current, ...update.$set }); });
  const res = response();
  await route("/admin/admin-requests/:id/reject", "patch")({ params: { id: "50" }, body: { note: "Reviewed" }, admin: { adminId: 19 } }, res);
  assert.deepEqual(updateFilter, { public_id: 50, status: "pending" });
  assert.equal(res.body.request.status, "rejected");
  assert.equal(res.body.request.personnel_id, 19);
});
