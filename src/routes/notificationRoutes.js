import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { normalizeUserNotificationRow } from "../services/userNotifications.js";
import { UserNotification } from "../models/UserNotification.js";

const router = express.Router();

function applyNotificationNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, private, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Vary", "Authorization");
  res.set("Expires", "0");
}

function toUserNotificationRow(doc) {
  if (!doc || typeof doc !== "object") {
    return doc;
  }
  return {
    id: doc.public_id,
    recipient_user_id: doc.recipient_user_id,
    type: doc.type,
    title: doc.title,
    message: doc.message,
    metadata: doc.metadata,
    is_read: doc.is_read,
    created_at: doc.created_at,
  };
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

    const docs = await UserNotification.find({ recipient_user_id: userId })
      .sort({ created_at: -1, public_id: -1 })
      .lean();

    return res.json(docs.map((doc) => normalizeUserNotificationRow(toUserNotificationRow(doc))));
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

    const doc = await UserNotification.findOneAndUpdate(
      { public_id: notificationId, recipient_user_id: userId },
      { $set: { is_read: true } },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ message: "Notification not found" });
    }

    return res.json({
      message: "Notification marked as read",
      notification: normalizeUserNotificationRow(toUserNotificationRow(doc)),
    });
  } catch (err) {
    console.error("PATCH /notifications/:id/read error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
