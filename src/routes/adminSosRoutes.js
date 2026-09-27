import express from "express";
import { randomUUID } from "node:crypto";
import { requireAdminAuth, requirePermission } from "../middleware/adminAuth.js";
import {
  appendThreadStatusEvent,
  getThreadStateAnyStatus,
  isSseEnabled,
  listLiveMapRows,
  listLiveThreads,
  listThreadEvents,
  openSseStream,
  parseLiveListParams,
  publishSosDeltaBySosId,
  recordAckMetric,
  recordResolveMetric,
  replaySince,
  subscribeSse,
  writeHeartbeat,
  writeSnapshotToStream
} from "../services/sosLiveOps.js";
import { notifySosFriendsTerminalEvent, notifyUserLifecycleEvent } from "../services/userNotifications.js";
import { SosRecord } from "../models/Reduced.js";
import { parseObjectId } from "../utils/objectId.js";

const router = express.Router();
const MAX_NOTE_LENGTH = 1000;
const VALID_ASSIGNED_UNITS = new Set([
  "Emergency Medical Unit",
  "Fire Station Unit",
  "Police Personnel",
  "Traffic Enforcement Unit"
]);

function parseOptionalNote(body) {
  if (body?.note == null) {
    return null;
  }
  if (typeof body.note !== "string") {
    return { error: "note must be a string" };
  }
  const sanitized = body.note.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  const trimmed = sanitized.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_NOTE_LENGTH) {
    return { error: `note must be ${MAX_NOTE_LENGTH} characters or less` };
  }
  return trimmed;
}

function parseAssignedUnit(body) {
  const value = typeof body?.assigned_unit === "string" ? body.assigned_unit.trim() : "";
  if (!value) {
    return { error: "assigned_unit is required" };
  }
  if (!VALID_ASSIGNED_UNITS.has(value)) {
    return { error: "Invalid assigned_unit" };
  }
  return value;
}

function parseResolveOutcome(note) {
  if (typeof note !== "string") {
    return "resolved";
  }
  const normalized = note.trim().toUpperCase();
  if (normalized.startsWith("CANCELLED:")) {
    return "cancelled";
  }
  if (normalized.startsWith("SAFE:")) {
    return "safe";
  }
  return "resolved";
}

function buildActionResponse(thread) {
  return {
    ok: true,
    sos_id: thread.sos_id,
    latest_status: thread.latest_status,
    acknowledged_at: thread.acknowledged_at,
    acknowledgedAt: thread.acknowledged_at,
    admin_acknowledged_at: thread.acknowledged_at,
    acknowledged_by_admin_id: thread.acknowledged_by_admin_id,
    admin_acknowledged_by_admin_id: thread.acknowledged_by_admin_id,
    assigned_unit: thread.assigned_unit ?? null,
    assignedUnit: thread.assignedUnit ?? thread.assigned_unit ?? null,
    emergency_category: thread.emergency_category,
    requires_attention: Boolean(thread.requires_attention),
    latest_event_at: thread.latest_event_at
  };
}

function getRequestTrace(req, overrides = {}) {
  return {
    requestId: req.get?.("x-request-id") || randomUUID(),
    adminId: req.admin?.adminId ?? null,
    ...overrides,
  };
}

