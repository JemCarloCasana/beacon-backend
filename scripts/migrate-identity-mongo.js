import "dotenv/config";
import { pool } from "../src/db.js";
import { connectMongo, disconnectMongo } from "../src/mongo.js";
import { runPreflight } from "./mongo-preflight.js";
import { Counter } from "../src/models/Counter.js";
import {
  UserProfile, AdminAccount, Role, Permission, EmergencyContact,
  FriendRequest, Friendship, Device,
} from "../src/models/Remaining.js";

const counters = new Map();
const next = async (key, value) => {
  const current = counters.get(key) ?? 0;
  if (value > current) counters.set(key, value);
};

async function upsertRows(Model, rows, key, transform) {
  for (const row of rows) {
    const document = transform(row);
    await Model.updateOne({ public_id: document.public_id }, { $set: document }, { upsert: true, runValidators: true });
    await next(key, document.public_id);
  }
}

async function migrate() {
  await runPreflight();
  await connectMongo({ dbName: process.env.MONGO_DISPOSABLE_DB_NAME });
  const client = await pool.connect();
  try {
    const users = (await client.query("SELECT id, firebase_uid, full_name, email, phone_number, profile_image_url, role, status, beacon_code, created_at, updated_at FROM users")).rows;
    await upsertRows(UserProfile, users, "users", (r) => ({ public_id: Number(r.id), firebase_uid: r.firebase_uid, full_name: r.full_name, email: r.email, phone_number: r.phone_number, profile_image_url: r.profile_image_url, role: r.role, status: r.status, beacon_code: r.beacon_code, created_at: r.created_at, updated_at: r.updated_at }));

    const roles = (await client.query("SELECT id, name, description FROM roles")).rows;
    await upsertRows(Role, roles, "roles", (r) => ({ public_id: Number(r.id), name: r.name, description: r.description }));
    const permissions = (await client.query("SELECT id, name, description FROM permissions")).rows;
    await upsertRows(Permission, permissions, "permissions", (r) => ({ public_id: Number(r.id), name: r.name, description: r.description }));

    const grants = (await client.query("SELECT role_id, permission_id FROM role_permissions")).rows;
    const grantsByRole = new Map();
    for (const grant of grants) (grantsByRole.get(Number(grant.role_id)) ?? grantsByRole.set(Number(grant.role_id), []).get(Number(grant.role_id))).push(Number(grant.permission_id));
    const admins = (await client.query("SELECT a.id, a.email, a.password_hash, a.full_name, a.role_id, a.status, a.created_at, r.name AS role FROM admins a JOIN roles r ON r.id = a.role_id")).rows;
    const permissionNames = new Map(permissions.map((p) => [Number(p.id), p.name]));
    await upsertRows(AdminAccount, admins, "admins", (r) => ({ public_id: Number(r.id), email: r.email, password_hash: r.password_hash, full_name: r.full_name, role_id: Number(r.role_id), role: r.role, status: r.status, permission_names: (grantsByRole.get(Number(r.role_id)) ?? []).map((id) => permissionNames.get(id)).filter(Boolean), created_at: r.created_at, updated_at: r.created_at }));

    const contacts = (await client.query("SELECT id, owner_user_id, contact_name, phone_number, relation, is_primary, created_at, updated_at FROM emergency_contacts")).rows;
    await upsertRows(EmergencyContact, contacts, "emergency_contacts", (r) => ({ public_id: Number(r.id), owner_user_id: Number(r.owner_user_id), contact_name: r.contact_name, phone_number: r.phone_number, relation: r.relation, is_primary: r.is_primary, created_at: r.created_at, updated_at: r.updated_at }));
    const requests = (await client.query("SELECT id, requester_user_id, addressee_user_id, status, created_at, updated_at FROM friend_requests")).rows;
    await upsertRows(FriendRequest, requests, "friend_requests", (r) => ({ public_id: Number(r.id), requester_user_id: Number(r.requester_user_id), addressee_user_id: Number(r.addressee_user_id), status: r.status, created_at: r.created_at, updated_at: r.updated_at }));
    const friendships = (await client.query("SELECT user_id, friend_user_id, created_at FROM friendships")).rows;
    for (const row of friendships) await Friendship.updateOne({ user_id: Number(row.user_id), friend_user_id: Number(row.friend_user_id) }, { $set: { user_id: Number(row.user_id), friend_user_id: Number(row.friend_user_id), created_at: row.created_at } }, { upsert: true, runValidators: true });
    const devices = (await client.query("SELECT id, user_id, fcm_token, platform, created_at, updated_at FROM devices")).rows;
    await upsertRows(Device, devices, "devices", (r) => ({ public_id: Number(r.id), user_id: Number(r.user_id), fcm_token: r.fcm_token, platform: r.platform, is_active: true, created_at: r.created_at, updated_at: r.updated_at }));

    for (const [key, value] of counters) {
      await Counter.updateOne({ _id: key }, { $max: { seq: value } }, { upsert: true });
    }
    console.log(JSON.stringify({ migrated: { users: users.length, roles: roles.length, permissions: permissions.length, admins: admins.length, contacts: contacts.length, friend_requests: requests.length, friendships: friendships.length, devices: devices.length }, counters: Object.fromEntries(counters) }));
  } finally {
    client.release();
    await disconnectMongo();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error("identity Mongo migration failed", error?.message || error);
  process.exitCode = 1;
});
