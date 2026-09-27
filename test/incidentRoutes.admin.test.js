import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/incidentRoutes.js";

function handler(path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} exists`);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return { statusCode: 200, body: null, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set(name, value) { this.headers[name] = value; return this; } };
}

test("GET /admin/incidents rejects invalid status filters", async () => {
  const res = response();
  await handler("/admin/incidents", "get")({ query: { status: "closed" } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid status filter" });
});

test("GET /admin/incidents/:id validates ObjectId strings", async () => {
  const res = response();
  await handler("/admin/incidents/:id", "get")({ params: { id: "abc" } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid incident id" });
});

test("PATCH /admin/incidents/:id rejects legacy SQL-era assignment fields", async () => {
  const res = response();
  await handler("/admin/incidents/:id", "patch")({ params: { id: "640000000000000000000031" }, body: { assigned_admin_id: 4 } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /assigned_admin_id is no longer supported/i);
});

test("PATCH /admin/incidents/:id validates department and transition input before saving", async () => {
  const badDepartment = response();
  await handler("/admin/incidents/:id", "patch")({ params: { id: "640000000000000000000031" }, body: { assigned_department: "Unknown" } }, badDepartment);
  assert.equal(badDepartment.statusCode, 400);
  assert.deepEqual(badDepartment.body, { message: "Invalid assigned_department" });

  const badStatus = response();
  await handler("/admin/incidents/:id", "patch")({ params: { id: "640000000000000000000031" }, body: { status: "closed" } }, badStatus);
  assert.equal(badStatus.statusCode, 400);
  assert.deepEqual(badStatus.body, { message: "Invalid status" });
});
