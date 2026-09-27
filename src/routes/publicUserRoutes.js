import express from "express";
import { findProfileById } from "../services/userProfiles.js";
import { parseObjectId } from "../utils/objectId.js";

const router = express.Router();

/**
 * GET /users/:id/public
 * Returns limited public info (safe for friends)
 */
router.get("/users/:id/public", async (req, res) => {
  const { id } = req.params;

  const objectId = parseObjectId(id);
  if (!objectId) return res.status(400).json({ message: "Invalid user id" });
  const profile = await findProfileById(objectId);
  if (!profile) return res.status(404).json({ message: "User not found" });
  return res.json({ id: profile._id.toString(), full_name: profile.full_name, beacon_code: profile.beacon_code });
});

export default router;
