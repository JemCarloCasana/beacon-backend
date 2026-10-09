import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { getMessaging } from "firebase-admin/messaging";
import { AdminRecord, Notification, ReducedBroadcast as Broadcast, ReducedUserProfile as UserProfile } from "../src/models/Reduced.js";
import { sendBroadcastPush } from "../src/services/fcm.js";
import { connectMongo } from "../src/mongo.js";
import { upsertMany, compareImportedDocuments } from "./mongoImportHelpers.js";

process.env.ADMIN_JWT_SECRET ||= "phase-regression-test-secret";
const router = (await import("../src/routes/broadcastRoutes.js")).default;

const route = (method, path = "/admin/broadcasts/:id") => router.stack.find(
  (entry) => entry.route?.path === path && entry.route.methods[method]
).route.stack;
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const objectId = (value) => new mongoose.Types.ObjectId(value);
const broadcastId = objectId("111111111111111111111111");
const adminId = objectId("222222222222222222222222");
const userId = objectId("333333333333333333333333");
const draft = { _id: broadcastId, title: "Alert", body: "Details", severity: "warning", audience_type: "all", created_by_admin_id: adminId, sent_at: null };

test("ack passes through real Mongoose pipeline handling", async (t) => {
  t.mock.method(UserProfile, "findOne", async () => ({ _id: userId }));
  t.mock.method(Broadcast, "findById", () => ({ lean: async () => draft }));
  const timestamp = new Date();
  t.mock.method(Notification, "findOneAndUpdate", (filter, update, options) => {
    assert.deepEqual(filter, { record_type: "broadcast_delivery", "source.type": "broadcast", "source.id": broadcastId, recipient_id: userId });
    assert.deepEqual(update, [{ $set: { acknowledged_at: { $ifNull: ["$acknowledged_at", "$$NOW"] } } }]);
    assert.equal(options.updatePipeline, true);
    return { lean: async () => ({ acknowledged_at: timestamp }) };
  });
  const res = response();
  await route("post", "/admin/broadcasts/:id/ack").at(-1).handle({ params: { id: broadcastId.toString() }, auth: { uid: "user" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.acknowledged_at, timestamp);
});

test("delete enforces current database role through the middleware chain", async (t) => {
  let role = "personnel", permissions = ["manage_broadcasts"], deletes = 0;
  t.mock.method(AdminRecord, "findOne", () => ({ select: (projection) => ({ lean: async () => projection.permissions ? { permissions } : { _id: adminId, role, status: "active" } }) }));
  t.mock.method(Broadcast, "findOneAndDelete", () => ({ lean: async () => { deletes++; return draft; } }));
  t.mock.method(Notification, "deleteMany", async () => ({ deletedCount: 0 }));
  const token = jwt.sign({ adminId: adminId.toString(), role: "admin", token_version: 0 }, process.env.ADMIN_JWT_SECRET);
  async function run(authorization) {
    const req = { params: { id: broadcastId.toString() }, headers: { authorization } }, res = response();
    for (const entry of route("delete")) {
      let next = false;
      await entry.handle(req, res, () => { next = true; });
      if (!next) break;
    }
    return res.statusCode;
  }
  assert.equal(await run(`Bearer ${token}`), 403);
  assert.equal(deletes, 0);
  role = "admin";
  permissions = [];
  assert.equal(await run(`Bearer ${token}`), 403);
  assert.equal(await run(undefined), 401);
  permissions = ["manage_broadcasts"];
  assert.equal(await run(`Bearer ${token}`), 200);
  assert.equal(deletes, 1);
});

test("audience changes require selectors and an unchanged audience snapshot", async (t) => {
  t.mock.method(Broadcast, "findById", () => ({ lean: async () => draft }));
  let updated = false;
  t.mock.method(Broadcast, "findOneAndUpdate", (filter) => ({ lean: async () => {
    updated = true;
    assert.equal(filter.audience_type, "all");
    assert.equal(filter.audience_roles, null);
    return null; // another request changed the draft audience
  } }));
  const handler = route("patch").at(-1).handle;
  const invalid = response();
  await handler({ params: { id: broadcastId.toString() }, body: { audience_type: "role" } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(updated, false);
  const conflict = response();
  await handler({ params: { id: broadcastId.toString() }, body: { audience_type: "role", audience_roles: ["citizen"] } }, conflict);
  assert.equal(conflict.statusCode, 409);
  await new Broadcast({ ...draft, audience_type: "role", audience_roles: ["citizen"] }).validate();
});

test("oversized create/edit fields produce 400 using actual schema validators", async (t) => {
  t.mock.method(Broadcast, "create", async (doc) => { await new Broadcast(doc).validate(); throw new Error("Unexpected write"); });
  const created = response();
  await route("post", "/admin/broadcasts").at(-1).handle({ admin: { adminId: adminId.toString() }, body: { ...draft, title: "x".repeat(201) } }, created);
  assert.equal(created.statusCode, 400);
  t.mock.method(Broadcast, "findById", () => ({ lean: async () => draft }));
  // Actual query validation runs before the stubbed driver write.
  t.mock.method(Broadcast.collection, "findOneAndUpdate", async () => { throw new Error("Unexpected write"); });
  const edited = response();
  await route("patch").at(-1).handle({ params: { id: broadcastId.toString() }, body: { body: "x".repeat(5001) } }, edited);
  assert.equal(edited.statusCode, 400);
});

test("push batches 0/1/500/501 tokens, continues on rejection, preserves cleanup results", async (t) => {
  t.mock.method(Notification, "find", () => ({ lean: async () => [{ recipient_id: userId }] }));
  let size = 0, rejectFirst = false, cleanupFails = false, invalidToken = false, batches = [], removed;
  t.mock.method(UserProfile, "find", () => ({ select: () => ({ lean: async () => [{ devices: Array.from({ length: size }, (_, i) => ({ fcm_token: `token${i}`, platform: "android", is_active: true })) }] }) }));
  t.mock.method(UserProfile, "updateMany", async (filter) => { removed = filter["devices.fcm_token"].$in; if (cleanupFails) throw new Error("private detail"); return {}; });
  t.mock.method(getMessaging(), "sendEachForMulticast", async ({ tokens }) => {
    batches.push(tokens.length);
    if (rejectFirst && batches.length === 1) throw new Error("private detail");
    const responses = tokens.map((token) => invalidToken && token === "token500" ? { success: false, error: { code: "messaging/registration-token-not-registered" } } : { success: true });
    const failureCount = responses.filter((r) => !r.success).length;
    return { responses, successCount: tokens.length - failureCount, failureCount };
  });
  for (size of [0, 1, 500, 501]) {
    batches = [];
    const result = await sendBroadcastPush({ broadcastId: broadcastId.toString() });
    assert.equal(result.successCount, size);
    assert.ok(batches.every((n) => n <= 500));
  }
  size = 501; batches = []; rejectFirst = true;
  let result = await sendBroadcastPush({ broadcastId: broadcastId.toString() });
  assert.deepEqual(batches, [500, 1]);
  assert.equal(result.unknownCount, 500);
  assert.equal(result.successCount, 1);
  assert.ok(result.error);
  rejectFirst = false; invalidToken = true; batches = [];
  result = await sendBroadcastPush({ broadcastId: broadcastId.toString() });
  assert.deepEqual(removed, ["token500"]);
  assert.equal(result.removedTokensCount, 1);
  cleanupFails = true;
  result = await sendBroadcastPush({ broadcastId: broadcastId.toString() });
  assert.equal(result.successCount, 500);
  assert.equal(result.removedTokensCount, 0);
  assert.ok(result.error);
});

test("import helper validates reduced broadcast documents before bulk writes", async (t) => {
  let writes = 0;
  t.mock.method(Broadcast, "bulkWrite", async () => { writes++; return {}; });
  for (const invalid of [{ severity: "invalid" }, { body: "x".repeat(5001) }]) {
    await assert.rejects(upsertMany(Broadcast, [{ ...draft, ...invalid }], ["_id"]));
  }
  assert.equal(writes, 0);
  await upsertMany(Broadcast, [draft], ["_id"]);
  assert.equal(writes, 1);
});

test("verification catches same-count recipient, time, metadata and reference changes", () => {
  const expected = [{ source: { id: broadcastId }, recipient_id: userId, acknowledged_at: new Date(0), metadata: { nested: "value" } }];
  const keys = ["source.id", "recipient_id"];
  assert.deepEqual(compareImportedDocuments(expected, expected, keys), []);
  for (const change of [{ recipient_id: adminId }, { acknowledged_at: new Date(1) }, { metadata: { nested: "changed" } }, { source: { id: adminId } }]) {
    assert.ok(compareImportedDocuments(expected, [{ ...expected[0], ...change }], keys).length);
  }
});

test("startup cannot listen when Mongo is missing or fails", async (t) => {
  const original = process.env.MONGODB_URI;
  t.after(() => { if (original === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = original; });
  process.env.MONGODB_URI = "";
  await assert.rejects(connectMongo(), /not configured/);
  const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = source.slice(source.indexOf("async function startServer()"), source.indexOf('process.once("SIGTERM"'));
  for (const fail of [true, false]) {
    let listening = false, exitCode;
    await vm.runInNewContext(`${start}\nstartServer()`, {
      connectMongo: async () => { if (fail) throw new Error("Connection failed"); },
      runMigrations: async () => {},
      app: { listen() { listening = true; } }, PORT: 0,
      console: { log() {}, error() {} }, process: { exit(code) { exitCode = code; } },
    });
    assert.equal(listening, !fail);
    assert.equal(exitCode, fail ? 1 : undefined);
  }
});
