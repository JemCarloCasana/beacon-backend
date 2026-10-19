import express from "express";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { findProfileById } from "../services/userProfiles.js";
import { parseObjectId } from "../utils/objectId.js";

const router = express.Router();

/**
 * GET /users/:id/public
 * Returns limited public info to a signed-in Beacon user.
 */
router.get("/users/:id/public", requireAppAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const objectId = parseObjectId(id);
    if (!objectId) return res.status(400).json({ message: "Invalid user id" });
    const profile = await findProfileById(objectId);
    if (!profile) return res.status(404).json({ message: "User not found" });
    return res.json({ id: profile._id.toString(), full_name: profile.full_name, beacon_code: profile.beacon_code });
  } catch (err) {
    console.error("GET /users/:id/public error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
