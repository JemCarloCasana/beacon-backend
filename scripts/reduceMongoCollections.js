import "dotenv/config";
import { MongoClient } from "mongodb";

const COLLECTIONS = [
  "user_profiles", "admin_accounts", "roles", "permissions", "emergency_contacts", "devices",
  "friend_requests", "friendships", "sos_threads", "sos_events", "incident_reports",
  "incident_evidence", "admin_access_requests", "broadcasts", "broadcast_user_deliveries",
  "notifications", "user_notifications", "admin_report_runs", "counters",
];

const TARGET_COLLECTIONS = [
  "user_profiles", "admin_records", "friend_connections", "sos_records", "incident_reports",
  "broadcasts", "notifications", "admin_report_runs",
];

const TARGET_INDEXES = {
  user_profiles: [
    [{ firebase_uid: 1 }, { unique: true }],
    [{ email: 1 }, { unique: true }],
    [{ beacon_code: 1 }, { unique: true, sparse: true }],
  ],
  admin_records: [
    [{ email: 1 }, { unique: true, partialFilterExpression: { record_type: "account" } }],
    [{ personnel_admin_id: 1, status: 1, created_at: -1 }, { partialFilterExpression: { record_type: "access_request" } }],
  ],
  friend_connections: [
    [{ user_ids: 1, record_type: 1, status: 1, created_at: -1 }, {}],
    [{ requested_by: 1, status: 1, created_at: -1 }, {}],
  ],
  sos_records: [
    [{ record_type: 1, latest_status: 1, updated_at: -1 }, {}],
    [{ record_type: 1, thread_id: 1, created_at: -1 }, {}],
    [{ record_type: 1, sos_id: 1, created_at: -1 }, {}],
  ],
  incident_reports: [
    [{ status: 1, created_at: -1 }, {}],
    [{ priority: 1, created_at: -1 }, {}],
    [{ user_id: 1, created_at: -1 }, {}],
  ],
  broadcasts: [
    [{ created_at: -1 }, {}],
    [{ sent_at: -1 }, {}],
  ],
  notifications: [
    [{ recipient_type: 1, recipient_id: 1, created_at: -1 }, {}],
    [{ source: 1 }, {}],
    [{ "source.id": 1, recipient_id: 1 }, { unique: true, partialFilterExpression: { record_type: "broadcast_delivery" } }],
  ],
  admin_report_runs: [
    [{ report_key: 1, range_key: 1, timezone: 1, generated_at: -1 }, {}],
    [{ generated_at: -1 }, {}],
  ],
};

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function publicIdMap(docs) {
  return new Map(docs.map((doc) => [Number(doc.public_id), doc._id]));
}

function ref(map, value, label) {
  const id = map.get(Number(value));
  if (!id) throw new Error(`Unresolved relationship: ${label}`);
  return id;
}

function without(doc, ...fields) {
  const copy = { ...doc };
  for (const field of fields) delete copy[field];
  return copy;
}

function orderedPair(a, b) {
  return [a, b].sort((left, right) => left.toHexString().localeCompare(right.toHexString()));
}

async function readSource(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
  const missing = COLLECTIONS.filter((name) => !existing.has(name));
  if (missing.length) throw new Error(`Source is missing expected collections: ${missing.join(", ")}`);
  const data = {};
  for (const name of COLLECTIONS) data[name] = await db.collection(name).find({}).toArray();
  return data;
}

