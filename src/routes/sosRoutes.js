import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import admin from "../firebaseAdmin.js";
import { publishSosDeltaBySosId } from "../services/sosLiveOps.js";

const router = express.Router();
const SOS_CATEGORIES = new Set(["medical", "fire", "violence", "unknown"]);
const SOS_TERMINAL_STATUSES = new Set(["cancelled", "safe"]);
const SOS_TERMINAL_SOURCES = new Set(["android"]);
const IS_DEBUG_LOG = String(process.env.LOG_LEVEL || "").toLowerCase() === "debug";

function logDebug(event, payload) {
  if (!IS_DEBUG_LOG) {
    return;
  }
  console.debug(`[sos-routes] ${event}`, payload);
}

async function notifyAdminsAboutSos({ sosId, fullName, category }) {
  const alertTitle = "New SOS Alert";
  const senderName = typeof fullName === "string" && fullName.trim() ? fullName.trim() : "Unknown";
  const alertMessage = `${senderName} created an SOS (${category}).`;

  const insertResult = await pool.query(
    `
    INSERT INTO notifications (
      recipient_admin_id, type, title, message, metadata, is_read, created_at
    )
    SELECT
      a.id,
      'sos',
      $1,
      $2,
      jsonb_build_object(
        'reference_id',
        $3::bigint,
        'sos_id',
        $3::bigint,
        'fallback_route',
        '/admin/sos/' || $3::text
      ),
      false,
      NOW()
    FROM admins a
    WHERE a.status = 'active'
    `,
    [alertTitle, alertMessage, Number(sosId)]
  );
  logDebug("notifications.insert", {
    sosId: Number(sosId),
    category,
    recipientCount: insertResult.rowCount ?? 0
  });
  if ((insertResult.rowCount ?? 0) === 0) {
    console.warn("[sos-routes] No active admin recipients for SOS notification", {
      sosId: Number(sosId)
    });
  }
}

function parsePositiveInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return null;
  }
  return num;
}

function parseOptionalResolvedAt(value) {
  if (value == null) {
    return { value: null };
  }
  if (typeof value !== "string") {
    return { error: "Invalid resolved_at" };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { error: "Invalid resolved_at" };
  }
  return { value: parsed.toISOString() };
}

router.post("/sos", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const { latitude, longitude, address, message } = req.body;

  if (latitude != null && typeof latitude !== "number") {
    return res.status(400).json({ message: "Invalid latitude" });
  }
  if (longitude != null && typeof longitude !== "number") {
    return res.status(400).json({ message: "Invalid longitude" });
  }
  if (address != null && typeof address !== "string") {
    return res.status(400).json({ message: "Invalid address" });
  }
  if (message != null && typeof message !== "string") {
    return res.status(400).json({ message: "Invalid message" });
  }
  const rawCategory =
    req.body?.category ??
    req.body?.emergency_category ??
    req.body?.emergencyType ??
    req.body?.emergency_type ??
    req.body?.type ??
    null;
  if (typeof rawCategory !== "string") {
    return res.status(400).json({ message: "Invalid category" });
  }

  const normalizedCategory = rawCategory.trim().toLowerCase() === "unkown"
    ? "unknown"
    : rawCategory.trim().toLowerCase();
  if (!SOS_CATEGORIES.has(normalizedCategory)) {
    return res.status(400).json({ message: "Invalid category" });
  }

  const userRes = await pool.query(
    "SELECT id, full_name FROM users WHERE firebase_uid = $1",
    [uid]
  );
  if (userRes.rowCount === 0) {
    return res.status(404).json({ message: "User not found" });
  }

  const userId = userRes.rows[0].id;
  const fullName = userRes.rows[0].full_name || "Unknown";

  let sosId = null;
  let threadId = null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const insertRes = await client.query(
      `
      INSERT INTO sos_events (
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
      VALUES ($1, $2, $3, $4, $5, 'active', 'user', NULL, 'report_created', $6)
      RETURNING id
      `,
      [userId, latitude ?? null, longitude ?? null, address ?? null, message ?? null, normalizedCategory]
    );

    if (insertRes.rowCount === 0) {
      throw new Error("Failed to create SOS event");
    }

    sosId = Number(insertRes.rows[0].id);
    const threadInsert = await client.query(
      `
      INSERT INTO sos_threads (
        root_event_id,
        user_id,
        latest_status,
        emergency_category,
        acknowledged_at,
        acknowledged_by_admin_id,
        resolved_at
      )
      VALUES ($1, $2, 'active', $3, NULL, NULL, NULL)
      RETURNING id
      `,
      [sosId, userId, normalizedCategory]
    );
    threadId = Number(threadInsert.rows[0].id);

    await client.query(
      `
      UPDATE sos_events
      SET sos_id = $1, thread_id = $2
      WHERE id = $1
      `,
      [sosId, threadId]
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("Create SOS event error:", err);
    return res.status(500).json({ message: "Failed to create SOS event" });
  } finally {
    client.release();
  }

  publishSosDeltaBySosId(sosId).catch((err) => {
    console.error("publish SOS delta error:", err);
  });
  logDebug("create.completed", {
    sosId,
    userId,
    category: normalizedCategory
  });
  try {
    await notifyAdminsAboutSos({
      sosId,
      fullName,
      category: normalizedCategory,
    });
  } catch (err) {
    // Best-effort notification fan-out should not block SOS creation flow.
    console.error("SOS admin notification insert failed:", err?.message || err, {
      code: err?.code,
      sosId
    });
  }

  const friendsRes = await pool.query(
    `SELECT friend_user_id
     FROM friendships
     WHERE user_id = $1`,
    [userId]
  );

  const friendUserIds = friendsRes.rows.map((r) => r.friend_user_id);

  if (friendUserIds.length === 0) {
    return res.status(200).json({
      sos_id: String(sosId),
      category: normalizedCategory,
      notified_users: 0,
      notified_devices: 0,
      message: "SOS created, but you have no Beacon friends to notify."
    });
  }

  const tokensRes = await pool.query(
    `SELECT DISTINCT fcm_token
     FROM devices
     WHERE user_id = ANY($1::bigint[]) AND fcm_token IS NOT NULL`,
    [friendUserIds]
  );

  const tokens = tokensRes.rows.map((r) => r.fcm_token).filter(Boolean);

  if (tokens.length === 0) {
    return res.status(200).json({
      sos_id: String(sosId),
      category: normalizedCategory,
      notified_users: friendUserIds.length,
      notified_devices: 0,
      message: "SOS created, but no device tokens found for your friends."
    });
  }

  const multicast = {
    tokens,
    notification: {
      title: "SOS Alert",
      body: `${fullName} needs help. Tap to view details.`
    },
      data: {
        type: "SOS",
        sos_id: String(sosId),
        category: normalizedCategory,
        sender_name: String(fullName),
        sender_user_id: String(userId),
        latitude: latitude != null ? String(latitude) : "",
      longitude: longitude != null ? String(longitude) : "",
      address: address != null ? String(address) : "",
      message: message != null ? String(message) : ""
    },
    android: {
      priority: "high"
    }
  };

  try {
    const resp = await admin.messaging().sendEachForMulticast(multicast);

    const failed = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) failed.push({ token: tokens[i], error: r.error?.message });
    });
    if (failed.length > 0) console.log("SOS FCM failures:", failed);

    return res.status(200).json({
      sos_id: String(sosId),
      category: normalizedCategory,
      notified_users: friendUserIds.length,
      notified_devices: resp.successCount,
      failed_devices: resp.failureCount
    });
  } catch (e) {
    console.error("FCM send error:", e);
    return res.status(200).json({
      sos_id: String(sosId),
      category: normalizedCategory,
      notified_users: friendUserIds.length,
      notified_devices: 0,
      message: "SOS created, but push notification failed."
    });
  }
});

