import express from "express";
import mongoose from "mongoose";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import admin from "../firebaseAdmin.js";
import { appendThreadStatusEvent, createSosThreadWithRootEvent, publishSosDeltaBySosId } from "../services/sosLiveOps.js";
import { AdminRecord, FriendConnection, Notification, ReducedUserProfile as UserProfile, SosRecord } from "../models/Reduced.js";
import { findProfileByUid } from "../services/userProfiles.js";
import { parseObjectId } from "../utils/objectId.js";
import { getServiceAreaError } from "../utils/serviceArea.js";
import { getThreadStateAnyStatus, listLiveThreads, parseLiveListParams } from "../services/sosLiveOps.js";
import { recordSosLocation } from "../services/sosLocationHistory.js";

const router = express.Router();
const SOS_CATEGORIES = new Set(["medical", "fire", "violence", "unknown"]);
const SOS_TERMINAL_STATUSES = new Set(["cancelled", "safe"]);
const SOS_TERMINAL_SOURCES = new Set(["android"]);
const IS_DEBUG_LOG = String(process.env.LOG_LEVEL || "").toLowerCase() === "debug";

function mobileSnapshot(snapshot, userId) {
  return { ...snapshot, can_close: snapshot.user_id === userId.toString() && snapshot.latest_status === "active" };
}

async function canReadCase(thread, userId) {
  return thread.user_id.equals(userId) || Boolean(await FriendConnection.exists({ record_type: "friendship", user_ids: { $all: [userId, thread.user_id] } }));
}

router.get("/sos/live", requireAppAuth, async (req, res) => {
  res.set?.("Cache-Control", "no-store");
  const parsed = parseLiveListParams({ ...req.query, status: "active" });
  if (!parsed.ok) return res.status(400).json({ message: parsed.message });
  const userId = req.userProfile._id;
  const friendships = await FriendConnection.find({ record_type: "friendship", user_ids: userId }).lean();
  const userIds = [userId, ...friendships.flatMap(row => row.user_ids.filter(id => !id.equals(userId)))];
  const { rows, nextCursor } = await listLiveThreads({ ...parsed.params, userIds });
  return res.json({ rows: rows.map(row => mobileSnapshot(row, userId)), next_cursor: nextCursor });
});

router.get("/sos/:sosId/live", requireAppAuth, async (req, res) => {
  const sosId = parseObjectId(req.params.sosId);
  if (!sosId) return res.status(400).json({ message: "Invalid sosId" });
  const thread = await SosRecord.findOne({ root_event_id: sosId, record_type: "case" }).lean();
  if (!thread) return res.status(404).json({ message: "SOS not found" });
  if (!await canReadCase(thread, req.userProfile._id)) return res.status(403).json({ message: "SOS access is no longer available" });
  const snapshot = await getThreadStateAnyStatus(sosId);
  res.set?.("Cache-Control", "no-store");
  return res.json(mobileSnapshot(snapshot, req.userProfile._id));
});

