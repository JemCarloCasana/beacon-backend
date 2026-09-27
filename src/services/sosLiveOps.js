import mongoose from "mongoose";
import { AdminRecord, ReducedUserProfile as UserProfile, SosRecord } from "../models/Reduced.js";
import { parseObjectId } from "../utils/objectId.js";

const VALID_STATUSES = new Set(["active", "resolved", "acknowledged", "cancelled", "safe"]);
const VALID_EVENT_TYPES = new Set(["report_created", "status_update", "admin_acknowledged", "note"]);
const VALID_LIVE_FILTERS = new Set(["open", "active", "resolved", "cancelled", "safe"]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

const sseState = {
  nextEventId: 1,
  subscribers: new Set(),
  buffer: [],
  metrics: {
    sos_admin_ack_total: 0,
    sos_admin_resolve_total: 0,
    sos_stream_replay_miss_total: 0
  }
};

function encodeCursorPayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursorPayload(cursor) {
  try {
    const text = Buffer.from(String(cursor), "base64url").toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeLiveStatus(status) {
  const value = typeof status === "string" ? status.trim().toLowerCase() : "open";
  if (!VALID_LIVE_FILTERS.has(value)) {
    return null;
  }
  return value;
}

function normalizeLimit(limit) {
  if (limit == null || limit === "") {
    return DEFAULT_LIMIT;
  }
  const num = Number(limit);
  if (!Number.isInteger(num) || num <= 0) {
    return null;
  }
  return Math.min(num, MAX_LIMIT);
}

function pruneReplayBuffer() {
  const minCreated = Date.now() - REPLAY_WINDOW_MS;
  sseState.buffer = sseState.buffer.filter((entry) => entry.createdAtMs >= minCreated);
}

function writeSseEvent(res, entry) {
  res.write(`id: ${entry.id}\n`);
  res.write(`event: ${entry.event}\n`);
  res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
}

function closeSubscriber(res) {
  if (sseState.subscribers.has(res)) {
    sseState.subscribers.delete(res);
  }
}

function nextSseId() {
  const id = sseState.nextEventId;
  sseState.nextEventId += 1;
  return id;
}

function withThreadAliases(row) {
  const acknowledgedAt = row.acknowledged_at ?? null;
  const assignedUnit = row.assigned_unit ?? null;
  return {
    ...row,
    acknowledged_at: acknowledgedAt,
    acknowledgedAt,
    assigned_unit: assignedUnit,
    assignedUnit
  };
}

export function parseLiveListParams(query) {
  const status = normalizeLiveStatus(query?.status);
  if (!status) {
    return { ok: false, message: "Invalid status filter" };
  }

  const limit = normalizeLimit(query?.limit);
  if (!limit) {
    return { ok: false, message: "Invalid limit" };
  }

  let cursor = null;
  if (query?.cursor) {
    const decoded = decodeCursorPayload(query.cursor);
    const parsedSosId = parseObjectId(decoded?.sos_id);
    const parsedTimestamp = decoded?.latest_event_at ? new Date(decoded.latest_event_at) : null;
    if (!parsedSosId || Number.isNaN(parsedTimestamp?.getTime?.())) {
      return { ok: false, message: "Invalid cursor" };
    }
    cursor = {
      sos_id: parsedSosId.toString(),
      latest_event_at: parsedTimestamp.toISOString()
    };
  }

  return { ok: true, params: { status, limit, cursor } };
}

export async function listLiveThreads({ status = "open", limit = DEFAULT_LIMIT, cursor = null }) {
  const filter = status === "open" ? { latest_status: "active" } : status === "cancelled" || status === "safe" ? { latest_status: "resolved", terminal_status: status } : { latest_status: status };
  const threads = await SosRecord.find({ ...filter, record_type: "case" }).sort({ updated_at: -1, _id: -1 }).limit(limit + 1).lean();
  const userIds = [...new Map(threads.map((thread) => [thread.user_id.toString(), thread.user_id])).values()];
  const profiles = await UserProfile.find({ _id: { $in: userIds } }).lean();
  const byUser = new Map(profiles.map((profile) => [profile._id.toString(), profile]));
  const events = await SosRecord.find({ record_type: "event", thread_id: { $in: threads.map((thread) => thread._id) } }).sort({ created_at: -1, _id: -1 }).lean();
  const latestByThread = new Map();
  for (const event of events) if (!latestByThread.has(event.thread_id.toString())) latestByThread.set(event.thread_id.toString(), event);
  const eventById = new Map(events.map((event) => [event._id.toString(), event]));
  const rows = [];
  for (const thread of threads) {
    const root = eventById.get(thread.root_event_id.toString());
    const event = latestByThread.get(thread._id.toString()) ?? root;
    const profile = byUser.get(thread.user_id.toString());
    if (!profile || !event) continue;
    const row = withThreadAliases({ thread_id: thread._id.toString(), sos_id: thread.root_event_id.toString(), user_id: thread.user_id.toString(), full_name: profile.full_name, phone_number: profile.phone_number, role: profile.role, latest_status: thread.latest_status, emergency_category: thread.emergency_category, acknowledged_at: thread.acknowledged_at ?? null, assigned_unit: thread.assigned_unit ?? null, acknowledged_by_admin_id: thread.acknowledged_by_admin_id?.toString() ?? null, resolved_at: thread.resolved_at ?? null, terminal_status: thread.terminal_status ?? null, resolved_source: thread.resolved_source ?? null, opened_at: root?.created_at ?? thread.created_at, latest_message: event.message ?? null, latest_latitude: event.latitude ?? null, latest_longitude: event.longitude ?? null, latest_address: event.address ?? null, latest_event_at: event.created_at ?? thread.updated_at, requires_attention: thread.latest_status === "active" && !thread.acknowledged_at });
    if (cursor && (new Date(row.latest_event_at) > new Date(cursor.latest_event_at) || (new Date(row.latest_event_at).getTime() === new Date(cursor.latest_event_at).getTime() && row.sos_id >= cursor.sos_id))) continue;
    rows.push(row);
  }
  rows.sort((a, b) => new Date(b.latest_event_at) - new Date(a.latest_event_at) || b.sos_id.localeCompare(a.sos_id));
  let nextCursor = null;
  if (rows.length > limit) { const overflow = rows[limit - 1]; rows.length = limit; nextCursor = encodeCursorPayload({ latest_event_at: overflow.latest_event_at, sos_id: overflow.sos_id }); }
  return { rows, nextCursor };
}

export async function getThreadStateAnyStatus(sosId) {
  const rootId = parseObjectId(sosId);
  if (!rootId) return null;
  const thread = await SosRecord.findOne({ root_event_id: rootId, record_type: "case" }).lean();
  if (!thread) return null;
  const [profile, root, latest] = await Promise.all([
    UserProfile.findById(thread.user_id).lean(),
    SosRecord.findOne({ _id: rootId, record_type: "event" }).lean(),
    SosRecord.findOne({ thread_id: thread._id, record_type: "event" }).sort({ created_at: -1, _id: -1 }).lean(),
  ]);
  const event = latest || root;
  return withThreadAliases({ thread_id: thread._id.toString(), sos_id: thread.root_event_id.toString(), user_id: thread.user_id.toString(), full_name: profile?.full_name, phone_number: profile?.phone_number, role: profile?.role, latest_status: thread.latest_status, emergency_category: thread.emergency_category, acknowledged_at: thread.acknowledged_at ?? null, assigned_unit: thread.assigned_unit ?? null, acknowledged_by_admin_id: thread.acknowledged_by_admin_id?.toString() ?? null, resolved_at: thread.resolved_at ?? null, terminal_status: thread.terminal_status ?? null, resolved_source: thread.resolved_source ?? null, opened_at: root?.created_at ?? thread.created_at, latest_message: event?.message ?? null, latest_latitude: event?.latitude ?? null, latest_longitude: event?.longitude ?? null, latest_address: event?.address ?? null, latest_event_at: event?.created_at ?? thread.updated_at, requires_attention: thread.latest_status === "active" && !thread.acknowledged_at });
}

export async function listThreadEvents(sosId) {
  const rootId = parseObjectId(sosId);
  if (!rootId) return [];
  const [events, thread] = await Promise.all([
    SosRecord.find({ sos_id: rootId, record_type: "event" }).sort({ created_at: 1, _id: 1 }).lean(),
    SosRecord.findOne({ root_event_id: rootId, record_type: "case" }).lean(),
  ]);
  const adminIds = [...new Map(events.filter((event) => event.actor_admin_id).map((event) => [event.actor_admin_id.toString(), event.actor_admin_id])).values()];
  const admins = await AdminRecord.find({ _id: { $in: adminIds }, record_type: "account" }).select({ _id: 1, full_name: 1 }).lean();
  const names = new Map(admins.map((admin) => [admin._id.toString(), admin.full_name]));
  return events.map((event) => ({ id: event._id.toString(), thread_id: event.thread_id.toString(), sos_id: event.sos_id.toString(), user_id: event.user_id.toString(), status: event.status === "resolved" && event.actor_type === "user" && event.event_type === "status_update" && thread?.terminal_status ? thread.terminal_status : event.status, latitude: event.latitude, longitude: event.longitude, address: event.address, message: event.message, created_at: event.created_at, actor_type: event.actor_type, actor_name: event.actor_admin_id ? names.get(event.actor_admin_id.toString()) : null, actor_admin_id: event.actor_admin_id?.toString() ?? null, event_type: event.event_type, emergency_category: event.emergency_category }));
}

export async function listLiveMapRows() {
  const threads = await SosRecord.find({ record_type: "case", latest_status: "active" }).lean();
  const events = await SosRecord.find({ record_type: "event", thread_id: { $in: threads.map((thread) => thread._id) }, latitude: { $ne: null }, longitude: { $ne: null } }).sort({ created_at: -1, _id: -1 }).lean();
  const latestByThread = new Map();
  for (const event of events) if (!latestByThread.has(event.thread_id.toString())) latestByThread.set(event.thread_id.toString(), event);
  return threads.flatMap((thread) => {
    const event = latestByThread.get(thread._id.toString());
    return event ? [{ sos_id: thread.root_event_id.toString(), user_id: thread.user_id.toString(), latitude: event.latitude, longitude: event.longitude, address: event.address, message: event.message, status: thread.latest_status, created_at: event.created_at }] : [];
  });
}

export async function appendThreadStatusEvent({ thread, sosId, threadUpdates, event, createdAt = new Date() }) {
  const rootId = parseObjectId(sosId);
  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const latest = await SosRecord.findOne({ thread_id: thread._id, record_type: "event" })
        .sort({ created_at: -1, _id: -1 })
        .session(session)
        .lean();
      const result = await SosRecord.updateOne(
        { _id: thread._id, record_type: "case", latest_status: "active" },
        { $set: { ...threadUpdates, updated_at: createdAt } },
        { session }
      );
      if (result.modifiedCount !== 1) {
        throw Object.assign(new Error("SOS thread is no longer active"), { statusCode: 409 });
      }
      [created] = await SosRecord.create([{
        record_type: "event",
        thread_id: thread._id,
        sos_id: rootId,
        user_id: event.user_id ?? thread.user_id,
        latitude: latest?.latitude,
        longitude: latest?.longitude,
        address: latest?.address,
        ...(event.message == null ? {} : { message: event.message }),
        status: event.status,
        actor_type: event.actor_type,
        ...(event.actor_admin_id == null ? {} : { actor_admin_id: event.actor_admin_id }),
        event_type: event.event_type,
        emergency_category: event.emergency_category ?? thread.emergency_category,
        created_at: createdAt,
      }], { session });
    });
    return created;
  } finally {
    await session.endSession();
  }
}

