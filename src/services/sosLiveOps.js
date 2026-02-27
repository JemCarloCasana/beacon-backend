import { pool } from "../db.js";

const VALID_STATUSES = new Set(["active", "acknowledged", "resolved"]);
const VALID_LIVE_FILTERS = new Set(["open", "active", "acknowledged", "resolved"]);
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
    return "t.latest_status IN ('active', 'acknowledged')";
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
    WITH latest AS (
      SELECT DISTINCT ON (se.sos_id)
        se.sos_id,
        se.user_id,
        se.status AS latest_status,
        se.message AS latest_message,
        se.latitude AS latest_latitude,
        se.longitude AS latest_longitude,
        se.address AS latest_address,
        se.created_at AS latest_event_at
      FROM sos_events se
      WHERE se.sos_id IS NOT NULL
      ORDER BY se.sos_id, se.created_at DESC, se.id DESC
    ),
    thread AS (
      SELECT
        l.sos_id,
        l.user_id,
        u.full_name,
        u.phone_number,
        u.role,
        l.latest_status,
        l.latest_message,
        l.latest_latitude,
        l.latest_longitude,
        l.latest_address,
        root.created_at AS opened_at,
        l.latest_event_at,
        ack.acknowledged_at,
        rs.resolved_at
      FROM latest l
      JOIN users u ON u.id = l.user_id
      LEFT JOIN sos_events root ON root.id = l.sos_id
      LEFT JOIN LATERAL (
        SELECT se_ack.created_at AS acknowledged_at
        FROM sos_events se_ack
        WHERE se_ack.sos_id = l.sos_id
          AND se_ack.status = 'acknowledged'
        ORDER BY se_ack.created_at DESC, se_ack.id DESC
        LIMIT 1
      ) ack ON true
      LEFT JOIN LATERAL (
        SELECT se_res.created_at AS resolved_at
        FROM sos_events se_res
        WHERE se_res.sos_id = l.sos_id
          AND se_res.status = 'resolved'
        ORDER BY se_res.created_at DESC, se_res.id DESC
        LIMIT 1
      ) rs ON true
    )
    SELECT *
    FROM thread t
    WHERE ${whereParts.join(" AND ")}
    ORDER BY t.latest_event_at DESC, t.sos_id DESC
    LIMIT $${values.length}
    `,
    values
  );

  const rows = result.rows;
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

export async function getLatestThreadState(sosId) {
  const result = await listLiveThreads({
    status: "open",
    limit: 500,
    cursor: null
  });
  return result.rows.find((row) => Number(row.sos_id) === Number(sosId)) || null;
}

export async function getThreadStateAnyStatus(sosId) {
  const result = await pool.query(
    `
    WITH latest AS (
      SELECT DISTINCT ON (se.sos_id)
        se.sos_id,
        se.user_id,
        se.status AS latest_status,
        se.message AS latest_message,
        se.latitude AS latest_latitude,
        se.longitude AS latest_longitude,
        se.address AS latest_address,
        se.created_at AS latest_event_at
      FROM sos_events se
      WHERE se.sos_id = $1
      ORDER BY se.sos_id, se.created_at DESC, se.id DESC
    )
    SELECT
      l.sos_id,
      l.user_id,
      u.full_name,
      u.phone_number,
      u.role,
      l.latest_status,
      l.latest_message,
      l.latest_latitude,
      l.latest_longitude,
      l.latest_address,
      root.created_at AS opened_at,
      l.latest_event_at,
      ack.acknowledged_at,
      rs.resolved_at
    FROM latest l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN sos_events root ON root.id = l.sos_id
    LEFT JOIN LATERAL (
      SELECT se_ack.created_at AS acknowledged_at
      FROM sos_events se_ack
      WHERE se_ack.sos_id = l.sos_id AND se_ack.status = 'acknowledged'
      ORDER BY se_ack.created_at DESC, se_ack.id DESC
      LIMIT 1
    ) ack ON true
    LEFT JOIN LATERAL (
      SELECT se_res.created_at AS resolved_at
      FROM sos_events se_res
      WHERE se_res.sos_id = l.sos_id AND se_res.status = 'resolved'
      ORDER BY se_res.created_at DESC, se_res.id DESC
      LIMIT 1
    ) rs ON true
    `,
    [sosId]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

export async function listThreadEvents(sosId) {
  const result = await pool.query(
    `
    SELECT
      id,
      sos_id,
      user_id,
      status,
      latitude,
      longitude,
      address,
      message,
      created_at,
      actor_type,
      actor_admin_id
    FROM sos_events
    WHERE sos_id = $1
    ORDER BY created_at ASC, id ASC
    `,
    [sosId]
  );
  return result.rows;
}

export async function listLiveMapRows() {
  const columnCheck = await pool.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'sos_events'
        AND column_name = 'sos_id'
    ) AS has_sos_id
    `
  );
  const hasSosId = Boolean(columnCheck.rows[0]?.has_sos_id);
  const sosIdSelect = hasSosId ? "se.sos_id" : "se.id";

  const result = await pool.query(
    `
    SELECT DISTINCT ON (se.user_id)
      ${sosIdSelect} AS sos_id,
      se.user_id,
      se.latitude,
      se.longitude,
      se.address,
      se.message,
      se.status,
      se.created_at
    FROM sos_events se
    WHERE se.status = 'active'
      AND se.latitude IS NOT NULL
      AND se.longitude IS NOT NULL
    ORDER BY se.user_id, se.created_at DESC, se.id DESC
    `
  );
  return result.rows;
}

export async function getLatestThreadEventForUpdate(client, sosId) {
  const result = await client.query(
    `
    SELECT
      id,
      sos_id,
      user_id,
      status,
      latitude,
      longitude,
      address
    FROM sos_events
    WHERE sos_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    FOR UPDATE
    `,
    [sosId]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

export async function appendAdminStatusEvent(client, { sosId, adminId, userId, status, note, latitude, longitude, address }) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Unsupported status: ${status}`);
  }

  const result = await client.query(
    `
    INSERT INTO sos_events (
      sos_id,
      user_id,
      latitude,
      longitude,
      address,
      message,
      status,
      actor_type,
      actor_admin_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin', $8)
    RETURNING id, sos_id, user_id, status, created_at
    `,
    [sosId, userId, latitude ?? null, longitude ?? null, address ?? null, note ?? null, status, adminId]
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
