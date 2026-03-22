import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { normalizeUserNotificationRow } from "../services/userNotifications.js";

const router = express.Router();

function applyNotificationNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, private, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Vary", "Authorization");
  res.set("Expires", "0");
}

async function getCurrentUserId(firebaseUid) {
  const result = await pool.query(
    `
    SELECT id
    FROM users
    WHERE firebase_uid = $1
    LIMIT 1
    `,
    [firebaseUid]
  );
  return result.rowCount > 0 ? Number(result.rows[0].id) : null;
}

router.get("/notifications", requireAppAuth, async (req, res) => {
  try {
    applyNotificationNoStoreHeaders(res);
    const userId = await getCurrentUserId(req.auth?.uid);
    if (!userId) {
      return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
    }

    const result = await pool.query(
      `
      SELECT id, recipient_user_id, type, title, message, metadata, is_read, created_at
      FROM user_notifications
      WHERE recipient_user_id = $1
      ORDER BY created_at DESC, id DESC
      `,
      [userId]
    );

    return res.json(result.rows.map(normalizeUserNotificationRow));
  } catch (err) {
    console.error("GET /notifications error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch("/notifications/:id/read", requireAppAuth, async (req, res) => {
  try {
    applyNotificationNoStoreHeaders(res);
    const notificationId = Number(req.params.id);
    if (!Number.isInteger(notificationId) || notificationId <= 0) {
      return res.status(400).json({ message: "Invalid notification id" });
    }

    const userId = await getCurrentUserId(req.auth?.uid);
    if (!userId) {
      return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
    }

    const result = await pool.query(
      `
      UPDATE user_notifications
      SET is_read = true
      WHERE id = $1
        AND recipient_user_id = $2
      RETURNING id, recipient_user_id, type, title, message, metadata, is_read, created_at
      `,
      [notificationId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Notification not found" });
    }

    return res.json({
      message: "Notification marked as read",
      notification: normalizeUserNotificationRow(result.rows[0]),
    });
  } catch (err) {
    console.error("PATCH /notifications/:id/read error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
