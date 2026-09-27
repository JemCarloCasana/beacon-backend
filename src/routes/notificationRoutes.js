import express from "express";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { normalizeUserNotificationRow, toUserNotificationRow } from "../services/userNotifications.js";
import { Notification } from "../models/Reduced.js";
import { findProfileByUid } from "../services/userProfiles.js";
import { parseObjectId } from "../utils/objectId.js";

const router = express.Router();

function applyNotificationNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, private, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Vary", "Authorization");
  res.set("Expires", "0");
}

async function getCurrentUserId(firebaseUid) {
  const profile = await findProfileByUid(firebaseUid);
  return profile?._id ?? null;
}

router.get("/notifications", requireAppAuth, async (req, res) => {
  try {
    applyNotificationNoStoreHeaders(res);
    const userId = await getCurrentUserId(req.auth?.uid);
    if (!userId) {
      return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
    }

    const docs = await Notification.find({ record_type: "user", recipient_type: "user", recipient_id: userId })
      .sort({ created_at: -1, _id: -1 })
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
    const notificationId = parseObjectId(req.params.id);
    if (!notificationId) {
      return res.status(400).json({ message: "Invalid notification id" });
    }

    const userId = await getCurrentUserId(req.auth?.uid);
    if (!userId) {
      return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
    }

    const doc = await Notification.findOneAndUpdate(
      { _id: notificationId, record_type: "user", recipient_id: userId },
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
