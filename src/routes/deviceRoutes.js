import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { isMongoConnected } from "../mongo.js";
import { Device } from "../models/Remaining.js";
import { Counter } from "../models/Counter.js";
import { findProfileByUid } from "../services/userProfiles.js";

const router = express.Router();

router.post("/devices/register", requireAppAuth, async (req, res) => {
  if (isMongoConnected()) {
    const { uid } = req.auth;
    const incomingToken = req.body?.token ?? req.body?.fcm_token;
    const platform = typeof req.body?.platform === "string" && req.body.platform.trim()
      ? req.body.platform.trim().toLowerCase() : "android";
    if (!incomingToken || typeof incomingToken !== "string") return res.status(400).json({ message: "token is required" });
    const token = incomingToken.trim();
    if (token.length < 20) return res.status(400).json({ message: "Invalid token" });
    if (!["android", "ios", "web"].includes(platform)) return res.status(400).json({ message: "Invalid platform" });
    const profile = await findProfileByUid(uid);
    if (!profile) return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
    try {
      await Device.deleteMany({ fcm_token: token, user_id: { $ne: profile.public_id } });
      await Device.findOneAndUpdate(
        { user_id: profile.public_id, platform },
        { $set: { fcm_token: token, is_active: true, updated_at: new Date() }, $setOnInsert: { public_id: await Counter.nextPublicId("devices") } },
        { upsert: true, returnDocument: "after", runValidators: true }
      );
      console.info("[devices] register.success", { userId: Number(profile.public_id), platform });
      return res.json({ ok: true });
    } catch (error) {
      if (error?.code === 11000) return res.status(409).json({ message: "Device token already registered" });
      console.error("devices/register error:", error?.message || error);
      return res.status(500).json({ message: "Server error" });
    }
  }

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

    console.info("[devices] register.success", {
      userId: Number(userId),
      platform,
      tokenPreview: `${token.slice(0, 8)}...${token.slice(-8)}`,
    });

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
