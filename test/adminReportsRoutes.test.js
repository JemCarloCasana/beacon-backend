import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import router from "../src/routes/adminReportsRoutes.js";
import { ReducedReportRun as ReportRun, ReducedIncidentReport as IncidentReport, SosRecord } from "../src/models/Reduced.js";

function handler(path, method) {
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods?.[method]);
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

function stubEmptyAnalytics(t) {
  stub(t, IncidentReport, "find", () => ({ lean: async () => [] }));
  stub(t, SosRecord, "find", () => ({ sort() { return this; }, lean: async () => [] }));
  stub(t, ReportRun, "find", () => ({ sort: () => ({ lean: async () => [] }) }));
}

test("reports reject invalid range and timezone inputs", async () => {
  const badRange = response();
  await handler("/admin/reports/overview", "get")({ query: { range: "90d" } }, badRange);
  assert.equal(badRange.statusCode, 400);
  assert.deepEqual(badRange.body, { message: "Invalid range" });

  const badTimezone = response();
  await handler("/admin/reports/overview", "get")({ query: { range: "7d", timezone: "UTC" } }, badTimezone);
  assert.equal(badTimezone.statusCode, 400);
  assert.deepEqual(badTimezone.body, { message: "Invalid timezone" });
});

test("GET /admin/reports/overview reads Mongo models and returns stable cards and zero KPIs", async (t) => {
  stubEmptyAnalytics(t);
  const res = response();
  await handler("/admin/reports/overview", "get")({ query: { range: "7d", timezone: "Asia/Manila" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.range, "7d");
  assert.equal(res.body.timezone, "Asia/Manila");
  assert.equal(res.body.cards.length, 3);
  assert.deepEqual(res.body.kpis, { total_incidents: 0, active_incidents: 0, resolved_incidents: 0, active_sos: 0, avg_response_seconds: 0, avg_resolution_seconds: 0 });
});

test("POST /admin/reports/generate persists a report run with an ObjectId admin reference", async (t) => {
  stubEmptyAnalytics(t);
  let created;
  stub(t, ReportRun, "create", async (doc) => { created = doc; return { ...doc, _id: new mongoose.Types.ObjectId() }; });
  const adminId = new mongoose.Types.ObjectId();
  const res = response();
  await handler("/admin/reports/generate", "post")({ body: { report_key: "weekly_safety_report" }, admin: { adminId: adminId.toString() } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(created.public_id, undefined);
  assert.equal(created.range_key, "7d");
  assert.equal(created.generated_by_admin_id.toString(), adminId.toString());
  assert.equal(res.body.range, "7d");
});
