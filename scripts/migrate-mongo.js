// One-shot, rerunnable PG -> Mongo historical import for the five migrating domains.
// Explicit maintenance command only: `npm run mongo:import`.
// - PG is read with SELECT only; nothing is written back to PostgreSQL.
// - Every write is an upsert on a stable key, so reruns change nothing.
// - Counters advance to at least the imported maximum and never decrease.
// - Never run a PG reimport automatically after MongoDB becomes authoritative.
import "dotenv/config";
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
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  return {};
}

function nullToUndefined(value) {
  return value == null ? undefined : value;
}

async function upsertMany(model, docs, keyFields) {
  if (docs.length === 0) return { upserted: 0, modified: 0, matched: 0 };
  const ops = docs.map((doc) => {
    const filter = {};
    for (const key of keyFields) filter[key] = doc[key];
    return { updateOne: { filter, update: { $set: doc }, upsert: true } };
  });
  const result = await model.bulkWrite(ops, { ordered: false });
  return {
    upserted: result.upsertedCount ?? 0,
    modified: result.modifiedCount ?? 0,
    matched: result.matchedCount ?? 0,
  };
}

// Advance a counter to at least `floor` without ever decreasing it.
async function advanceCounter(key, floor) {
  const current = await Counter.findById(key).lean();
  const next = Math.max(Number(current?.seq ?? 0), Number(floor ?? 0));
  await Counter.findOneAndUpdate(
    { _id: key },
    { $set: { seq: next } },
    { upsert: true }
  );
  return next;
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
      missingBroadcasts.add(broadcastPublicId);
      continue;
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

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

async function verify() {
  const problems = [];
  const checks = [];

  async function checkCount(label, pgTable, mongoModel) {
    const pg = await pool.query(`SELECT count(*) AS n FROM ${pgTable}`);
    const pgCount = Number(pg.rows[0].n);
    const mongoCount = await mongoModel.countDocuments();
    const ok = pgCount === mongoCount;
    checks.push({ label, pg: pgCount, mongo: mongoCount, ok });
    if (!ok) problems.push(`${label}: PG=${pgCount} Mongo=${mongoCount}`);
  }

  await checkCount("notifications", "notifications", AdminNotification);
  await checkCount("user_notifications", "user_notifications", UserNotification);
  await checkCount("broadcasts", "broadcasts", Broadcast);
  await checkCount("broadcast_user_deliveries", "broadcast_user_deliveries", BroadcastDelivery);
  await checkCount("admin_report_runs", "admin_report_runs", ReportRun);

  // Spot-check key fields on the first rows of each domain.
  const notif = await pool.query(
    `SELECT id, recipient_admin_id, type, title, is_read, created_at FROM notifications ORDER BY id LIMIT 3`
  );
  for (const row of notif.rows) {
    const doc = await AdminNotification.findOne({ public_id: Number(row.id) }).lean();
    const ok =
      doc != null &&
      doc.recipient_admin_id === Number(row.recipient_admin_id) &&
      doc.type === String(row.type) &&
      doc.title === String(row.title) &&
      doc.is_read === Boolean(row.is_read) &&
      iso(doc.created_at) === iso(row.created_at);
    checks.push({ label: `notifications#${row.id} fields`, ok });
    if (!ok) problems.push(`notifications#${row.id} field mismatch`);
  }

  const inbox = await pool.query(
    `SELECT id, recipient_user_id, is_read, created_at FROM user_notifications ORDER BY id LIMIT 3`
  );
  for (const row of inbox.rows) {
    const doc = await UserNotification.findOne({ public_id: Number(row.id) }).lean();
    const ok =
      doc != null &&
      doc.recipient_user_id === Number(row.recipient_user_id) &&
      doc.is_read === Boolean(row.is_read) &&
      iso(doc.created_at) === iso(row.created_at);
    checks.push({ label: `user_notifications#${row.id} fields`, ok });
    if (!ok) problems.push(`user_notifications#${row.id} field mismatch`);
  }

  const casts = await pool.query(
    `SELECT id, severity, audience_type, sent_at FROM broadcasts ORDER BY id LIMIT 5`
  );
  for (const row of casts.rows) {
    const doc = await Broadcast.findOne({ public_id: Number(row.id) }).lean();
    const ok =
      doc != null &&
      doc.severity === String(row.severity) &&
      doc.audience_type === String(row.audience_type) &&
      iso(doc.sent_at) === iso(row.sent_at);
    checks.push({ label: `broadcasts#${row.id} fields`, ok });
    if (!ok) problems.push(`broadcasts#${row.id} field mismatch`);
  }

  // Delivery recipient sets must match per broadcast.
  const deliveryCounts = await pool.query(
    `SELECT broadcast_id, count(*) AS n FROM broadcast_user_deliveries GROUP BY broadcast_id ORDER BY broadcast_id`
  );
  for (const row of deliveryCounts.rows) {
    const n = await BroadcastDelivery.countDocuments({
      broadcast_public_id: Number(row.broadcast_id),
    });
    const ok = n === Number(row.n);
    checks.push({ label: `deliveries broadcast#${row.broadcast_id}`, pg: Number(row.n), mongo: n, ok });
    if (!ok) problems.push(`deliveries broadcast#${row.broadcast_id}: PG=${row.n} Mongo=${n}`);
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

main().catch((err) => {
  console.error("Migration import failed");
  process.exit(1);
});
