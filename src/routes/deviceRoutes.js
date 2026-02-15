import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

router.post("/devices/register", requireAuth, async (req, res) => {
  const { uid } = req.auth;
  const { fcm_token, platform } = req.body;

  if (!fcm_token || typeof fcm_token !== "string" || fcm_token.length < 20) {
    return res.status(400).json({ message: "Invalid fcm_token" });
  }

  // get current user id from Postgres
  const userRes = await pool.query(
    "SELECT id FROM users WHERE firebase_uid = $1",
    [uid]
  );

  if (userRes.rowCount === 0) {
    return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
  }

  const userId = userRes.rows[0].id;

  // upsert by fcm_token uniqueness
  const result = await pool.query(
    `INSERT INTO devices (user_id, fcm_token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (fcm_token)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       platform = EXCLUDED.platform,
       updated_at = NOW()
     RETURNING id, user_id, fcm_token, platform, created_at, updated_at`,
    [userId, fcm_token, platform || "android"]
  );

  res.json(result.rows[0]);
});

export default router;
