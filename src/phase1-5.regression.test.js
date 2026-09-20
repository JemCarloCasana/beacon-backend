import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import jwt from "jsonwebtoken";
import { getMessaging } from "firebase-admin/messaging";
import router from "./routes/broadcastRoutes.js";
import { pool } from "./db.js";
import { Broadcast } from "./models/Broadcast.js";
import { BroadcastDelivery } from "./models/BroadcastDelivery.js";
import { Counter } from "./models/Counter.js";
import { sendBroadcastPush } from "./services/fcm.js";
import { connectMongo } from "./mongo.js";
import { upsertMany, advanceCounter, compareImportedDocuments } from "../scripts/migrate-mongo.js";

const route = (method, path = "/admin/broadcasts/:id") => router.stack.find(
  (entry) => entry.route?.path === path && entry.route.methods[method]
).route.stack;
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const draft = { public_id: 7, title: "Alert", body: "Details", severity: "warning", audience_type: "all", created_by_admin_id: 1, sent_at: null };

test("ack passes through real Mongoose pipeline handling", async (t) => {
  t.mock.method(pool, "query", async () => ({ rows: [{ id: 42 }], rowCount: 1 }));
  t.mock.method(Broadcast, "findOne", () => ({ lean: async () => draft }));
  const timestamp = new Date();
  t.mock.method(BroadcastDelivery.collection, "findOneAndUpdate", async (filter, update) => {
    assert.deepEqual(filter, { broadcast_public_id: 7, recipient_user_id: 42 });
    assert.deepEqual(update, [{ $set: { acknowledged_at: { $ifNull: ["$acknowledged_at", "$$NOW"] } } }]);
    return { acknowledged_at: timestamp };
  });
  const res = response();
  await route("post", "/admin/broadcasts/:id/ack").at(-1).handle({ params: { id: "7" }, auth: { uid: "user" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.acknowledged_at, timestamp);
});

test("delete enforces current database role through the middleware chain", async (t) => {
  let role = "personnel", permissions = ["manage_broadcasts"], deletes = 0;
  t.mock.method(pool, "query", async (sql) => ({ rowCount: 1, rows: [sql.includes("AS permissions") ? { permissions } : sql.includes("AS role") ? { role } : { id: 2, status: "active" }] }));
  t.mock.method(Broadcast, "findOneAndDelete", () => ({ lean: async () => { deletes++; return draft; } }));
  t.mock.method(BroadcastDelivery, "deleteMany", async () => ({ deletedCount: 0 }));
  const token = jwt.sign({ adminId: 2, role: "admin" }, process.env.ADMIN_JWT_SECRET);
  async function run(authorization) {
    const req = { params: { id: "7" }, headers: { authorization } }, res = response();
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
  t.mock.method(Broadcast, "findOne", () => ({ lean: async () => draft }));
  let updated = false;
  t.mock.method(Broadcast, "findOneAndUpdate", (filter) => ({ lean: async () => {
    updated = true;
    assert.equal(filter.audience_type, "all");
    assert.equal(filter.audience_roles, null);
    return null; // another request changed the draft audience
  } }));
  const handler = route("patch").at(-1).handle;
  const invalid = response();
  await handler({ params: { id: "7" }, body: { audience_type: "role" } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(updated, false);
  const conflict = response();
  await handler({ params: { id: "7" }, body: { audience_type: "role", audience_roles: ["citizen"] } }, conflict);
  assert.equal(conflict.statusCode, 409);
  await assert.rejects(new Broadcast({ ...draft, audience_type: "role" }).validate());
  await new Broadcast({ ...draft, audience_type: "role", audience_role_ids: [3] }).validate();
});

test("oversized create/edit fields produce 400 using actual schema validators", async (t) => {
  t.mock.method(Counter, "nextPublicId", async () => 7);
  t.mock.method(Broadcast, "create", async (doc) => { await new Broadcast(doc).validate(); throw new Error("Unexpected write"); });
  const created = response();
  await route("post", "/admin/broadcasts").at(-1).handle({ admin: { adminId: 1 }, body: { ...draft, title: "x".repeat(201) } }, created);
  assert.equal(created.statusCode, 400);
  t.mock.method(Broadcast, "findOne", () => ({ lean: async () => draft }));
  // Actual query validation runs before the stubbed driver write.
  t.mock.method(Broadcast.collection, "findOneAndUpdate", async () => { throw new Error("Unexpected write"); });
  const edited = response();
  await route("patch").at(-1).handle({ params: { id: "7" }, body: { body: "x".repeat(5001) } }, edited);
  assert.equal(edited.statusCode, 400);
});

test("push batches 0/1/500/501 tokens, continues on rejection, preserves cleanup results", async (t) => {
  t.mock.method(BroadcastDelivery, "find", () => ({ lean: async () => [{ recipient_user_id: 1 }] }));
  let size = 0, rejectFirst = false, cleanupFails = false, invalidToken = false, batches = [], removed;
  t.mock.method(pool, "query", async (sql, args) => {
    if (sql.startsWith("DELETE")) { removed = args[0]; if (cleanupFails) throw new Error("private detail"); return {}; }
    return { rows: Array.from({ length: size }, (_, i) => ({ fcm_token: `token${i}` })) };
  });
  t.mock.method(getMessaging(), "sendEachForMulticast", async ({ tokens }) => {
    batches.push(tokens.length);
    if (rejectFirst && batches.length === 1) throw new Error("private detail");
    const responses = tokens.map((token) => invalidToken && token === "token500" ? { success: false, error: { code: "messaging/registration-token-not-registered" } } : { success: true });
    const failureCount = responses.filter((r) => !r.success).length;
    return { responses, successCount: tokens.length - failureCount, failureCount };
  });
  for (size of [0, 1, 500, 501]) {
    batches = [];
    const result = await sendBroadcastPush({ broadcastPublicId: 7 });
    assert.equal(result.successCount, size);
    assert.ok(batches.every((n) => n <= 500));
  }
  size = 501; batches = []; rejectFirst = true;
  let result = await sendBroadcastPush({ broadcastPublicId: 7 });
  assert.deepEqual(batches, [500, 1]);
  assert.equal(result.unknownCount, 500);
  assert.equal(result.successCount, 1);
  assert.ok(result.error);
  rejectFirst = false; invalidToken = true; batches = [];
  result = await sendBroadcastPush({ broadcastPublicId: 7 });
  assert.deepEqual(removed, ["token500"]);
  assert.equal(result.removedTokensCount, 1);
  cleanupFails = true;
  result = await sendBroadcastPush({ broadcastPublicId: 7 });
  assert.equal(result.successCount, 500);
  assert.equal(result.removedTokensCount, 0);
  assert.ok(result.error);
});

test("import validates before bulk writes and counter uses atomic max", async (t) => {
  let writes = 0;
  t.mock.method(Broadcast, "bulkWrite", async () => { writes++; return {}; });
  for (const invalid of [{ severity: "invalid" }, { public_id: Number.MAX_SAFE_INTEGER + 1 }, { body: "x".repeat(5001) }, { audience_type: "role" }]) {
    await assert.rejects(upsertMany(Broadcast, [{ ...draft, ...invalid }], ["public_id"]));
  }
  assert.equal(writes, 0);
  await upsertMany(Broadcast, [draft], ["public_id"]);
  assert.equal(writes, 1);
  t.mock.method(Counter, "findOneAndUpdate", async (filter, update, options) => {
    assert.deepEqual(update, { $max: { seq: 7 } });
    assert.equal(options.setDefaultsOnInsert, false);
    return { seq: 9 };
  });
  assert.equal(await advanceCounter("broadcasts", 7), 9);
});

test("verification catches same-count recipient, time, metadata and reference changes", () => {
  const expected = [{ broadcast_public_id: 7, recipient_user_id: 1, broadcast_id: "parent", acknowledged_at: new Date(0), metadata: { nested: "value" } }];
  const keys = ["broadcast_public_id", "recipient_user_id"];
  assert.deepEqual(compareImportedDocuments(expected, expected, keys), []);
  for (const change of [{ recipient_user_id: 2 }, { acknowledged_at: new Date(1) }, { metadata: { nested: "changed" } }, { broadcast_id: "other" }]) {
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
