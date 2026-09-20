import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { pool } from "../db.js";
import { BroadcastDelivery } from "../models/BroadcastDelivery.js";
import { isMongoConnected } from "../mongo.js";
import { Device } from "../models/Remaining.js";

if (!getApps().length) {
  initializeApp({ credential: applicationDefault() });
}

export async function sendBroadcastPush({ broadcastId = null, broadcastPublicId = null, title, body, data = {} }) {
  const targetPublicId = Number(broadcastPublicId ?? broadcastId);
  const result = { successCount: 0, failureCount: 0, removedTokensCount: 0 };
  let stage = "recipient_lookup";
  const recordError = () => {
    result.error = "Push delivery incomplete";
    console.error("Broadcast push failure", { broadcastId: targetPublicId, stage });
  };
  try {
    // A missing/invalid ID must never widen the audience to every device.
    if (!Number.isSafeInteger(targetPublicId) || targetPublicId <= 0) {
      recordError();
      return result;
    }
    const deliveries = await BroadcastDelivery.find(
      { broadcast_public_id: targetPublicId }, { recipient_user_id: 1 }
    ).lean();
    const recipientIds = [...new Set(deliveries.map((entry) => Number(entry.recipient_user_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!recipientIds.length) return result;

    stage = "device_lookup";
    const deviceRows = isMongoConnected()
      ? await Device.find({ user_id: { $in: recipientIds }, platform: "android", is_active: true }).select({ fcm_token: 1 }).lean()
      : (await pool.query(
        `SELECT DISTINCT fcm_token FROM devices WHERE user_id = ANY($1) AND platform = 'android' AND fcm_token IS NOT NULL`,
        [recipientIds]
      )).rows;
    const tokens = [...new Set(deviceRows.map((row) => row.fcm_token).filter(Boolean))];
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
      if (isMongoConnected()) await Device.updateMany({ fcm_token: { $in: badTokens } }, { $set: { is_active: false, updated_at: new Date() } });
      else await pool.query("DELETE FROM devices WHERE fcm_token = ANY($1)", [badTokens]);
      result.removedTokensCount = badTokens.length;
    }
  } catch {
    recordError();
  }
  return result;
}