router.get("/admin/sos/live-map", requireAdminAuth, requirePermission("manage_sos"), async (req, res) => {
  try {
    const rows = await listLiveMapRows();
    return res.json(rows);
  } catch (err) {
    console.error("GET /admin/sos/live-map error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/sos/live", requireAdminAuth, requirePermission("manage_sos"), async (req, res) => {
  try {
    const parsed = parseLiveListParams(req.query);
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }

    const { rows, nextCursor } = await listLiveThreads(parsed.params);
    if (nextCursor) {
      res.set("X-Next-Cursor", nextCursor);
    }
    return res.json(rows);
  } catch (err) {
    console.error("GET /admin/sos/live error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/sos/live/stream", requireAdminAuth, requirePermission("manage_sos"), async (req, res) => {
  if (!isSseEnabled()) {
    return res.status(404).json({ message: "SSE stream is disabled" });
  }

  openSseStream(res);
  const unsubscribe = subscribeSse(res);

  const lastEventId = Number(req.get("Last-Event-ID"));
  if (lastEventId) {
    const replayResult = replaySince(lastEventId, res);
    if (replayResult.missed) {
      console.warn("SSE replay miss for /admin/sos/live/stream", { lastEventId });
    }
  }

  try {
    const snapshot = await listLiveThreads({ status: "open", limit: 500, cursor: null });
    writeSnapshotToStream(res, snapshot.rows);
  } catch (err) {
    console.error("Initial SOS snapshot error:", err);
  }

  const heartbeatTimer = setInterval(() => {
    try {
      writeHeartbeat(res);
    } catch {
      clearInterval(heartbeatTimer);
      clearInterval(snapshotTimer);
      unsubscribe();
    }
  }, 15_000);

  const snapshotTimer = setInterval(async () => {
    try {
      const snapshot = await listLiveThreads({ status: "open", limit: 500, cursor: null });
      writeSnapshotToStream(res, snapshot.rows);
    } catch (err) {
      console.error("Periodic SOS snapshot error:", err);
    }
  }, 30_000);

  req.on("close", () => {
    clearInterval(heartbeatTimer);
    clearInterval(snapshotTimer);
    unsubscribe();
  });
});

router.post("/admin/sos/:sosId/acknowledge", requireAdminAuth, requirePermission("manage_sos"), async (req, res) => {
  const sosId = parseObjectId(req.params.sosId);
  if (!sosId) {
    return res.status(400).json({ message: "Invalid sosId" });
  }
  const trace = getRequestTrace(req, {
    action: "admin_sos_acknowledge",
    entityType: "sos",
    entityId: sosId.toString(),
  });

  const note = parseOptionalNote(req.body);
  if (note?.error) {
    return res.status(400).json({ message: note.error });
  }
  const assignedUnit = parseAssignedUnit(req.body);
  if (assignedUnit?.error) {
    return res.status(400).json({ message: assignedUnit.error });
  }

  {
    try {
      const thread = await SosRecord.findOne({ root_event_id: sosId, record_type: "case" }).lean();
      if (!thread) return res.status(404).json({ message: "SOS thread not found" });
      if (thread.latest_status === "resolved") return res.status(409).json({ message: "SOS thread is already resolved" });
      const now = new Date();
      await appendThreadStatusEvent({
        thread,
        sosId,
        threadUpdates: { acknowledged_at: now, acknowledged_by_admin_id: parseObjectId(req.admin.adminId), assigned_unit: assignedUnit },
        event: { user_id: thread.user_id, status: "active", actor_type: "admin", actor_admin_id: parseObjectId(req.admin.adminId), event_type: "admin_acknowledged", message: typeof note === "string" ? note : undefined },
        createdAt: now,
      });
      recordAckMetric();
      const current = await getThreadStateAnyStatus(sosId);
      if (!current) return res.status(500).json({ message: "SOS thread state unavailable after acknowledge" });
      publishSosDeltaBySosId(sosId).catch(() => {});
      notifyUserLifecycleEvent({ recipient_user_id: current.user_id, entity_type: "sos", entity_id: current.sos_id, status: "acknowledged", assigned_unit: current.assigned_unit, sender_name: current.full_name, latitude: current.latest_latitude, longitude: current.latest_longitude, address: current.latest_address, category: current.emergency_category, trace });
      return res.json(buildActionResponse(current));
    } catch (err) { if (err?.statusCode) return res.status(err.statusCode).json({ message: "SOS thread is already resolved" }); console.error("Mongo SOS acknowledge error:", err); return res.status(500).json({ message: "Server error" }); }
  }

});

router.post("/admin/sos/:sosId/resolve", requireAdminAuth, requirePermission("manage_sos"), async (req, res) => {
  const sosId = parseObjectId(req.params.sosId);
  if (!sosId) {
    return res.status(400).json({ message: "Invalid sosId" });
  }
  const trace = getRequestTrace(req, {
    action: "admin_sos_resolve",
    entityType: "sos",
    entityId: sosId.toString(),
  });

  const note = parseOptionalNote(req.body);
  if (note?.error) {
    return res.status(400).json({ message: note.error });
  }
  const terminalOutcome = parseResolveOutcome(note);

  {
    try {
      const thread = await SosRecord.findOne({ root_event_id: sosId, record_type: "case" }).lean();
      if (!thread) return res.status(404).json({ message: "SOS thread not found" });
      if (thread.latest_status === "resolved") { const current = await getThreadStateAnyStatus(sosId); return res.json(buildActionResponse(current)); }
      if (thread.latest_status !== "active") return res.status(409).json({ message: `Cannot resolve SOS in status '${thread.latest_status}'` });
      const now = new Date();
      await appendThreadStatusEvent({
        thread,
        sosId,
        threadUpdates: { latest_status: "resolved", resolved_at: now, terminal_status: terminalOutcome === "resolved" ? null : terminalOutcome },
        event: { user_id: thread.user_id, status: terminalOutcome, actor_type: "admin", actor_admin_id: parseObjectId(req.admin.adminId), event_type: "status_update", message: typeof note === "string" ? note : undefined },
        createdAt: now,
      });
      recordResolveMetric();
      const current = await getThreadStateAnyStatus(sosId);
      if (!current) return res.status(500).json({ message: "SOS thread state unavailable after resolve" });
      publishSosDeltaBySosId(sosId).catch(() => {});
      notifyUserLifecycleEvent({ recipient_user_id: current.user_id, entity_type: "sos", entity_id: current.sos_id, status: current.terminal_status ?? "resolved", assigned_unit: current.assigned_unit, sender_name: current.full_name, latitude: current.latest_latitude, longitude: current.latest_longitude, address: current.latest_address, category: current.emergency_category, trace });
      notifySosFriendsTerminalEvent({ owner_user_id: current.user_id, sos_id: current.sos_id, terminal_outcome: current.terminal_status ?? "resolved", sender_name: current.full_name, latitude: current.latest_latitude, longitude: current.latest_longitude, address: current.latest_address, category: current.emergency_category, trace });
      return res.json(buildActionResponse(current));
    } catch (err) { if (err?.statusCode) return res.status(err.statusCode).json({ message: "SOS thread status changed; reload and retry" }); console.error("Mongo SOS resolve error:", err); return res.status(500).json({ message: "Server error" }); }
  }

});

router.get("/admin/sos/:sosId", requireAdminAuth, requirePermission("manage_sos"), async (req, res) => {
  const sosId = parseObjectId(req.params.sosId);
  if (!sosId) {
    return res.status(400).json({ message: "Invalid sosId" });
  }

  try {
    const thread = await getThreadStateAnyStatus(sosId);
    if (!thread) {
      return res.status(404).json({ message: "SOS thread not found" });
    }

    const events = await listThreadEvents(sosId);
    return res.json({ thread, events });
  } catch (err) {
    console.error("GET /admin/sos/:sosId error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
