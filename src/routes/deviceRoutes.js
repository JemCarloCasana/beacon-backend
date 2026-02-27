import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";

const router = express.Router();

router.post("/devices/register", requireAppAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const { uid } = req.auth;
    const incomingToken = req.body?.token ?? req.body?.fcm_token;
    const platform = typeof req.body?.platform === "string" && req.body.platform.trim()
      ? req.body.platform.trim()
      : "android";

    if (!incomingToken || typeof incomingToken !== "string") {
      return res.status(400).json({ message: "token is required" });
    }

    const token = incomingToken.trim();
    if (token.length < 20) {
      return res.status(400).json({ message: "Invalid token" });
    }

    const userRes = await client.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
    }

    const userId = userRes.rows[0].id;

    await client.query("BEGIN");

    await client.query(
      `
      DELETE FROM devices
      WHERE fcm_token = $1
      `,
      [token]
    );

    await client.query(
      `
      INSERT INTO devices (user_id, fcm_token, platform)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, platform)
      DO UPDATE SET
        fcm_token = EXCLUDED.fcm_token,
        updated_at = NOW()
      `,
      [userId, token, platform]
    );

    await client.query("COMMIT");

    return res.json({ ok: true });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("devices/register error:", err);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
