import mongoose from "mongoose";
import { Counter } from "../models/Counter.js";
import { UserProfile, SosThread, SosEvent, AdminAccount } from "../models/Remaining.js";

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
    const parsedSosId = Number(decoded?.sos_id);
    const parsedTimestamp = decoded?.latest_event_at ? new Date(decoded.latest_event_at) : null;
    if (!Number.isInteger(parsedSosId) || parsedSosId <= 0 || Number.isNaN(parsedTimestamp?.getTime?.())) {
      return { ok: false, message: "Invalid cursor" };
    }
    cursor = {
      sos_id: parsedSosId,
      latest_event_at: parsedTimestamp.toISOString()
    };
  }

  return { ok: true, params: { status, limit, cursor } };
}

export async function listLiveThreads({ status = "open", limit = DEFAULT_LIMIT, cursor = null }) {
  {
    const filter = status === "open" ? { latest_status: "active" } : status === "cancelled" || status === "safe" ? { latest_status: "resolved", terminal_status: status } : { latest_status: status };
    const threads = await SosThread.find(filter).sort({ updated_at: -1, root_event_id: -1 }).limit(limit + 1).lean();
    const profiles = await UserProfile.find({ public_id: { $in: threads.map((t) => t.user_id) } }).lean();
    const byUser = new Map(profiles.map((p) => [Number(p.public_id), p]));
    const rows = [];
    for (const thread of threads) {
      const root = await SosEvent.findOne({ public_id: thread.root_event_id }).lean();
      const latest = await SosEvent.findOne({ thread_id: thread.public_id }).sort({ created_at: -1, public_id: -1 }).lean();
      const profile = byUser.get(Number(thread.user_id));
      if (!profile || (!root && !latest)) continue;
      const event = latest || root;
      const row = withThreadAliases({ thread_id: thread.public_id, sos_id: thread.root_event_id, user_id: thread.user_id, full_name: profile.full_name, phone_number: profile.phone_number, role: profile.role, latest_status: thread.latest_status, emergency_category: thread.emergency_category, acknowledged_at: thread.acknowledged_at ?? null, assigned_unit: thread.assigned_unit ?? null, acknowledged_by_admin_id: thread.acknowledged_by_admin_id ?? null, resolved_at: thread.resolved_at ?? null, terminal_status: thread.terminal_status ?? null, resolved_source: thread.resolved_source ?? null, opened_at: root?.created_at ?? thread.created_at, latest_message: event?.message ?? null, latest_latitude: event?.latitude ?? null, latest_longitude: event?.longitude ?? null, latest_address: event?.address ?? null, latest_event_at: event?.created_at ?? thread.updated_at, requires_attention: thread.latest_status === "active" && !thread.acknowledged_at });
      if (cursor && (new Date(row.latest_event_at) > new Date(cursor.latest_event_at) || (new Date(row.latest_event_at).getTime() === new Date(cursor.latest_event_at).getTime() && Number(row.sos_id) >= Number(cursor.sos_id)))) continue;
      rows.push(row);
    }
    rows.sort((a, b) => new Date(b.latest_event_at) - new Date(a.latest_event_at) || Number(b.sos_id) - Number(a.sos_id));
    let nextCursor = null;
    if (rows.length > limit) { const overflow = rows[limit - 1]; rows.length = limit; nextCursor = encodeCursorPayload({ latest_event_at: overflow.latest_event_at, sos_id: overflow.sos_id }); }
    return { rows, nextCursor };
  }
}

export async function getThreadStateAnyStatus(sosId) {
  {
    const thread = await SosThread.findOne({ root_event_id: Number(sosId) }).lean();
    if (!thread) return null;
    const profile = await UserProfile.findOne({ public_id: thread.user_id }).lean();
    const root = await SosEvent.findOne({ public_id: thread.root_event_id }).lean();
    const latest = await SosEvent.findOne({ thread_id: thread.public_id }).sort({ created_at: -1, public_id: -1 }).lean();
    const event = latest || root;
    return withThreadAliases({ thread_id: thread.public_id, sos_id: thread.root_event_id, user_id: thread.user_id, full_name: profile?.full_name, phone_number: profile?.phone_number, role: profile?.role, latest_status: thread.latest_status, emergency_category: thread.emergency_category, acknowledged_at: thread.acknowledged_at ?? null, assigned_unit: thread.assigned_unit ?? null, acknowledged_by_admin_id: thread.acknowledged_by_admin_id ?? null, resolved_at: thread.resolved_at ?? null, terminal_status: thread.terminal_status ?? null, resolved_source: thread.resolved_source ?? null, opened_at: root?.created_at ?? thread.created_at, latest_message: event?.message ?? null, latest_latitude: event?.latitude ?? null, latest_longitude: event?.longitude ?? null, latest_address: event?.address ?? null, latest_event_at: event?.created_at ?? thread.updated_at, requires_attention: thread.latest_status === "active" && !thread.acknowledged_at });
  }
}

export async function listThreadEvents(sosId) {
  {
    const events = await SosEvent.find({ sos_id: Number(sosId) }).sort({ created_at: 1, public_id: 1 }).lean();
    const thread = await SosThread.findOne({ root_event_id: Number(sosId) }).lean();
    const admins = await AdminAccount.find({ public_id: { $in: events.map((e) => e.actor_admin_id).filter(Boolean) } }).lean();
    const names = new Map(admins.map((a) => [Number(a.public_id), a.full_name]));
    return events.map((event) => ({ id: event.public_id, thread_id: event.thread_id, sos_id: event.sos_id, user_id: event.user_id, status: event.status === "resolved" && event.actor_type === "user" && event.event_type === "status_update" && thread?.terminal_status ? thread.terminal_status : event.status, latitude: event.latitude, longitude: event.longitude, address: event.address, message: event.message, created_at: event.created_at, actor_type: event.actor_type, actor_name: event.actor_admin_id ? names.get(Number(event.actor_admin_id)) : null, actor_admin_id: event.actor_admin_id, event_type: event.event_type, emergency_category: event.emergency_category }));
  }
}

export async function listLiveMapRows() {
  {
    const threads = await SosThread.find({ latest_status: "active" }).lean();
    const rows = [];
    for (const thread of threads) {
      const event = await SosEvent.findOne({ thread_id: thread.public_id, latitude: { $ne: null }, longitude: { $ne: null } }).sort({ created_at: -1, public_id: -1 }).lean();
      if (event) rows.push({ sos_id: thread.root_event_id, user_id: thread.user_id, latitude: event.latitude, longitude: event.longitude, address: event.address, message: event.message, status: thread.latest_status, created_at: event.created_at });
    }
    return rows;
  }
}

export async function appendThreadStatusEvent({ thread, sosId, threadUpdates, event, createdAt = new Date() }) {
  const eventId = await Counter.nextPublicId("sos_events");
  const session = await mongoose.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const latest = await SosEvent.findOne({ thread_id: thread.public_id })
        .sort({ created_at: -1, public_id: -1 })
        .session(session)
        .lean();
      const result = await SosThread.updateOne(
        { public_id: thread.public_id, latest_status: "active" },
        { $set: { ...threadUpdates, updated_at: createdAt } },
        { session }
      );
      if (result.modifiedCount !== 1) {
        throw Object.assign(new Error("SOS thread is no longer active"), { statusCode: 409 });
      }
      [created] = await SosEvent.create([{
        public_id: eventId,
        thread_id: thread.public_id,
        sos_id: Number(sosId),
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
      await SosEvent.create([event], { session });
      await SosThread.create([thread], { session });
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

