import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import admin from "../firebaseAdmin.js"; // ✅ use your initialized admin

const router = express.Router();

/**
 * POST /sos
 * Body: { latitude, longitude, address, message }
 *
 * Model B:
 * - Notify accepted Beacon friends (friendships)
 * - Emergency contacts are for LGU viewing, not push recipients
 */
router.post("/sos", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const { latitude, longitude, address, message } = req.body;

  // Validation
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

  // Get Postgres user
  const userRes = await pool.query(
    "SELECT id, full_name FROM users WHERE firebase_uid = $1",
    [uid]
  );
  if (userRes.rowCount === 0) {
    return res.status(404).json({ message: "User not found" });
  }

  const userId = userRes.rows[0].id;
  const fullName = userRes.rows[0].full_name || "Unknown";

  // Insert SOS event
  const sosRes = await pool.query(
    `INSERT INTO sos_events (user_id, latitude, longitude, address, message, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING id, created_at`,
    [userId, latitude ?? null, longitude ?? null, address ?? null, message ?? null]
  );

  const sosId = sosRes.rows[0].id;

  // ✅ Load accepted friends
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
      notified_users: 0,
      notified_devices: 0,
      message: "SOS created, but you have no Beacon friends to notify.",
    });
  }

  // ✅ Load FCM tokens for friends
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
      notified_users: friendUserIds.length,
      notified_devices: 0,
      message: "SOS created, but no device tokens found for your friends.",
    });
  }

  // ✅ Send push notifications
  const multicast = {
    tokens,
    notification: {
      title: "SOS Alert",
      body: `${fullName} needs help. Tap to view details.`,
    },
    data: {
      type: "SOS",
      sos_id: String(sosId),

      // ✅ NEW: sender_name (this fixes your "Unknown" in Android)
      sender_name: String(fullName),

      sender_user_id: String(userId),
      latitude: latitude != null ? String(latitude) : "",
      longitude: longitude != null ? String(longitude) : "",
      address: address != null ? String(address) : "",
      message: message != null ? String(message) : "",
    },
    android: {
      priority: "high",
    },
  };

  try {
    const resp = await admin.messaging().sendEachForMulticast(multicast);

    // Optional: log failures (useful for debugging invalid tokens)
    const failed = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) failed.push({ token: tokens[i], error: r.error?.message });
    });
    if (failed.length > 0) console.log("SOS FCM failures:", failed);

    return res.status(200).json({
      sos_id: String(sosId),
      notified_users: friendUserIds.length,
      notified_devices: resp.successCount,
      failed_devices: resp.failureCount,
    });
  } catch (e) {
    console.error("FCM send error:", e);
    return res.status(200).json({
      sos_id: String(sosId),
      notified_users: friendUserIds.length,
      notified_devices: 0,
      message: "SOS created, but push notification failed.",
    });
  }
});

export default router;
