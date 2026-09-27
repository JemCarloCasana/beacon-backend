import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { Notification, ReducedUserProfile as UserProfile } from "../models/Reduced.js";
import { parseObjectId } from "../utils/objectId.js";

if (!getApps().length) {
  initializeApp({ credential: applicationDefault() });
}

export async function sendBroadcastPush({ broadcastId, title, body, data = {} }) {
  const result = { successCount: 0, failureCount: 0, removedTokensCount: 0 };
  let stage = "recipient_lookup";
  const recordError = () => {
    result.error = "Push delivery incomplete";
    console.error("Broadcast push failure", { broadcastId, stage });
  };
  try {
    if (typeof broadcastId !== "string" || !/^[a-f\d]{24}$/i.test(broadcastId)) {
      recordError();
      return result;
    }
    const deliveries = await Notification.find(
      { record_type: "broadcast_delivery", "source.type": "broadcast", "source.id": parseObjectId(broadcastId) }, { recipient_id: 1 }
    ).lean();
    const recipientIds = [...new Map(deliveries.map((entry) => [entry.recipient_id.toString(), entry.recipient_id])).values()];
    if (!recipientIds.length) return result;

    stage = "device_lookup";
    const users = await UserProfile.find({ _id: { $in: recipientIds } }).select({ devices: 1 }).lean();
    const tokens = [...new Set(users.flatMap((user) => user.devices).filter((device) => device.platform === "android" && device.is_active).map((device) => device.fcm_token).filter(Boolean))];
    const badTokens = [];
    for (let offset = 0; offset < tokens.length; offset += 500) {
      const batch = tokens.slice(offset, offset + 500);
      stage = "send";
      try {
        const response = await getMessaging().sendEachForMulticast({
          tokens: batch,
          notification: { title, body },
          data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])),
        });
        result.successCount += response.successCount;
        result.failureCount += response.failureCount;
        response.responses.forEach((entry, index) => {
          if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]
            .includes(entry.error?.code)) badTokens.push(batch[index]);
        });
        if (response.failureCount > 0) recordError();
      } catch {
        // A rejected batch has an unknown delivery outcome, not confirmed failures.
        result.unknownCount = (result.unknownCount ?? 0) + batch.length;
        recordError();
      }
    }
    if (badTokens.length) {
      stage = "token_cleanup";
      await UserProfile.updateMany(
        { "devices.fcm_token": { $in: badTokens } },
        { $set: { "devices.$[device].is_active": false, "devices.$[device].updated_at": new Date() } },
        { arrayFilters: [{ "device.fcm_token": { $in: badTokens } }] }
      );
      result.removedTokensCount = badTokens.length;
    }
  } catch {
    recordError();
  }
  return result;
}
