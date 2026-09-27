import { mongoose } from "../mongo.js";
import { ReducedBroadcast as Broadcast, ReducedUserProfile as UserProfile, Notification } from "../models/Reduced.js";

function dedupeIds(values) {
  return [...new Map(values.map((value) => [value.toString(), value])).values()];
}

async function resolveAudienceRecipientIds(broadcast) {
  const filter = { status: { $ne: "deactivated" } };
  if (broadcast.audience_type === "role") filter.role = { $in: broadcast.audience_roles ?? [] };
  const users = await UserProfile.find(filter).select({ _id: 1 }).lean();
  return dedupeIds(users.map((user) => user._id));
}

export async function sendBroadcastById(broadcastId) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const now = new Date();
      const updated = await Broadcast.findOneAndUpdate(
        { _id: broadcastId, sent_at: null },
        { $set: { sent_at: now, updated_at: now } },
        { new: true, session }
      ).lean();
      if (!updated) {
        const existing = await Broadcast.findById(broadcastId, null, { session }).lean();
        return existing ? { status: "already_sent" } : { status: "not_found" };
      }

      const recipientIds = await resolveAudienceRecipientIds(updated);
      if (recipientIds.length) await Notification.insertMany(recipientIds.map((recipientId) => ({
        record_type: "broadcast_delivery",
        recipient_type: "user",
        recipient_id: recipientId,
        type: "broadcast",
        title: updated.title,
        message: updated.body,
        source: { type: "broadcast", id: updated._id },
        is_read: false,
        delivered_at: now,
        acknowledged_at: null,
        created_at: now,
      })), { ordered: false, session });
      return { status: "sent", broadcast: updated, deliveredCount: recipientIds.length };
    });
  } finally {
    await session.endSession();
  }
}