function mapData(source) {
  const users = publicIdMap(source.user_profiles);
  const admins = publicIdMap(source.admin_accounts);
  const events = publicIdMap(source.sos_events);
  const threads = publicIdMap(source.sos_threads);
  const broadcasts = publicIdMap(source.broadcasts);
  const reports = publicIdMap(source.incident_reports);
  const roleByName = new Map(source.roles.map((item) => [String(item.name).toLowerCase(), item]));
  const permissionByName = new Map(source.permissions.map((item) => [String(item.name), item]));
  const contactsByUser = new Map();
  const devicesByUser = new Map();
  const evidenceByReport = new Map();

  for (const item of source.emergency_contacts) {
    const ownerId = ref(users, item.owner_user_id, "emergency contact owner");
    const key = ownerId.toHexString();
    const value = without(item, "public_id", "owner_user_id");
    (contactsByUser.get(key) ?? contactsByUser.set(key, []).get(key)).push(value);
  }
  for (const item of source.devices) {
    const ownerId = ref(users, item.user_id, "device owner");
    const key = ownerId.toHexString();
    const value = without(item, "public_id", "user_id");
    (devicesByUser.get(key) ?? devicesByUser.set(key, []).get(key)).push(value);
  }
  for (const item of source.incident_evidence) {
    const reportId = ref(reports, item.incident_report_id, "incident evidence parent");
    const key = reportId.toHexString();
    const value = without(item, "public_id", "incident_report_id");
    (evidenceByReport.get(key) ?? evidenceByReport.set(key, []).get(key)).push(value);
  }

  const userProfiles = source.user_profiles.map((item) => ({
    ...without(item, "public_id"),
    emergency_contacts: contactsByUser.get(item._id.toHexString()) ?? [],
    devices: devicesByUser.get(item._id.toHexString()) ?? [],
  }));

  const adminRecords = source.admin_accounts.map((item) => {
    const role = roleByName.get(String(item.role).toLowerCase()) ?? source.roles.find((row) => Number(row.public_id) === Number(item.role_id));
    if (!role) throw new Error("Unresolved relationship: admin role");
    const permissions = item.permission_names ?? [];
    return {
      ...without(item, "public_id", "role_id", "permission_names"),
      record_type: "account",
      role: role.name,
      role_definition: without(role, "_id", "public_id"),
      permissions,
      permission_definitions: permissions.map((name) => {
        const definition = permissionByName.get(name);
        return definition ? without(definition, "_id", "public_id") : { name };
      }),
    };
  });
  for (const item of source.admin_access_requests) {
    adminRecords.push({
      ...without(item, "public_id", "personnel_admin_id", "requested_by_admin_id", "reviewed_by_admin_id"),
      record_type: "access_request",
      personnel_admin_id: ref(admins, item.personnel_admin_id, "access request personnel"),
      requested_by_admin_id: ref(admins, item.requested_by_admin_id, "access request creator"),
      ...(item.reviewed_by_admin_id == null ? {} : { reviewed_by_admin_id: ref(admins, item.reviewed_by_admin_id, "access request reviewer") }),
    });
  }

  const friendConnections = source.friend_requests.map((item) => {
    const requestedBy = ref(users, item.requester_user_id, "friend request sender");
    const recipient = ref(users, item.addressee_user_id, "friend request recipient");
    return {
      ...without(item, "public_id", "requester_user_id", "addressee_user_id"),
      record_type: "request",
      user_ids: orderedPair(requestedBy, recipient),
      requested_by: requestedBy,
      recipient,
      ...(item.status === "accepted" ? { accepted_at: item.updated_at ?? item.created_at } : {}),
    };
  });
  for (const item of source.friendships) {
    const user = ref(users, item.user_id, "friendship user");
    const friend = ref(users, item.friend_user_id, "friendship peer");
    friendConnections.push({ _id: item._id, record_type: "friendship", user_ids: orderedPair(user, friend), created_at: item.created_at });
  }

  const sosRecords = source.sos_threads.map((item) => ({
    ...without(item, "public_id", "user_id", "root_event_id", "acknowledged_by_admin_id"),
    record_type: "case",
    user_id: ref(users, item.user_id, "SOS case owner"),
    root_event_id: ref(events, item.root_event_id, "SOS root event"),
    ...(item.acknowledged_by_admin_id == null ? {} : { acknowledged_by_admin_id: ref(admins, item.acknowledged_by_admin_id, "SOS acknowledging admin") }),
  }));
  for (const item of source.sos_events) {
    sosRecords.push({
      ...without(item, "public_id", "user_id", "sos_id", "thread_id", "actor_admin_id"),
      record_type: "event",
      user_id: ref(users, item.user_id, "SOS event user"),
      sos_id: ref(events, item.sos_id, "SOS event root"),
      thread_id: ref(threads, item.thread_id, "SOS event case"),
      ...(item.actor_admin_id == null ? {} : { actor_admin_id: ref(admins, item.actor_admin_id, "SOS event admin actor") }),
    });
  }

  const incidentReports = source.incident_reports.map((item) => ({
    ...without(item, "public_id", "user_id", "assigned_admin_id"),
    user_id: ref(users, item.user_id, "incident report owner"),
    evidence: (evidenceByReport.get(item._id.toHexString()) ?? []).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
  }));

  const broadcastDocs = source.broadcasts.map((item) => {
    const audienceRoles = item.audience_roles ?? (item.audience_role_ids ?? []).map((id) => {
      const role = source.roles.find((row) => Number(row.public_id) === Number(id));
      if (!role) throw new Error("Unresolved relationship: broadcast audience role");
      return role.name;
    });
    return {
      ...without(item, "public_id", "created_by_admin_id", "audience_role_ids"),
      created_by_admin_id: ref(admins, item.created_by_admin_id, "broadcast creator"),
      ...(audienceRoles.length ? { audience_roles: audienceRoles } : {}),
    };
  });

  const notifications = [];
  for (const item of source.notifications) notifications.push({
    ...without(item, "public_id", "recipient_admin_id"),
    record_type: "admin",
    recipient_type: "admin",
    recipient_id: ref(admins, item.recipient_admin_id, "admin notification recipient"),
  });
  for (const item of source.user_notifications) notifications.push({
    ...without(item, "public_id", "recipient_user_id"),
    record_type: "user",
    recipient_type: "user",
    recipient_id: ref(users, item.recipient_user_id, "user notification recipient"),
  });
  for (const item of source.broadcast_user_deliveries) {
    const broadcastId = item.broadcast_id ?? ref(broadcasts, item.broadcast_public_id, "broadcast delivery source");
    const broadcast = source.broadcasts.find((row) => row._id.equals(broadcastId));
    if (!broadcast) throw new Error("Unresolved relationship: broadcast delivery source");
    notifications.push({
      _id: item._id,
      record_type: "broadcast_delivery",
      recipient_type: "user",
      recipient_id: ref(users, item.recipient_user_id, "broadcast delivery recipient"),
      type: "broadcast",
      title: broadcast.title,
      message: broadcast.body,
      source: { type: "broadcast", id: broadcastId },
      is_read: item.acknowledged_at != null,
      delivered_at: item.delivered_at,
      acknowledged_at: item.acknowledged_at,
      created_at: item.delivered_at,
    });
  }

  const reportRuns = source.admin_report_runs.map((item) => ({
    ...without(item, "public_id", "generated_by_admin_id"),
    ...(item.generated_by_admin_id == null ? {} : { generated_by_admin_id: ref(admins, item.generated_by_admin_id, "report run admin") }),
  }));

  return {
    user_profiles: userProfiles,
    admin_records: adminRecords,
    friend_connections: friendConnections,
    sos_records: sosRecords,
    incident_reports: incidentReports,
    broadcasts: broadcastDocs,
    notifications,
    admin_report_runs: reportRuns,
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  const sourceName = arg("source") ?? "Beacon-Admin";
  const targetName = arg("target");
  const apply = process.argv.includes("--apply");
  if (!uri) throw new Error("MONGODB_URI is not configured");
  if (!targetName || !/^Beacon-Admin_reduction_[a-z0-9_-]+$/i.test(targetName) || targetName === sourceName) {
    throw new Error("Pass a unique --target=Beacon-Admin_reduction_<run> database name");
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const source = await readSource(client.db(sourceName));
    const mapped = mapData(source);
    const sourceCounts = Object.fromEntries(COLLECTIONS.map((name) => [name, source[name].length]));
    const targetCounts = Object.fromEntries(TARGET_COLLECTIONS.map((name) => [name, mapped[name].length]));
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", source: sourceName, target: targetName, sourceCounts, targetCounts }, null, 2));
    if (!apply) return;

    const knownDbs = await client.db("admin").admin().listDatabases({ nameOnly: true });
    if (knownDbs.databases.some((db) => db.name === targetName)) throw new Error("Target database already exists; choose a new run name");
    const target = client.db(targetName);
    try {
      for (const name of TARGET_COLLECTIONS) {
        if (mapped[name].length) await target.collection(name).insertMany(mapped[name], { ordered: true });
        else await target.createCollection(name);
        for (const [keys, options] of TARGET_INDEXES[name]) await target.collection(name).createIndex(keys, options);
      }
      const restoredCounts = {};
      for (const name of TARGET_COLLECTIONS) restoredCounts[name] = await target.collection(name).countDocuments();
      if (JSON.stringify(targetCounts) !== JSON.stringify(restoredCounts)) throw new Error("Target collection counts do not match migration output");
      console.log(JSON.stringify({ verified: true, restoredCounts }, null, 2));
    } catch (error) {
      await target.dropDatabase();
      throw error;
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ migration: "failed", name: error.name, message: error.message }));
  process.exitCode = 1;
});
