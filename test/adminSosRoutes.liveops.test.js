import test from "node:test";
import assert from "node:assert/strict";

import router from "../src/routes/adminSosRoutes.js";

function handler(path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} exists`);
  return layer.route.stack.at(-1).handle;
}

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("GET /admin/sos/live rejects unknown status filters", async () => {
  const res = response();
  await handler("/admin/sos/live", "get")({ query: { status: "acknowledged" } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid status filter" });
});

test("POST /admin/sos/:sosId/acknowledge validates note and assigned unit before Mongo access", async () => {
  const invalidNote = response();
  await handler("/admin/sos/:sosId/acknowledge", "post")({ params: { sosId: "111111111111111111111111" }, body: { note: 7, assigned_unit: "Police Personnel" }, admin: { adminId: "222222222222222222222222" } }, invalidNote);
  assert.equal(invalidNote.statusCode, 400);
  assert.deepEqual(invalidNote.body, { message: "note must be a string" });

  const missingUnit = response();
  await handler("/admin/sos/:sosId/acknowledge", "post")({ params: { sosId: "111111111111111111111111" }, body: {}, admin: { adminId: "222222222222222222222222" } }, missingUnit);
  assert.equal(missingUnit.statusCode, 400);
  assert.deepEqual(missingUnit.body, { message: "assigned_unit is required" });
});

test("POST /admin/sos/:sosId/resolve rejects invalid IDs before Mongo access", async () => {
  const res = response();
  await handler("/admin/sos/:sosId/resolve", "post")({ params: { sosId: "0" }, body: {}, admin: { adminId: 1 } }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { message: "Invalid sosId" });
});
