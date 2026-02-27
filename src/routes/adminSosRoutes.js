import express from "express";
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

const router = express.Router();

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
  const trimmed = body.note.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function buildActionResponse(thread) {
  return {
    ok: true,
    sos_id: thread.sos_id,
    latest_status: thread.latest_status,
    acknowledged_at: thread.acknowledged_at,
    latest_event_at: thread.latest_event_at
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

  const note = parseOptionalNote(req.body);
  if (note?.error) {
    return res.status(400).json({ message: note.error });
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

    if (latest.status === "acknowledged") {
      await client.query("ROLLBACK");
      const current = await getThreadStateAnyStatus(sosId);
      return res.json(buildActionResponse(current));
    }

    await appendAdminStatusEvent(client, {
      sosId,
      adminId: Number(req.admin.adminId),
      userId: Number(latest.user_id),
      status: "acknowledged",
      note: typeof note === "string" ? note : null,
      latitude: latest.latitude,
      longitude: latest.longitude,
      address: latest.address
    });

    await client.query("COMMIT");
    recordAckMetric();

    const current = await getThreadStateAnyStatus(sosId);
    await publishSosDeltaBySosId(sosId);
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

  const note = parseOptionalNote(req.body);
  if (note?.error) {
    return res.status(400).json({ message: note.error });
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
      const current = await getThreadStateAnyStatus(sosId);
      return res.json(buildActionResponse(current));
    }

    if (latest.status !== "active" && latest.status !== "acknowledged") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Cannot resolve SOS in status '${latest.status}'` });
    }

    await appendAdminStatusEvent(client, {
      sosId,
      adminId: Number(req.admin.adminId),
      userId: Number(latest.user_id),
      status: "resolved",
      note: typeof note === "string" ? note : null,
      latitude: latest.latitude,
      longitude: latest.longitude,
      address: latest.address
    });

    await client.query("COMMIT");
    recordResolveMetric();

    const current = await getThreadStateAnyStatus(sosId);
    await publishSosDeltaBySosId(sosId);
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
