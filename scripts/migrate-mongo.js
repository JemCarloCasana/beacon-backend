// One-shot, rerunnable PG -> Mongo historical import for the five migrating domains.
// Explicit maintenance command only: `npm run mongo:import`.
// - PG is read with SELECT only; nothing is written back to PostgreSQL.
// - Every write is an upsert on a stable key, so reruns change nothing.
// - Counters advance to at least the imported maximum and never decrease.
// - Never run a PG reimport automatically after MongoDB becomes authoritative.
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const imported = new Map();
import { pool } from "../src/db.js";
import { connectMongo, disconnectMongo } from "../src/mongo.js";
import { AdminNotification } from "../src/models/AdminNotification.js";
import { UserNotification } from "../src/models/UserNotification.js";
import { Broadcast } from "../src/models/Broadcast.js";
import { BroadcastDelivery } from "../src/models/BroadcastDelivery.js";
import { ReportRun } from "../src/models/ReportRun.js";
import { Counter } from "../src/models/Counter.js";

function normalizeMetadata(value) {
  if (value == null) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Invalid historical data must not be silently replaced with an empty object.
    }
    throw new Error("Invalid historical notification metadata");
  }
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  throw new Error("Invalid historical notification metadata");
}

function nullToUndefined(value) {
  return value == null ? undefined : value;
}

export async function upsertMany(model, docs, keyFields) {
  for (const doc of docs) {
    try {
      await new model(doc).validate();
    } catch (err) {
      const detail = `${model.modelName} key=${keyFields.map((key) => doc[key]).join("/")} invalid fields: ${Object.keys(err.errors ?? {}).join(",")}`;
      console.error(detail);
      throw new Error("Historical document validation failed");
    }
  }
  imported.set(model, { docs, keyFields });
  if (docs.length === 0) return { upserted: 0, modified: 0, matched: 0 };
  const ops = docs.map((doc) => {
    const filter = {};
    for (const key of keyFields) filter[key] = doc[key];
    const fields = Object.fromEntries(Object.entries(doc).map(([key, value]) => [key, value ?? null]));
    return { updateOne: { filter, update: { $set: fields }, upsert: true } };
  });
  const result = await model.bulkWrite(ops, { ordered: false });
  return {
    upserted: result.upsertedCount ?? 0,
    modified: result.modifiedCount ?? 0,
    matched: result.matchedCount ?? 0,
  };
}

// Advance a counter to at least `floor` without ever decreasing it.
export async function advanceCounter(key, floor) {
  const counter = await Counter.findOneAndUpdate(
    { _id: key }, { $max: { seq: Number(floor ?? 0) } },
    { upsert: true, new: true, setDefaultsOnInsert: false }
  );
  return counter.seq;
}

async function importAdminNotifications() {
  const { rows } = await pool.query(
    `SELECT id, recipient_admin_id, type, title, message, metadata, is_read, created_at
     FROM notifications ORDER BY id`
  );
  const docs = rows.map((row) => ({
    public_id: Number(row.id),
    recipient_admin_id: Number(row.recipient_admin_id),
    type: String(row.type),
    title: String(row.title),
    message: String(row.message),
    metadata: normalizeMetadata(row.metadata),
    is_read: Boolean(row.is_read),
    created_at: new Date(row.created_at),
  }));
  const stats = await upsertMany(AdminNotification, docs, ["public_id"]);
  const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0);
  const counter = await advanceCounter("notifications", maxId);
  return { pg: rows.length, ...stats, counter };
}

async function importUserNotifications() {
  const { rows } = await pool.query(
    `SELECT id, recipient_user_id, type, title, message, metadata, is_read, created_at
     FROM user_notifications ORDER BY id`
  );
  const docs = rows.map((row) => ({
    public_id: Number(row.id),
    recipient_user_id: Number(row.recipient_user_id),
    type: String(row.type),
    title: String(row.title),
    message: String(row.message),
    metadata: normalizeMetadata(row.metadata),
    is_read: Boolean(row.is_read),
    created_at: new Date(row.created_at),
  }));
  const stats = await upsertMany(UserNotification, docs, ["public_id"]);
  const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0);
  const counter = await advanceCounter("user_notifications", maxId);
  return { pg: rows.length, ...stats, counter };
}

async function importBroadcasts() {
  const { rows } = await pool.query(
    `SELECT id, title, body, severity, audience_type, audience_roles, audience_role_ids,
            created_by_admin_id, is_active, sent_at, created_at, updated_at
     FROM broadcasts ORDER BY id`
  );
  const docs = rows.map((row) => ({
    public_id: Number(row.id),
    title: String(row.title),
    body: String(row.body),
    severity: String(row.severity),
    audience_type: String(row.audience_type),
    audience_roles: nullToUndefined(row.audience_roles),
    audience_role_ids: nullToUndefined(
      row.audience_role_ids == null ? row.audience_role_ids : row.audience_role_ids.map(Number)
    ),
    created_by_admin_id: Number(row.created_by_admin_id),
    is_active: row.is_active != null ? Boolean(row.is_active) : true,
    sent_at: row.sent_at ? new Date(row.sent_at) : null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  }));
  const stats = await upsertMany(Broadcast, docs, ["public_id"]);
  const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0);
  const counter = await advanceCounter("broadcasts", maxId);
  return { pg: rows.length, ...stats, counter };
}

