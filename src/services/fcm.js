import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { pool } from "../db.js";

if (!getApps().length) {
  initializeApp({ credential: applicationDefault() });
}

export async function sendBroadcastPush({ broadcastId = null, title, body, data = {} }) {
  const query = broadcastId
    ? {
        sql: `
          SELECT DISTINCT d.fcm_token
          FROM devices d
          JOIN broadcast_user_deliveries bud ON bud.user_id = d.user_id
          WHERE bud.broadcast_id = $1
            AND d.platform = 'android'
            AND d.fcm_token IS NOT NULL
        `,
        params: [broadcastId],
      }
    : {
        sql: `
          SELECT DISTINCT fcm_token
          FROM devices
          WHERE platform = 'android' AND fcm_token IS NOT NULL
        `,
        params: [],
      };

  const { rows } = await pool.query(query.sql, query.params);

  const tokens = rows.map((r) => r.fcm_token).filter(Boolean);
  if (tokens.length === 0) {
    return { successCount: 0, failureCount: 0, removedTokensCount: 0 };
  }

  const message = {
    tokens,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
  };

  const resp = await getMessaging().sendEachForMulticast(message);

  const badTokens = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || "";
      if (
        code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
      ) {
        badTokens.push(tokens[i]);
      }
    }
  });

  if (badTokens.length) {
    await pool.query(`DELETE FROM devices WHERE fcm_token = ANY($1)`, [badTokens]);
  }

  return {
    successCount: resp.successCount,
    failureCount: resp.failureCount,
    removedTokensCount: badTokens.length,
  };
}
