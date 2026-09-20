import { mongoose } from "../mongo.js";
import { pool } from "../db.js";
import { Broadcast, hasValidBroadcastAudience } from "../models/Broadcast.js";
import { BroadcastDelivery } from "../models/BroadcastDelivery.js";
import { isMongoConnected } from "../mongo.js";
import { UserProfile, Role } from "../models/Remaining.js";

function toPositiveIntegerOrNull(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function dedupeUserIds(values) {
  const seen = new Set();
  for (const value of values ?? []) {
    const id = toPositiveIntegerOrNull(value);
    if (id != null) {
      seen.add(id);
    }
  }
  return [...seen];
}

async function resolveAudienceRecipientIds(broadcast) {
  if (broadcast.audience_type === "all") {
    if (isMongoConnected()) {
      const users = await UserProfile.find({ status: { $ne: "deactivated" } }).select({ public_id: 1 }).lean();
      return dedupeUserIds(users.map((user) => user.public_id));
    }
    const result = await pool.query(`SELECT id FROM users`);
    return dedupeUserIds(result.rows.map((row) => row.id));
  }

  if (broadcast.audience_type === "role") {
    const roles = Array.isArray(broadcast.audience_roles)
      ? broadcast.audience_roles
          .filter((role) => typeof role === "string" && role.trim())
          .map((role) => role.trim().toLowerCase())
      : [];
    if (roles.length > 0) {
      if (isMongoConnected()) {
        const users = await UserProfile.find({ role: { $in: roles }, status: { $ne: "deactivated" } }).select({ public_id: 1 }).lean();
        return dedupeUserIds(users.map((user) => user.public_id));
      }
      const result = await pool.query(`SELECT id FROM users WHERE lower(role) = ANY($1)`, [
        roles,
      ]);
      return dedupeUserIds(result.rows.map((row) => row.id));
    }

    const roleIds = Array.isArray(broadcast.audience_role_ids)
      ? [...new Set(broadcast.audience_role_ids.map((id) => toPositiveIntegerOrNull(id)).filter(Boolean))]
      : [];
    if (roleIds.length > 0) {
      if (isMongoConnected()) {
        const roleRows = await Role.find({ public_id: { $in: roleIds } }).select({ name: 1 }).lean();
        const roleNames = roleRows.map((role) => String(role.name).toLowerCase());
        const users = await UserProfile.find({ role: { $in: roleNames }, status: { $ne: "deactivated" } }).select({ public_id: 1 }).lean();
        return dedupeUserIds(users.map((user) => user.public_id));
      }
      const result = await pool.query(
        `
        SELECT u.id
        FROM users u
        WHERE lower(u.role) IN (
          SELECT lower(r.name)
          FROM roles r
          WHERE r.id = ANY($1)
        )
        `,
        [roleIds]
      );
      return dedupeUserIds(result.rows.map((row) => row.id));
    }
  }

  return [];
}

export async function sendBroadcastByPublicId(broadcastId) {
  const session = await mongoose.startSession();

  try {
    return await session.withTransaction(async () => {
      const now = new Date();
      const updated = await Broadcast.findOneAndUpdate(
        { public_id: broadcastId, sent_at: null },
        { $set: { sent_at: now, updated_at: now } },
        { new: true, session }
      ).lean();

      if (!updated) {
        const existing = await Broadcast.findOne({ public_id: broadcastId }, null, { session }).lean();
        return existing ? { status: "already_sent" } : { status: "not_found" };
      }

      if (!hasValidBroadcastAudience(updated)) {
        throw new Error("Invalid stored broadcast audience");
      }
      const recipientIds = await resolveAudienceRecipientIds(updated);

      let deliveredCount = 0;
      if (recipientIds.length > 0) {
        const docs = recipientIds.map((recipientUserId) => ({
          broadcast_id: updated._id,
          broadcast_public_id: updated.public_id,
          recipient_user_id: recipientUserId,
          delivered_at: now,
          acknowledged_at: null,
        }));
        const inserted = await BroadcastDelivery.insertMany(docs, { ordered: false, session });
        deliveredCount = Array.isArray(inserted) ? inserted.length : 0;
      }

      return { status: "sent", broadcast: updated, deliveredCount };
    });
  } finally {
    try {
      await session.endSession();
    } catch {}
  }
}
