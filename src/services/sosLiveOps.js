import { pool } from "../db.js";import { isMongoConnected } from "../mongo.js";
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

function statusWhereClause(status) {
  if (status === "open") {
    return "t.latest_status = 'active'";
  }
  if (status === "cancelled" || status === "safe") {
    return "t.latest_status = 'resolved' AND t.terminal_status = $STATUS$";
  }
  return "t.latest_status = $STATUS$";
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
  if (isMongoConnected()) {
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
  const values = [];
  const whereParts = [];

  const statusClauseTemplate = statusWhereClause(status);
  let statusClause = statusClauseTemplate;
  if (status !== "open") {
    values.push(status);
    statusClause = statusClause.replace("$STATUS$", `$${values.length}`);
  }
  whereParts.push(statusClause);

  if (cursor) {
    values.push(cursor.latest_event_at);
    values.push(cursor.sos_id);
    whereParts.push(`(t.latest_event_at, t.sos_id) < ($${values.length - 1}::timestamp, $${values.length}::bigint)`);
  }

  values.push(limit + 1);

  const result = await pool.query(
    `
    WITH thread AS (
      SELECT
        st.id AS thread_id,
        st.root_event_id AS sos_id,
        st.user_id,
        u.full_name,
        u.phone_number,
        u.role,
        st.latest_status,
        st.emergency_category,
        st.acknowledged_at,
        st.assigned_unit,
        st.acknowledged_by_admin_id,
        st.resolved_at,
        st.terminal_status,
        st.resolved_source,
        root.created_at AS opened_at,
        le.message AS latest_message,
        le.latitude AS latest_latitude,
        le.longitude AS latest_longitude,
        le.address AS latest_address,
        COALESCE(le.created_at, root.created_at) AS latest_event_at
      FROM sos_threads st
      JOIN users u ON u.id = st.user_id
      LEFT JOIN sos_events root ON root.id = st.root_event_id
      LEFT JOIN LATERAL (
        SELECT
          se.message,
          se.latitude,
          se.longitude,
          se.address,
          se.created_at
        FROM sos_events se
        WHERE se.thread_id = st.id
        ORDER BY se.created_at DESC, se.id DESC
        LIMIT 1
      ) le ON true
    )
    SELECT
      t.*,
      t.acknowledged_at AS admin_acknowledged_at,
      t.acknowledged_by_admin_id AS admin_acknowledged_by_admin_id,
      (t.latest_status = 'active' AND t.acknowledged_at IS NULL) AS requires_attention
    FROM thread t
    WHERE ${whereParts.join(" AND ")}
    ORDER BY t.latest_event_at DESC, t.sos_id DESC
    LIMIT $${values.length}
    `,
    values
  );

  const rows = result.rows.map(withThreadAliases);
  let nextCursor = null;
  if (rows.length > limit) {
    const overflow = rows[limit - 1];
    rows.length = limit;
    nextCursor = encodeCursorPayload({
      latest_event_at: overflow.latest_event_at,
      sos_id: overflow.sos_id
    });
  }

  return { rows, nextCursor };
}

export async function getThreadStateAnyStatus(sosId) {
  if (isMongoConnected()) {
    const thread = await SosThread.findOne({ root_event_id: Number(sosId) }).lean();
    if (!thread) return null;
    const profile = await UserProfile.findOne({ public_id: thread.user_id }).lean();
    const root = await SosEvent.findOne({ public_id: thread.root_event_id }).lean();
    const latest = await SosEvent.findOne({ thread_id: thread.public_id }).sort({ created_at: -1, public_id: -1 }).lean();
    const event = latest || root;
    return withThreadAliases({ thread_id: thread.public_id, sos_id: thread.root_event_id, user_id: thread.user_id, full_name: profile?.full_name, phone_number: profile?.phone_number, role: profile?.role, latest_status: thread.latest_status, emergency_category: thread.emergency_category, acknowledged_at: thread.acknowledged_at ?? null, assigned_unit: thread.assigned_unit ?? null, acknowledged_by_admin_id: thread.acknowledged_by_admin_id ?? null, resolved_at: thread.resolved_at ?? null, terminal_status: thread.terminal_status ?? null, resolved_source: thread.resolved_source ?? null, opened_at: root?.created_at ?? thread.created_at, latest_message: event?.message ?? null, latest_latitude: event?.latitude ?? null, latest_longitude: event?.longitude ?? null, latest_address: event?.address ?? null, latest_event_at: event?.created_at ?? thread.updated_at, requires_attention: thread.latest_status === "active" && !thread.acknowledged_at });
  }
  const result = await pool.query(
    `
    SELECT
      st.id AS thread_id,
      st.root_event_id AS sos_id,
      st.user_id,
      u.full_name,
      u.phone_number,
      u.role,
      st.latest_status,
      st.emergency_category,
      st.acknowledged_at,
      st.assigned_unit,
      st.acknowledged_by_admin_id,
      st.resolved_at,
      st.terminal_status,
      st.resolved_source,
      root.created_at AS opened_at,
      le.message AS latest_message,
      le.latitude AS latest_latitude,
      le.longitude AS latest_longitude,
      le.address AS latest_address,
      COALESCE(le.created_at, root.created_at) AS latest_event_at,
      st.acknowledged_at AS admin_acknowledged_at,
      st.acknowledged_by_admin_id AS admin_acknowledged_by_admin_id,
      (st.latest_status = 'active' AND st.acknowledged_at IS NULL) AS requires_attention
    FROM sos_threads st
    JOIN users u ON u.id = st.user_id
    LEFT JOIN sos_events root ON root.id = st.root_event_id
    LEFT JOIN LATERAL (
      SELECT
        se.message,
        se.latitude,
        se.longitude,
        se.address,
        se.created_at
      FROM sos_events se
      WHERE se.thread_id = st.id
      ORDER BY se.created_at DESC, se.id DESC
      LIMIT 1
    ) le ON true
    WHERE st.root_event_id = $1
    LIMIT 1
    `,
    [sosId]
  );
  return result.rowCount > 0 ? withThreadAliases(result.rows[0]) : null;
}

export async function listThreadEvents(sosId) {
  if (isMongoConnected()) {
    const events = await SosEvent.find({ sos_id: Number(sosId) }).sort({ created_at: 1, public_id: 1 }).lean();
    const thread = await SosThread.findOne({ root_event_id: Number(sosId) }).lean();
    const admins = await AdminAccount.find({ public_id: { $in: events.map((e) => e.actor_admin_id).filter(Boolean) } }).lean();
    const names = new Map(admins.map((a) => [Number(a.public_id), a.full_name]));
    return events.map((event) => ({ id: event.public_id, thread_id: event.thread_id, sos_id: event.sos_id, user_id: event.user_id, status: event.status === "resolved" && event.actor_type === "user" && event.event_type === "status_update" && thread?.terminal_status ? thread.terminal_status : event.status, latitude: event.latitude, longitude: event.longitude, address: event.address, message: event.message, created_at: event.created_at, actor_type: event.actor_type, actor_name: event.actor_admin_id ? names.get(Number(event.actor_admin_id)) : null, actor_admin_id: event.actor_admin_id, event_type: event.event_type, emergency_category: event.emergency_category }));
  }
  const result = await pool.query(
    `
    SELECT
      se.id,
      se.thread_id,
      se.sos_id,
      se.user_id,
      CASE
        WHEN se.status = 'resolved'
          AND se.actor_type = 'user'
          AND se.event_type = 'status_update'
          AND st.terminal_status IS NOT NULL
        THEN st.terminal_status
        ELSE se.status
      END AS status,
      se.latitude,
      se.longitude,
      se.address,
      se.message,
      se.created_at,
      se.actor_type,
      a.full_name AS actor_name,
      se.actor_admin_id,
      se.event_type,
      se.emergency_category
    FROM sos_events se
    LEFT JOIN sos_threads st ON st.id = se.thread_id
    LEFT JOIN admins a ON a.id = se.actor_admin_id
    WHERE se.sos_id = $1
    ORDER BY se.created_at ASC, se.id ASC
    `,
    [sosId]
  );
  return result.rows;
}

export async function listLiveMapRows() {
  if (isMongoConnected()) {
    const threads = await SosThread.find({ latest_status: "active" }).lean();
    const rows = [];
    for (const thread of threads) {
      const event = await SosEvent.findOne({ thread_id: thread.public_id, latitude: { $ne: null }, longitude: { $ne: null } }).sort({ created_at: -1, public_id: -1 }).lean();
      if (event) rows.push({ sos_id: thread.root_event_id, user_id: thread.user_id, latitude: event.latitude, longitude: event.longitude, address: event.address, message: event.message, status: thread.latest_status, created_at: event.created_at });
    }
    return rows;
  }
  const result = await pool.query(
    `
    SELECT DISTINCT ON (st.user_id)
      st.root_event_id AS sos_id,
      st.user_id,
      le.latitude,
      le.longitude,
      le.address,
      le.message,
      st.latest_status AS status,
      le.created_at
    FROM sos_threads st
    JOIN LATERAL (
      SELECT se.latitude, se.longitude, se.address, se.message, se.created_at
      FROM sos_events se
      WHERE se.thread_id = st.id
        AND se.latitude IS NOT NULL
        AND se.longitude IS NOT NULL
      ORDER BY se.created_at DESC, se.id DESC
      LIMIT 1
    ) le ON true
    WHERE st.latest_status = 'active'
    ORDER BY st.user_id, le.created_at DESC
    `
  );
  return result.rows;
}

export async function getLatestThreadEventForUpdate(client, sosId) {
  const result = await client.query(
    `
    SELECT
      st.id AS thread_id,
      st.root_event_id AS sos_id,
      st.user_id,
      st.latest_status AS status,
      st.acknowledged_at,
      st.acknowledged_by_admin_id,
      st.resolved_at,
      st.emergency_category,
      le.latitude,
      le.longitude,
      le.address
    FROM sos_threads st
    LEFT JOIN LATERAL (
      SELECT se.latitude, se.longitude, se.address
      FROM sos_events se
      WHERE se.thread_id = st.id
      ORDER BY se.created_at DESC, se.id DESC
      LIMIT 1
    ) le ON true
    WHERE st.root_event_id = $1
    LIMIT 1
    FOR UPDATE OF st
    `,
    [sosId]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

export async function appendAdminStatusEvent(
  client,
  { threadId, sosId, adminId, userId, status, note, latitude, longitude, address, eventType = "status_update", emergencyCategory = null }
) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Unsupported status: ${status}`);
  }
  if (!VALID_EVENT_TYPES.has(eventType)) {
    throw new Error(`Unsupported event type: ${eventType}`);
  }

  const result = await client.query(
    `
    INSERT INTO sos_events (
      thread_id,
      sos_id,
      user_id,
      latitude,
      longitude,
      address,
      message,
      status,
      actor_type,
      actor_admin_id,
      event_type,
      emergency_category
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admin', $9, $10, $11)
    RETURNING id, sos_id, user_id, status, created_at
    `,
    [
      threadId,
      sosId,
      userId,
      latitude ?? null,
      longitude ?? null,
      address ?? null,
      note ?? null,
      status,
      adminId,
      eventType,
      emergencyCategory
    ]
  );
  return result.rows[0];
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