export async function createSosThreadWithRootEvent({ event, thread }) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await SosRecord.create([{ ...event, record_type: "event" }], { session });
      await SosRecord.create([{ ...thread, record_type: "case" }], { session });
    });
  } finally {
    await session.endSession();
  }
}

export function isSseEnabled() {
  const value = String(process.env.ENABLE_ADMIN_SOS_STREAM ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

export function openSseStream(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  res.write(": connected\n\n");
}

export function subscribeSse(res) {
  sseState.subscribers.add(res);
  return () => closeSubscriber(res);
}

export function writeSnapshotToStream(res, rows) {
  const entry = {
    id: nextSseId(),
    event: "snapshot",
    data: rows
  };
  writeSseEvent(res, entry);
  return entry.id;
}

export function writeHeartbeat(res) {
  res.write(": heartbeat\n\n");
}

export function replaySince(lastEventId, res) {
  pruneReplayBuffer();
  const oldestId = sseState.buffer.length > 0 ? sseState.buffer[0].id : sseState.nextEventId;
  if (lastEventId < oldestId - 1) {
    sseState.metrics.sos_stream_replay_miss_total += 1;
    return { replayed: 0, missed: true };
  }

  let replayed = 0;
  for (const entry of sseState.buffer) {
    if (entry.id > lastEventId) {
      writeSseEvent(res, entry);
      replayed += 1;
    }
  }

  return { replayed, missed: false };
}

export function recordAckMetric() {
  sseState.metrics.sos_admin_ack_total += 1;
}

export function recordResolveMetric() {
  sseState.metrics.sos_admin_resolve_total += 1;
}

export function getSosStreamMetrics() {
  return {
    ...sseState.metrics,
    sos_stream_clients_active: sseState.subscribers.size
  };
}

export async function publishSosDeltaBySosId(sosId) {
  const thread = await getThreadStateAnyStatus(sosId);
  if (!thread) {
    return;
  }

  const entry = {
    id: nextSseId(),
    event: "delta",
    data: thread,
    createdAtMs: Date.now()
  };

  sseState.buffer.push(entry);
  pruneReplayBuffer();

  for (const res of sseState.subscribers) {
    try {
      writeSseEvent(res, entry);
    } catch {
      closeSubscriber(res);
    }
  }
}

