import express from "express";
import { pool } from "../db.js";
import { isMongoConnected } from "../mongo.js";
import { findProfileByPublicId } from "../services/userProfiles.js";

const router = express.Router();

/**
 * GET /users/:id/public
 * Returns limited public info (safe for friends)
 */
router.get("/users/:id/public", async (req, res) => {
  const { id } = req.params;

  if (!/^\d+$/.test(id)) return res.status(400).json({ message: "Invalid user id" });
  if (isMongoConnected()) {
    const profile = await findProfileByPublicId(Number(id));
    if (!profile) return res.status(404).json({ message: "User not found" });
    return res.json({ id: Number(profile.public_id), full_name: profile.full_name, beacon_code: profile.beacon_code });
  }

  const result = await pool.query(
    `SELECT id, full_name, beacon_code
     FROM users
     WHERE id = $1`,
    [id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ message: "User not found" });
  }

  res.json(result.rows[0]);
});

export default router;