router.patch("/sos/:sosId/location", requireAppAuth, async (req, res) => {
  const { latitude, longitude } = req.body ?? {};
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return res.status(400).json({ code: "INVALID_LOCATION", message: "Provide valid latitude and longitude." });
  const sosId = parseObjectId(req.params.sosId);
  if (!sosId) return res.status(400).json({ message: "Invalid sosId" });
  const thread = await SosRecord.findOne({ root_event_id: sosId, record_type: "case" }).lean();
  if (!thread) return res.status(404).json({ message: "SOS not found" });
  if (!thread.user_id.equals(req.userProfile._id)) return res.status(403).json({ message: "Only the owner may update SOS location" });
  const now = new Date();
  const updated = await SosRecord.findOneAndUpdate(
    { _id: thread._id, record_type: "case", user_id: req.userProfile._id, latest_status: "active" },
    { $set: { latitude, longitude, location_updated_at: now, updated_at: now } },
    { returnDocument: "after" }
  ).lean();
  if (!updated) return res.status(409).json({ message: "SOS is no longer active" });
  const snapshot = mobileSnapshot(await getThreadStateAnyStatus(sosId), req.userProfile._id);
  void recordSosLocation({ ...snapshot, latest_latitude: latitude, latest_longitude: longitude, location_updated_at: now });
  void publishSosDeltaBySosId(sosId).catch(() => {});
  return res.json(snapshot);
});

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

  const adminIds = (await AdminRecord.find({ record_type: "account", status: "active", permissions: "manage_sos" }).select({ _id: 1 }).lean()).map((row) => row._id);
  if (adminIds.length === 0) {
    console.warn("[sos-routes] No active admin recipients for SOS notification", {
      sosId: sosId.toString()
    });
    return;
  }

  const docs = [];
  for (const recipientAdminId of adminIds) {
    docs.push({
      record_type: "admin",
      recipient_type: "admin",
      recipient_id: recipientAdminId,
      type: "sos",
      title: alertTitle,
      message: alertMessage,
      metadata: {
        reference_id: sosId.toString(),
        sos_id: sosId.toString(),
        fallback_route: `/admin/sos/${sosId.toString()}`,
      },
      source: { type: "sos_record", id: sosId },
      is_read: false,
      created_at: new Date(),
    });
  }
  const insertedDocs = await Notification.insertMany(docs, { ordered: false });
  const recipientCount = Array.isArray(insertedDocs) ? insertedDocs.length : 0;
  logDebug("notifications.insert", {
    sosId: sosId.toString(),
    category,
    recipientCount
  });
  if (recipientCount === 0) {
    console.warn("[sos-routes] No active admin recipients for SOS notification", {
      sosId: sosId.toString()
    });
  }
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
  const { latitude, longitude, address, message } = req.body ?? {};

  const locationError = getServiceAreaError(latitude, longitude);
  if (locationError) {
    return res.status(locationError.statusCode).json({ code: locationError.code, message: locationError.message });
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

  const mongoProfile = await findProfileByUid(uid);
  if (!mongoProfile) return res.status(404).json({ message: "User not found" });
  const userId = mongoProfile._id;
  const fullName = mongoProfile.full_name || "Unknown";
  {
    try {
      const eventId = new mongoose.Types.ObjectId();
      const threadId = new mongoose.Types.ObjectId();
      const now = new Date();
      await createSosThreadWithRootEvent({
        event: { _id: eventId, user_id: userId, sos_id: eventId, thread_id: threadId, latitude: latitude ?? undefined, longitude: longitude ?? undefined, address: address ?? undefined, message: message ?? undefined, status: "active", actor_type: "user", event_type: "report_created", emergency_category: normalizedCategory, created_at: now },
        thread: { _id: threadId, root_event_id: eventId, user_id: userId, latitude, longitude, location_updated_at: now, latest_status: "active", emergency_category: normalizedCategory, created_at: now, updated_at: now },
      });
      void recordSosLocation({ sos_id: eventId.toString(), user_id: userId.toString(), latest_status: "active", latest_latitude: latitude, latest_longitude: longitude, location_updated_at: now });
      publishSosDeltaBySosId(eventId).catch(() => {});
      await notifyAdminsAboutSos({ sosId: eventId, fullName, category: normalizedCategory }).catch(() => {});
      const friendshipRows = await FriendConnection.find({ record_type: "friendship", user_ids: userId }).lean();
      const friendIds = [...new Map(friendshipRows.flatMap((row) => row.user_ids.filter((id) => !id.equals(userId)).map((id) => [id.toString(), id]))).values()];
      const friends = friendIds.length ? await UserProfile.find({ _id: { $in: friendIds }, status: "active" }).select({ devices: 1 }).lean() : [];
      const tokens = [...new Set(friends.flatMap((friend) => friend.devices).filter((device) => device.is_active).map((device) => device.fcm_token).filter(Boolean))];
      if (!tokens.length) return res.status(200).json({ sos_id: eventId.toString(), category: normalizedCategory, notified_users: friendIds.length, notified_devices: 0, message: friendIds.length ? "SOS created, but no device tokens found for your friends." : "SOS created, but you have no Beacon friends to notify." });
      try {
        const resp = await admin.messaging().sendEachForMulticast({ tokens, notification: { title: "SOS Alert", body: `${fullName} needs help. Tap to view details.` }, data: { type: "SOS", sos_id: eventId.toString(), category: normalizedCategory, sender_name: String(fullName), sender_user_id: userId.toString() }, android: { priority: "high" } });
        return res.status(200).json({ sos_id: eventId.toString(), category: normalizedCategory, notified_users: friendIds.length, notified_devices: resp.successCount, failed_devices: resp.failureCount });
      } catch { return res.status(200).json({ sos_id: eventId.toString(), category: normalizedCategory, notified_users: friendIds.length, notified_devices: 0, message: "SOS created, but push notification failed." }); }
    } catch (err) { console.error("Create Mongo SOS event error:", err); return res.status(500).json({ message: "Failed to create SOS event" }); }
  }

});

router.patch("/sos/:sosId/status", requireAppAuth, async (req, res) => {
  const sosId = parseObjectId(req.params.sosId);
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

  const mongoUser = await findProfileByUid(req.auth.uid);
  if (!mongoUser) return res.status(404).json({ message: "User not found" });
  {
    const userId = mongoUser._id;
    const thread = await SosRecord.findOne({ root_event_id: sosId, record_type: "case" }).lean();
    if (!thread) return res.status(404).json({ message: "SOS thread not found" });
    if (!thread.user_id.equals(userId)) return res.status(403).json({ message: "Only the owner may close this SOS" });
    if (thread.latest_status !== "active") return res.status(409).json({ message: `Cannot update SOS in status '${thread.latest_status}'` });
    const resolvedAt = parsedResolvedAt.value ? new Date(parsedResolvedAt.value) : new Date();
    try {
      await appendThreadStatusEvent({
        thread,
        sosId,
        threadUpdates: { latest_status: "resolved", terminal_status: status, resolved_source: source?.trim().toLowerCase(), resolved_at: resolvedAt },
        event: { user_id: userId, status, actor_type: "user", event_type: "status_update" },
        createdAt: resolvedAt,
      });
    } catch (err) {
      if (err?.statusCode === 409) return res.status(409).json({ message: `Cannot update SOS in status '${thread.latest_status}'` });
      throw err;
    }
    publishSosDeltaBySosId(sosId).catch(() => {});
    return res.status(200).json({ sos_id: sosId.toString(), status, resolved_at: resolvedAt });
  }
});

export default router;
