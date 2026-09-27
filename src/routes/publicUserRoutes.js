import express from "express";
import { findProfileByPublicId } from "../services/userProfiles.js";

const router = express.Router();

/**
 * GET /users/:id/public
 * Returns limited public info (safe for friends)
 */
router.get("/users/:id/public", async (req, res) => {
  const { id } = req.params;

  if (!/^\d+$/.test(id)) return res.status(400).json({ message: "Invalid user id" });
  const profile = await findProfileByPublicId(Number(id));
  if (!profile) return res.status(404).json({ message: "User not found" });
  return res.json({ id: Number(profile.public_id), full_name: profile.full_name, beacon_code: profile.beacon_code });
});

export default router;
