import express from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { requireAdminAuth } from "../middleware/adminAuth.js";
import {
  appendAdminStatusEvent,
  getLatestThreadEventForUpdate,
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

const router = express.Router();
const MAX_NOTE_LENGTH = 1000;
const VALID_ASSIGNED_UNITS = new Set([
  "Emergency Medical Unit",
  "Fire Station Unit",
  "Police Personnel",
  "Traffic Enforcement Unit"
]);

function parsePositiveInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return null;
  }
  return num;
}

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
    adminId: Number(req.admin?.adminId ?? null),
    ...overrides,
  };
}

router.get("/admin/sos/live-map", requireAdminAuth, async (req, res) => {
  try {
    const rows = await listLiveMapRows();
    return res.json(rows);
  } catch (err) {
    console.error("GET /admin/sos/live-map error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/sos/live", requireAdminAuth, async (req, res) => {
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

router.get("/admin/sos/live/stream", requireAdminAuth, async (req, res) => {
  if (!isSseEnabled()) {
    return res.status(404).json({ message: "SSE stream is disabled" });
  }

  openSseStream(res);
  const unsubscribe = subscribeSse(res);

  const lastEventId = parsePositiveInt(req.get("Last-Event-ID"));
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

router.post("/admin/sos/:sosId/acknowledge", requireAdminAuth, async (req, res) => {
  const sosId = parsePositiveInt(req.params.sosId);
  if (!sosId) {
    return res.status(400).json({ message: "Invalid sosId" });
  }
  const trace = getRequestTrace(req, {
    action: "admin_sos_acknowledge",
    entityType: "sos",
    entityId: sosId,
  });

  const note = parseOptionalNote(req.body);
  if (note?.error) {
    return res.status(400).json({ message: note.error });
  }
  const assignedUnit = parseAssignedUnit(req.body);
  if (assignedUnit?.error) {
    return res.status(400).json({ message: assignedUnit.error });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const latest = await getLatestThreadEventForUpdate(client, sosId);

    if (!latest) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "SOS thread not found" });
    }

    if (latest.status === "resolved") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "SOS thread is already resolved" });
    }

    await client.query(
      `
      UPDATE sos_threads
      SET
        acknowledged_at = NOW(),
        acknowledged_by_admin_id = $2,
        assigned_unit = $3,
        updated_at = NOW()
      WHERE id = $1
      `,
      [latest.thread_id, Number(req.admin.adminId), assignedUnit]
    );

    await appendAdminStatusEvent(client, {
      threadId: Number(latest.thread_id),
      sosId,
      adminId: Number(req.admin.adminId),
      userId: Number(latest.user_id),
      status: "active",
      note: typeof note === "string" ? note : null,
      latitude: latest.latitude,
      longitude: latest.longitude,
      address: latest.address,
      eventType: "admin_acknowledged",
      emergencyCategory: latest.emergency_category
    });

    await client.query("COMMIT");
    recordAckMetric();

    const current = await getThreadStateAnyStatus(sosId);
    if (!current) {
      return res.status(500).json({ message: "SOS thread state unavailable after acknowledge" });
    }
    publishSosDeltaBySosId(sosId).catch((publishErr) => {
      console.error("publish SOS delta error (acknowledge):", publishErr);
    });
    console.info("[admin-sos] sender notification dispatch queued", {
      ...trace,
      recipientUserId: Number(current.user_id ?? null),
      status: "acknowledged",
      assignedUnit: current.assigned_unit ?? null,
    });
    notifyUserLifecycleEvent({
      recipient_user_id: current.user_id,
      entity_type: "sos",
      entity_id: current.sos_id,
      status: "acknowledged",
      assigned_unit: current.assigned_unit ?? null,
      sender_name: current.full_name ?? null,
      latitude: current.latest_latitude ?? null,
      longitude: current.latest_longitude ?? null,
      address: current.latest_address ?? null,
      category: current.emergency_category ?? null,
      trace: {
        ...trace,
        recipientUserId: Number(current.user_id ?? null),
        notificationType: "sos_update",
        status: "acknowledged",
      }
    })
      .then((result) => {
        console.info("[admin-sos] sender notification result", {
          ...trace,
          recipientUserId: Number(current.user_id ?? null),
          status: "acknowledged",
          notificationId: result?.notification?.id ?? null,
          skipped: result?.skipped ?? false,
          reason: result?.reason ?? result?.push?.reason ?? result?.push?.error ?? null,
          push: result?.push ?? null,
        });
      })
      .catch((notifyErr) => {
        console.error("sender SOS notification failed (acknowledge):", notifyErr?.message || notifyErr, {
          ...trace,
          recipientUserId: Number(current.user_id ?? null),
        });
      });
    return res.json(buildActionResponse(current));
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("POST /admin/sos/:sosId/acknowledge error:", err);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

router.post("/admin/sos/:sosId/resolve", requireAdminAuth, async (req, res) => {
  const sosId = parsePositiveInt(req.params.sosId);
  if (!sosId) {
    return res.status(400).json({ message: "Invalid sosId" });
  }
  const trace = getRequestTrace(req, {
    action: "admin_sos_resolve",
    entityType: "sos",
    entityId: sosId,
  });

  const note = parseOptionalNote(req.body);
  if (note?.error) {
    return res.status(400).json({ message: note.error });
  }
  const terminalOutcome = parseResolveOutcome(note);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const latest = await getLatestThreadEventForUpdate(client, sosId);

    if (!latest) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "SOS thread not found" });
    }

    if (latest.status === "resolved") {
      await client.query("ROLLBACK");
      const current = await getThreadStateAnyStatus(sosId);
      return res.json(buildActionResponse(current));
    }

    if (latest.status !== "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Cannot resolve SOS in status '${latest.status}'` });
    }

    await client.query(
      `
      UPDATE sos_threads
      SET
        latest_status = 'resolved',
        resolved_at = COALESCE(resolved_at, NOW()),
        terminal_status = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [latest.thread_id, terminalOutcome === "resolved" ? null : terminalOutcome]
    );

    await appendAdminStatusEvent(client, {
      threadId: Number(latest.thread_id),
      sosId,
      adminId: Number(req.admin.adminId),
      userId: Number(latest.user_id),
      status: terminalOutcome,
      note: typeof note === "string" ? note : null,
      latitude: latest.latitude,
      longitude: latest.longitude,
      address: latest.address,
      eventType: "status_update",
      emergencyCategory: latest.emergency_category
    });

    await client.query("COMMIT");
    recordResolveMetric();

    const current = await getThreadStateAnyStatus(sosId);
    if (!current) {
      return res.status(500).json({ message: "SOS thread state unavailable after resolve" });
    }
    publishSosDeltaBySosId(sosId).catch((publishErr) => {
      console.error("publish SOS delta error (resolve):", publishErr);
    });
    console.info("[admin-sos] sender notification dispatch queued", {
      ...trace,
      recipientUserId: Number(current.user_id ?? null),
      status: current.terminal_status ?? "resolved",
      assignedUnit: current.assigned_unit ?? null,
    });
    notifyUserLifecycleEvent({
      recipient_user_id: current.user_id,
      entity_type: "sos",
      entity_id: current.sos_id,
      status: current.terminal_status ?? "resolved",
      assigned_unit: current.assigned_unit ?? null,
      sender_name: current.full_name ?? null,
      latitude: current.latest_latitude ?? null,
      longitude: current.latest_longitude ?? null,
      address: current.latest_address ?? null,
      category: current.emergency_category ?? null,
      trace: {
        ...trace,
        recipientUserId: Number(current.user_id ?? null),
        notificationType: "sos_update",
        status: current.terminal_status ?? "resolved",
      }
    })
      .then((result) => {
        console.info("[admin-sos] sender notification result", {
          ...trace,
          recipientUserId: Number(current.user_id ?? null),
          status: current.terminal_status ?? "resolved",
          notificationId: result?.notification?.id ?? null,
          skipped: result?.skipped ?? false,
          reason: result?.reason ?? result?.push?.reason ?? result?.push?.error ?? null,
          push: result?.push ?? null,
        });
      })
      .catch((notifyErr) => {
        console.error("sender SOS notification failed (resolve):", notifyErr?.message || notifyErr, {
          ...trace,
          recipientUserId: Number(current.user_id ?? null),
        });
      });
    console.info("[admin-sos] friend terminal notification dispatch queued", {
      ...trace,
      ownerUserId: Number(current.user_id ?? null),
      status: current.terminal_status ?? "resolved",
    });
    notifySosFriendsTerminalEvent({
      owner_user_id: current.user_id,
      sos_id: current.sos_id,
      terminal_outcome: current.terminal_status ?? "resolved",
      sender_name: current.full_name ?? null,
      latitude: current.latest_latitude ?? null,
      longitude: current.latest_longitude ?? null,
      address: current.latest_address ?? null,
      category: current.emergency_category ?? null,
      trace: {
        ...trace,
        recipientUserId: Number(current.user_id ?? null),
        notificationType: "sos_update",
        status: current.terminal_status ?? "resolved",
      }
    })
      .then((result) => {
        console.info("[admin-sos] friend terminal notification result", {
          ...trace,
          ownerUserId: Number(current.user_id ?? null),
          status: current.terminal_status ?? "resolved",
          recipientCount: Array.isArray(result?.recipients) ? result.recipients.length : 0,
          reason: result?.reason ?? result?.push?.reason ?? result?.push?.error ?? null,
          push: result?.push ?? null,
        });
      })
      .catch((notifyErr) => {
        console.error("friend SOS notification failed (resolve):", notifyErr?.message || notifyErr, {
          ...trace,
          ownerUserId: Number(current.user_id ?? null),
        });
      });
    return res.json(buildActionResponse(current));
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("POST /admin/sos/:sosId/resolve error:", err);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

router.get("/admin/sos/:sosId", requireAdminAuth, async (req, res) => {
  const sosId = parsePositiveInt(req.params.sosId);
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
