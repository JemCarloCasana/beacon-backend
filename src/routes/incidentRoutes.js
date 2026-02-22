import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

/**
 * POST /incidents
 * Body: { incident_type, description, latitude?, longitude?, address? }
 */
router.post("/incidents", requireAuth, async (req, res) => {
  const { uid } = req.auth;
  const { incident_type, description, latitude, longitude, address } = req.body;

  if (!incident_type || typeof incident_type !== "string") {
    return res.status(400).json({ message: "Invalid incident_type" });
  }
  if (!description || typeof description !== "string" || description.trim().length < 5) {
    return res.status(400).json({ message: "Description must be at least 5 characters" });
  }
  if (latitude != null && typeof latitude !== "number") {
    return res.status(400).json({ message: "Invalid latitude" });
  }
  if (longitude != null && typeof longitude !== "number") {
    return res.status(400).json({ message: "Invalid longitude" });
  }
  if (address != null && typeof address !== "string") {
    return res.status(400).json({ message: "Invalid address" });
  }

  // Map firebase uid -> postgres user id
  const userRes = await pool.query(
    "SELECT id FROM users WHERE firebase_uid = $1",
    [uid]
  );

  if (userRes.rowCount === 0) {
    return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
  }

  const userId = userRes.rows[0].id;

  const insertRes = await pool.query(
    `INSERT INTO incident_reports (user_id, incident_type, description, latitude, longitude, address)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, incident_type, description, latitude, longitude, address, status, created_at`,
    [
      userId,
      incident_type.trim(),
      description.trim(),
      latitude ?? null,
      longitude ?? null,
      address ?? null
    ]
  );

  return res.status(201).json(insertRes.rows[0]);
});

export default router;