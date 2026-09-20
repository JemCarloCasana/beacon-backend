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
import { runPreflight } from "./mongo-preflight.js";
import { AdminNotification } from "../src/models/AdminNotification.js";
import { UserNotification } from "../src/models/UserNotification.js";
import { Broadcast } from "../src/models/Broadcast.js";
import { BroadcastDelivery } from "../src/models/BroadcastDelivery.js";
import { ReportRun } from "../src/models/ReportRun.js";
import { Counter } from "../src/models/Counter.js";
import { UserProfile, AdminAccount, Role, Permission, EmergencyContact, FriendRequest, Friendship, Device, AdminAccessRequest } from "../src/models/Remaining.js";

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
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: false }
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

async function importIdentity() {
  const users = (await pool.query("SELECT id, firebase_uid, full_name, email, phone_number, profile_image_url, role, status, beacon_code, created_at, updated_at FROM users ORDER BY id")).rows;
  const roles = (await pool.query("SELECT id, name, description FROM roles ORDER BY id")).rows;
  const permissions = (await pool.query("SELECT id, name, description FROM permissions ORDER BY id")).rows;
  const grants = (await pool.query("SELECT role_id, permission_id FROM role_permissions")).rows;
  const names = new Map(permissions.map((p) => [Number(p.id), p.name]));
  const grantsByRole = new Map();
  for (const grant of grants) {
    const key = Number(grant.role_id);
    if (!grantsByRole.has(key)) grantsByRole.set(key, []);
    grantsByRole.get(key).push(names.get(Number(grant.permission_id)));
  }
  // The deployed admins table has no updated_at column; created_at is the only
  // available account timestamp and is preserved for the MongoDB field.
  const admins = (await pool.query("SELECT a.id, a.email, a.password_hash, a.full_name, a.role_id, a.status, a.created_at, r.name AS role FROM admins a JOIN roles r ON r.id = a.role_id ORDER BY a.id")).rows;
  const contacts = (await pool.query("SELECT id, owner_user_id, contact_name, phone_number, relation, is_primary, created_at, updated_at FROM emergency_contacts ORDER BY id")).rows;
  const requests = (await pool.query("SELECT id, requester_user_id, addressee_user_id, status, created_at, updated_at FROM friend_requests ORDER BY id")).rows;
  const friendships = (await pool.query("SELECT user_id, friend_user_id, created_at FROM friendships ORDER BY user_id, friend_user_id")).rows;
  const devices = (await pool.query("SELECT id, user_id, fcm_token, platform, created_at, updated_at FROM devices ORDER BY id")).rows;
  const accessRequests = (await pool.query("SELECT id, personnel_id, requested_by_admin_id, status, note, decision_note, created_at, updated_at, reviewed_at, reviewed_by_admin_id FROM admin_requests ORDER BY id")).rows;
  const summary = {};
  summary.users = await upsertMany(UserProfile, users.map((r) => ({ public_id: Number(r.id), firebase_uid: r.firebase_uid, full_name: r.full_name, email: r.email, phone_number: r.phone_number, profile_image_url: r.profile_image_url, role: r.role, status: r.status, beacon_code: r.beacon_code, created_at: r.created_at, updated_at: r.updated_at })), ["public_id"]);
  summary.roles = await upsertMany(Role, roles.map((r) => ({ public_id: Number(r.id), name: r.name, description: r.description })), ["public_id"]);
  summary.permissions = await upsertMany(Permission, permissions.map((r) => ({ public_id: Number(r.id), name: r.name, description: r.description })), ["public_id"]);
  summary.admins = await upsertMany(AdminAccount, admins.map((r) => ({ public_id: Number(r.id), email: r.email, password_hash: r.password_hash, full_name: r.full_name, role_id: Number(r.role_id), role: r.role, status: r.status, permission_names: (grantsByRole.get(Number(r.role_id)) ?? []).filter(Boolean), created_at: r.created_at, updated_at: r.created_at })), ["public_id"]);
  summary.contacts = await upsertMany(EmergencyContact, contacts.map((r) => ({ public_id: Number(r.id), owner_user_id: Number(r.owner_user_id), contact_name: r.contact_name, phone_number: r.phone_number, relation: r.relation, is_primary: r.is_primary, created_at: r.created_at, updated_at: r.updated_at })), ["public_id"]);
  summary.friend_requests = await upsertMany(FriendRequest, requests.map((r) => ({ public_id: Number(r.id), requester_user_id: Number(r.requester_user_id), addressee_user_id: Number(r.addressee_user_id), status: r.status, created_at: r.created_at, updated_at: r.updated_at })), ["public_id"]);
  summary.friendships = await upsertMany(Friendship, friendships.map((r) => ({ user_id: Number(r.user_id), friend_user_id: Number(r.friend_user_id), created_at: r.created_at })), ["user_id", "friend_user_id"]);
  summary.devices = await upsertMany(Device, devices.map((r) => ({ public_id: Number(r.id), user_id: Number(r.user_id), fcm_token: r.fcm_token, platform: r.platform, is_active: true, created_at: r.created_at, updated_at: r.updated_at })), ["public_id"]);
  summary.admin_access_requests = await upsertMany(AdminAccessRequest, accessRequests.map((r) => ({ public_id: Number(r.id), personnel_admin_id: Number(r.personnel_id), requested_by_admin_id: Number(r.requested_by_admin_id), status: r.status, note: r.note, decision_note: r.decision_note, created_at: r.created_at, updated_at: r.updated_at, reviewed_at: r.reviewed_at, reviewed_by_admin_id: r.reviewed_by_admin_id })), ["public_id"]);
  const maxes = [
    ["users", users], ["roles", roles], ["permissions", permissions], ["admins", admins],
    ["contacts", contacts], ["friend_requests", requests], ["devices", devices],
    ["admin_access_requests", accessRequests],
  ];
  for (const [name, rows] of maxes) {
    const max = rows.reduce((value, row) => Math.max(value, Number(row.id)), 0);
    const counterKey = name === "admin_access_requests" ? "admin_requests" : name;
    summary[name].counter = await advanceCounter(counterKey, max);
  }
  return summary;
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
        const sourceValue = source[field];
        const targetValue = target[field];
        const nullableIdEqual = field.endsWith("_id") && sourceValue == null && targetValue == null;
        const numericIdEqual = field.endsWith("_id") && sourceValue != null && targetValue != null && Number(sourceValue) === Number(targetValue);
        if (!nullableIdEqual && !numericIdEqual && !isDeepStrictEqual(normalize(sourceValue), normalize(targetValue))) {
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
            (SELECT COALESCE(max(id),0) FROM admin_report_runs) AS d,
            (SELECT COALESCE(max(id),0) FROM users) AS users,
            (SELECT COALESCE(max(id),0) FROM roles) AS roles,
            (SELECT COALESCE(max(id),0) FROM permissions) AS permissions,
            (SELECT COALESCE(max(id),0) FROM admins) AS admins,
            (SELECT COALESCE(max(id),0) FROM emergency_contacts) AS contacts,
            (SELECT COALESCE(max(id),0) FROM friend_requests) AS friend_requests,
            (SELECT COALESCE(max(id),0) FROM devices) AS devices,
            (SELECT COALESCE(max(id),0) FROM admin_requests) AS admin_requests`
  );
  const expected = {
    notifications: Number(maxes.rows[0].a),
    user_notifications: Number(maxes.rows[0].b),
    broadcasts: Number(maxes.rows[0].c),
    admin_report_runs: Number(maxes.rows[0].d),
    users: Number(maxes.rows[0].users), roles: Number(maxes.rows[0].roles), permissions: Number(maxes.rows[0].permissions),
    admins: Number(maxes.rows[0].admins), contacts: Number(maxes.rows[0].contacts), friend_requests: Number(maxes.rows[0].friend_requests),
    devices: Number(maxes.rows[0].devices), admin_requests: Number(maxes.rows[0].admin_requests),
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
  await runPreflight();
  await connectMongo({ dbName: process.env.MONGO_DISPOSABLE_DB_NAME });
  try {
    await Promise.all([AdminNotification, UserNotification, Broadcast, BroadcastDelivery, ReportRun, Counter, UserProfile, AdminAccount, Role, Permission, EmergencyContact, FriendRequest, Friendship, Device, AdminAccessRequest].map((model) => model.init()));
    const summary = {
      identity: await importIdentity(),
      notifications: await importAdminNotifications(),
      user_notifications: await importUserNotifications(),
      broadcasts: await importBroadcasts(),
    };
    summary.broadcast_user_deliveries = await importBroadcastDeliveries();
    summary.admin_report_runs = await importReportRuns();

    const { checks, problems } = await verify();

    for (const [domain, stats] of Object.entries(summary)) {
      if (domain === "identity") {
        for (const [identityDomain, identityStats] of Object.entries(stats)) {
          console.log(
            `IMPORT ${identityDomain} pg=${identityStats.pg} upserted=${identityStats.upserted ?? 0} modified=${identityStats.modified ?? 0}` +
              (identityStats.skipped ? ` skipped=${identityStats.skipped}` : "") +
              (identityStats.counter != null ? ` counter=${identityStats.counter}` : "")
          );
        }
        continue;
      }
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
  main().catch((error) => {
    console.error("Migration import failed", error?.message || error);
    if (process.env.MIGRATION_DEBUG === "1") console.error(error?.stack || error);
    process.exit(1);
  });
}
