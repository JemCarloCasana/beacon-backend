import express from "express";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { Device } from "../models/Remaining.js";
import { Counter } from "../models/Counter.js";
import { findProfileByUid } from "../services/userProfiles.js";

const router = express.Router();

router.post("/devices/register", requireAppAuth, async (req, res) => {
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
});

export default router;