async function importBroadcastDeliveries() {
  const broadcasts = await Broadcast.find({}, { _id: 1, public_id: 1 }).lean();
  const objectIdByPublicId = new Map(broadcasts.map((b) => [Number(b.public_id), b._id]));
  const { rows } = await pool.query(
    `SELECT broadcast_id, user_id, delivered_at, acknowledged_at
     FROM broadcast_user_deliveries`
  );
  const docs = [];
  const missingBroadcasts = new Set();
  for (const row of rows) {
    const broadcastPublicId = Number(row.broadcast_id);
    const objectId = objectIdByPublicId.get(broadcastPublicId);
    if (!objectId) {
      throw new Error(`Delivery references missing broadcast ${broadcastPublicId}`);
    }
    docs.push({
      broadcast_id: objectId,
      broadcast_public_id: broadcastPublicId,
      recipient_user_id: Number(row.user_id),
      delivered_at: new Date(row.delivered_at),
      acknowledged_at: row.acknowledged_at ? new Date(row.acknowledged_at) : null,
    });
  }
  const stats = await upsertMany(BroadcastDelivery, docs, [
    "broadcast_public_id",
    "recipient_user_id",
  ]);
  return { pg: rows.length, skipped: missingBroadcasts.size, ...stats };
}

async function importReportRuns() {
  const { rows } = await pool.query(
    `SELECT id, report_key, range_key, timezone, generated_by_admin_id, generated_at, payload_hash
     FROM admin_report_runs ORDER BY id`
  );
  const docs = rows.map((row) => ({
    public_id: Number(row.id),
    report_key: String(row.report_key),
    range_key: String(row.range_key),
    timezone: String(row.timezone),
    generated_by_admin_id: row.generated_by_admin_id == null ? null : Number(row.generated_by_admin_id),
    generated_at: new Date(row.generated_at),
    payload_hash: row.payload_hash == null ? null : String(row.payload_hash),
  }));
  const stats = await upsertMany(ReportRun, docs, ["public_id"]);
  const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0);
  const counter = await advanceCounter("admin_report_runs", maxId);
  return { pg: rows.length, ...stats, counter };
}

function normalize(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toHexString === "function") return value.toHexString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
  }
  return value;
}

export function compareImportedDocuments(expected, actual, keyFields) {
  const keyOf = (doc) => keyFields.map((key) => String(doc[key])).join("/");
  const remaining = new Map(actual.map((doc) => [keyOf(doc), doc]));
  const problems = [];
  if (remaining.size !== actual.length) problems.push("duplicate keys");
  for (const source of expected) {
    const key = keyOf(source);
    const target = remaining.get(key);
    if (!target) problems.push(`missing ${key}`);
    else {
      for (const field of Object.keys(source)) {
        if (!isDeepStrictEqual(normalize(source[field]), normalize(target[field]))) {
          problems.push(`${key} field ${field}`);
        }
      }
    }
    remaining.delete(key);
  }
  for (const key of remaining.keys()) problems.push(`unexpected ${key}`);
  return problems;
}

async function verify() {
  const problems = [];
  const checks = [];
  for (const [model, { docs, keyFields }] of imported) {
    const actual = await model.find({}).lean();
    const differences = compareImportedDocuments(docs, actual, keyFields);
    checks.push({ label: model.modelName, ok: differences.length === 0 });
    problems.push(...differences.map((difference) => `${model.modelName}: ${difference}`));
  }

  // Counters must cover the imported maximums.
  const maxes = await pool.query(
    `SELECT (SELECT COALESCE(max(id),0) FROM notifications) AS a,
            (SELECT COALESCE(max(id),0) FROM user_notifications) AS b,
            (SELECT COALESCE(max(id),0) FROM broadcasts) AS c,
            (SELECT COALESCE(max(id),0) FROM admin_report_runs) AS d`
  );
  const expected = {
    notifications: Number(maxes.rows[0].a),
    user_notifications: Number(maxes.rows[0].b),
    broadcasts: Number(maxes.rows[0].c),
    admin_report_runs: Number(maxes.rows[0].d),
  };
  for (const [key, floor] of Object.entries(expected)) {
    const doc = await Counter.findById(key).lean();
    const seq = Number(doc?.seq ?? 0);
    const ok = seq >= floor;
    checks.push({ label: `counter ${key}>=${floor}`, seq, ok });
    if (!ok) problems.push(`counter ${key}=${seq} below imported max ${floor}`);
  }

  return { checks, problems };
}

async function main() {
  await connectMongo();
  try {
    await Promise.all([AdminNotification, UserNotification, Broadcast, BroadcastDelivery, ReportRun, Counter].map((model) => model.init()));
    const summary = {
      notifications: await importAdminNotifications(),
      user_notifications: await importUserNotifications(),
      broadcasts: await importBroadcasts(),
    };
    summary.broadcast_user_deliveries = await importBroadcastDeliveries();
    summary.admin_report_runs = await importReportRuns();

    const { checks, problems } = await verify();

    for (const [domain, stats] of Object.entries(summary)) {
      console.log(
        `IMPORT ${domain} pg=${stats.pg} upserted=${stats.upserted ?? 0} modified=${stats.modified ?? 0}` +
          (stats.skipped ? ` skipped=${stats.skipped}` : "") +
          (stats.counter != null ? ` counter=${stats.counter}` : "")
      );
    }
    const failed = checks.filter((c) => !c.ok);
    console.log(`VERIFY pass=${checks.length - failed.length} fail=${failed.length}`);
    for (const check of checks.filter((c) => !c.ok)) {
      console.log(`VERIFY FAIL ${check.label}`);
    }

    if (problems.length > 0) {
      for (const problem of problems) console.error(`VERIFY FAIL ${problem}`);
      console.error(`Migration verification failed with ${problems.length} problem(s)`);
      process.exitCode = 1;
    } else {
      console.log("Migration import + verification complete");
    }
  } finally {
    await disconnectMongo().catch(() => {});
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Migration import failed");
    process.exit(1);
  });
}
