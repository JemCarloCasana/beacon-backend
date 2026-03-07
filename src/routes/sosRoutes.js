import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import admin from "../firebaseAdmin.js";
import { publishSosDeltaBySosId } from "../services/sosLiveOps.js";

const router = express.Router();
const SOS_CATEGORIES = new Set(["medical", "fire", "violence", "unknown"]);
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
      jsonb_build_object('reference_id', $3::bigint, 'sos_id', $3::bigint),
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

export default router;
