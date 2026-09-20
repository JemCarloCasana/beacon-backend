import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import admin from "../firebaseAdmin.js";
import { publishSosDeltaBySosId } from "../services/sosLiveOps.js";
import { AdminNotification } from "../models/AdminNotification.js";
import { Counter } from "../models/Counter.js";
import { isMongoConnected } from "../mongo.js";
import { UserProfile, AdminAccount, Friendship, Device, SosThread, SosEvent } from "../models/Remaining.js";
import { findProfileByUid } from "../services/userProfiles.js";

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

  const adminIds = isMongoConnected()
    ? (await AdminAccount.find({ status: "active" }).select({ public_id: 1 }).lean()).map((row) => Number(row.public_id))
    : (await pool.query(
    `
    SELECT id
    FROM admins
    WHERE status = 'active'
    `
  )).rows.map((row) => Number(row.id));
  if (adminIds.length === 0) {
    console.warn("[sos-routes] No active admin recipients for SOS notification", {
      sosId: Number(sosId)
    });
    return;
  }

  const docs = [];
  for (const recipientAdminId of adminIds) {
    docs.push({
      public_id: await Counter.nextPublicId("notifications"),
      recipient_admin_id: recipientAdminId,
      type: "sos",
      title: alertTitle,
      message: alertMessage,
      metadata: {
        reference_id: Number(sosId),
        sos_id: Number(sosId),
        fallback_route: `/admin/sos/${Number(sosId)}`,
      },
      is_read: false,
      created_at: new Date(),
    });
  }
  const insertedDocs = await AdminNotification.insertMany(docs, { ordered: false });
  const recipientCount = Array.isArray(insertedDocs) ? insertedDocs.length : 0;
  logDebug("notifications.insert", {
    sosId: Number(sosId),
    category,
    recipientCount
  });
  if (recipientCount === 0) {
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

  const mongoProfile = isMongoConnected() ? await findProfileByUid(uid) : null;
  const userRes = mongoProfile ? null : await pool.query(
    "SELECT id, full_name FROM users WHERE firebase_uid = $1",
    [uid]
  );
  if (!mongoProfile && userRes.rowCount === 0) {
    return res.status(404).json({ message: "User not found" });
  }

  const userId = Number(mongoProfile?.public_id ?? userRes.rows[0].id);
  const fullName = mongoProfile?.full_name || userRes?.rows[0]?.full_name || "Unknown";

  let sosId = null;
  let threadId = null;
  if (isMongoConnected()) {
    try {
      const eventId = await Counter.nextPublicId("sos_events");
      const threadId = await Counter.nextPublicId("sos_threads");
      const now = new Date();
      await SosEvent.create({ public_id: eventId, user_id: userId, sos_id: eventId, thread_id: threadId, latitude: latitude ?? undefined, longitude: longitude ?? undefined, address: address ?? undefined, message: message ?? undefined, status: "active", actor_type: "user", event_type: "report_created", emergency_category: normalizedCategory, created_at: now });
      await SosThread.create({ public_id: threadId, root_event_id: eventId, user_id: userId, latest_status: "active", emergency_category: normalizedCategory, created_at: now, updated_at: now });
      publishSosDeltaBySosId(eventId).catch(() => {});
      await notifyAdminsAboutSos({ sosId: eventId, fullName, category: normalizedCategory }).catch(() => {});
      const friendIds = (await Friendship.find({ $or: [{ user_id: userId }, { friend_user_id: userId }] }).lean()).map((row) => Number(row.user_id) === userId ? Number(row.friend_user_id) : Number(row.user_id));
      const tokens = friendIds.length ? (await Device.find({ user_id: { $in: friendIds }, is_active: true, fcm_token: { $exists: true, $ne: "" } }).distinct("fcm_token")) : [];
      if (!tokens.length) return res.status(200).json({ sos_id: String(eventId), category: normalizedCategory, notified_users: friendIds.length, notified_devices: 0, message: friendIds.length ? "SOS created, but no device tokens found for your friends." : "SOS created, but you have no Beacon friends to notify." });
      try {
        const resp = await admin.messaging().sendEachForMulticast({ tokens, notification: { title: "SOS Alert", body: `${fullName} needs help. Tap to view details.` }, data: { type: "SOS", sos_id: String(eventId), category: normalizedCategory, sender_name: String(fullName), sender_user_id: String(userId) }, android: { priority: "high" } });
        return res.status(200).json({ sos_id: String(eventId), category: normalizedCategory, notified_users: friendIds.length, notified_devices: resp.successCount, failed_devices: resp.failureCount });
      } catch { return res.status(200).json({ sos_id: String(eventId), category: normalizedCategory, notified_users: friendIds.length, notified_devices: 0, message: "SOS created, but push notification failed." }); }
    } catch (err) { console.error("Create Mongo SOS event error:", err); return res.status(500).json({ message: "Failed to create SOS event" }); }
  }

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
    `SELECT CASE
              WHEN user_id = $1 THEN friend_user_id
              ELSE user_id
            END AS friend_user_id
     FROM friendships
     WHERE $1 IN (user_id, friend_user_id)`,
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

  const mongoUser = isMongoConnected() ? await findProfileByUid(req.auth.uid) : null;
  if (mongoUser) {
    const userId = Number(mongoUser.public_id);
    const thread = await SosThread.findOne({ root_event_id: sosId }).lean();
    if (!thread) return res.status(404).json({ message: "SOS thread not found" });
    if (Number(thread.user_id) !== userId) {
      const friendship = await Friendship.exists({ $or: [{ user_id: userId, friend_user_id: thread.user_id }, { user_id: thread.user_id, friend_user_id: userId }] });
      if (!friendship) return res.status(403).json({ message: "Forbidden" });
    }
    if (thread.latest_status !== "active") return res.status(409).json({ message: `Cannot update SOS in status '${thread.latest_status}'` });
    const resolvedAt = parsedResolvedAt.value ? new Date(parsedResolvedAt.value) : new Date();
    await SosThread.updateOne({ public_id: thread.public_id, latest_status: "active" }, { $set: { latest_status: "resolved", terminal_status: status, resolved_source: source?.trim().toLowerCase(), resolved_at: resolvedAt, updated_at: new Date() } });
    const latest = await SosEvent.findOne({ thread_id: thread.public_id }).sort({ created_at: -1, public_id: -1 }).lean();
    await SosEvent.create({ public_id: await Counter.nextPublicId("sos_events"), user_id: userId, sos_id: sosId, thread_id: thread.public_id, latitude: latest?.latitude, longitude: latest?.longitude, address: latest?.address, status, actor_type: "user", event_type: "status_update", emergency_category: thread.emergency_category, created_at: resolvedAt });
    publishSosDeltaBySosId(sosId).catch(() => {});
    return res.status(200).json({ sos_id: String(sosId), status, resolved_at: resolvedAt });
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
    const ownerUserId = Number(latest.user_id);
    if (ownerUserId !== userId) {
      const friendshipRes = await client.query(
        `
        SELECT 1
        FROM friendships
        WHERE (user_id = $1 AND friend_user_id = $2)
           OR (user_id = $2 AND friend_user_id = $1)
        LIMIT 1
        `,
        [ownerUserId, userId]
      );
      if (friendshipRes.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Forbidden" });
      }
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
