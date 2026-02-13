import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

/**
 * POST /me/bootstrap
 * Ensures a Postgres profile exists for the current Firebase user.
 * Call after login/signup.
 */
router.post("/me/bootstrap", requireAuth, async (req, res) => {
  const { uid, email } = req.auth;
  const { full_name, phone_number } = req.body;

  // Validation (same rule as Android)
  if (!full_name || !/^[A-Za-z ]{2,50}$/.test(full_name)) {
    return res.status(400).json({ message: "Invalid full_name" });
  }

  // Upsert by firebase_uid
  const result = await pool.query(
    `INSERT INTO users (firebase_uid, email, full_name, phone_number)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (firebase_uid)
     DO UPDATE SET
       email = EXCLUDED.email,
       full_name = EXCLUDED.full_name,
       phone_number = EXCLUDED.phone_number
     RETURNING id, firebase_uid, email, full_name, phone_number, role, created_at, updated_at`,
    [uid, email, full_name, phone_number || null]
  );

  return res.json(result.rows[0]);
});

/**
 * GET /me
 * Returns the Postgres user profile for the current Firebase user.
 */
router.get("/me", requireAuth, async (req, res) => {
  const { uid } = req.auth;

  const result = await pool.query(
    `SELECT id, firebase_uid, email, full_name, phone_number, role, created_at, updated_at
     FROM users
     WHERE firebase_uid = $1`,
    [uid]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
  }

  return res.json(result.rows[0]);
});

export default router;
