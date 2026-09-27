import express from "express";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { ReducedUserProfile as UserProfile } from "../models/Reduced.js";
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
    await UserProfile.updateMany(
      { _id: { $ne: profile._id }, "devices.fcm_token": token },
      { $pull: { devices: { fcm_token: token } } }
    );
    const tokenDevice = profile.devices.find((device) => device.fcm_token === token);
    if (tokenDevice && tokenDevice.platform !== platform) return res.status(409).json({ message: "Device token already registered" });
    const device = profile.devices.find((item) => item.platform === platform);
    if (device) {
      device.fcm_token = token;
      device.is_active = true;
      device.updated_at = new Date();
    } else {
      profile.devices.push({ fcm_token: token, platform, is_active: true });
    }
    await profile.save();
    console.info("[devices] register.success", { userId: profile._id.toString(), platform });
    return res.json({ ok: true });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: "Device token already registered" });
    console.error("devices/register error:", error?.message || error);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