router.patch("/sos/:sosId/status", requireAppAuth, async (req, res) => {
  const sosId = parsePositiveInt(req.params.sosId);
  if (!sosId) {
    return res.status(400).json({ message: "Invalid sosId" });
  }

  const status = typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : "";
  if (!SOS_TERMINAL_STATUSES.has(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  const source = req.body?.source;
  if (source != null) {
    if (typeof source !== "string" || !SOS_TERMINAL_SOURCES.has(source.trim().toLowerCase())) {
      return res.status(400).json({ message: "Invalid source" });
    }
  }

  const parsedResolvedAt = parseOptionalResolvedAt(req.body?.resolved_at);
  if (parsedResolvedAt.error) {
    return res.status(400).json({ message: parsedResolvedAt.error });
  }

  const userRes = await pool.query(
    "SELECT id FROM users WHERE firebase_uid = $1",
    [req.auth.uid]
  );
  if (userRes.rowCount === 0) {
    return res.status(404).json({ message: "User not found" });
  }
  const userId = Number(userRes.rows[0].id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const latestRes = await client.query(
      `
      SELECT
        st.id AS thread_id,
        st.user_id,
        st.latest_status,
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

    if (latestRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "SOS thread not found" });
    }

    const latest = latestRes.rows[0];
    if (Number(latest.user_id) !== userId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Forbidden" });
    }

    if (latest.latest_status !== "active") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Cannot update SOS in status '${latest.latest_status}'` });
    }

    const updateThreadRes = await client.query(
      `
      UPDATE sos_threads
      SET
        latest_status = 'resolved',
        resolved_at = COALESCE($2::timestamptz, NOW()),
        terminal_status = $3,
        resolved_source = COALESCE($4, resolved_source),
        updated_at = NOW()
      WHERE id = $1
      RETURNING root_event_id AS sos_id, terminal_status, resolved_at
      `,
      [
        Number(latest.thread_id),
        parsedResolvedAt.value,
        status,
        source == null ? null : source.trim().toLowerCase()
      ]
    );

    await client.query(
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
      VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, 'user', NULL, 'status_update', $8)
      `,
      [
        Number(latest.thread_id),
        sosId,
        userId,
        latest.latitude ?? null,
        latest.longitude ?? null,
        latest.address ?? null,
        status,
        latest.emergency_category ?? null
      ]
    );

    await client.query("COMMIT");
    publishSosDeltaBySosId(sosId).catch((err) => {
      console.error("publish SOS delta error (user status update):", err);
    });

    const updated = updateThreadRes.rows[0];
    return res.status(200).json({
      sos_id: String(updated.sos_id),
      status: updated.terminal_status,
      resolved_at: updated.resolved_at
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("PATCH /sos/:sosId/status error:", err);
    return res.status(500).json({ message: "Failed to update SOS status" });
  } finally {
    client.release();
  }
});

export default router;
