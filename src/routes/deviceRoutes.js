import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

router.post("/devices/register", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { uid } = req.auth;
    const { fcm_token, platform } = req.body;

    if (!fcm_token || typeof fcm_token !== "string" || fcm_token.length < 20) {
      return res.status(400).json({ message: "Invalid fcm_token" });
    }

    const plat =
      typeof platform === "string" && platform.trim()
        ? platform.trim()
        : "android";

    // Find user in Postgres
    const userRes = await client.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
    }

    const userId = userRes.rows[0].id;

    await client.query("BEGIN");

    // ✅ 1) Remove token from any old record (prevents UNIQUE token crash)
    await client.query(
      `DELETE FROM devices
       WHERE fcm_token = $1`,
      [fcm_token]
    );

    // ✅ 2) Upsert by (user_id, platform)
    const result = await client.query(
      `INSERT INTO devices (user_id, fcm_token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, platform)
       DO UPDATE SET
         fcm_token = EXCLUDED.fcm_token,
         updated_at = NOW()
       RETURNING id, user_id, fcm_token, platform, created_at, updated_at`,
      [userId, fcm_token, plat]
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);

  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("DEVICES_REGISTER ERROR:", err);

    // nicer response for unique errors
    if (err?.code === "23505") {
      return res.status(409).json({ message: "Device token conflict. Try again." });
    }

    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

export default router;
