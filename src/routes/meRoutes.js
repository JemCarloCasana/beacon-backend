import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

// ✅ Phone validation + normalization (PH)
const PHONE_REGEX = /^(?:\+63|0)\d{10}$/;

function normalizePH(phone) {
  if (!phone) return null;
  const p = String(phone).replace(/\s+/g, "").replace(/-/g, "");
  if (p.startsWith("09") && p.length === 11) return "+63" + p.substring(1);
  if (p.startsWith("+63") && p.length === 13) return p;
  return p; // return as-is (validation will reject bad ones)
}

// ✅ Beacon code generator (server-side source of truth)
function generateBeaconCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoids I,O,1,0 confusion
  let code = "BCN-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function createUniqueBeaconCode(client) {
  for (let i = 0; i < 10; i++) {
    const code = generateBeaconCode();
    const exists = await client.query("SELECT 1 FROM users WHERE beacon_code = $1", [code]);
    if (exists.rowCount === 0) return code;
  }
  throw new Error("Failed to generate unique beacon code");
}

/**
 * POST /me/bootstrap
 * Ensures a Postgres profile exists for the current Firebase user.
 * Call after signup (best) or login if needed.
 *
 * Adds: beacon_code (generated once)
 */
router.post("/me/bootstrap", requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { uid, email } = req.auth;
    const { full_name, phone_number } = req.body;

    // Validation (name)
    if (!full_name || typeof full_name !== "string" || !/^[A-Za-z ]{2,50}$/.test(full_name.trim())) {
      return res.status(400).json({ message: "Invalid full_name" });
    }

    // Validation (phone, optional but recommended)
    let normalizedPhone = null;
    if (phone_number != null && String(phone_number).trim() !== "") {
      const raw = String(phone_number).trim();
      if (!PHONE_REGEX.test(raw)) {
        return res.status(400).json({ message: "Invalid phone_number" });
      }
      normalizedPhone = normalizePH(raw);
    }

    await client.query("BEGIN");

    // Check if user already exists (by firebase_uid)
    const existing = await client.query(
      `SELECT id, beacon_code
       FROM users
       WHERE firebase_uid = $1`,
      [uid]
    );

    let beaconCode = existing.rowCount > 0 ? existing.rows[0].beacon_code : null;

    // If missing beacon_code (legacy users), generate one
    if (!beaconCode) {
      beaconCode = await createUniqueBeaconCode(client);
    }

    // Upsert by firebase_uid, but keep beacon_code stable once set
    const result = await client.query(
      `INSERT INTO users (firebase_uid, email, full_name, phone_number, beacon_code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (firebase_uid)
       DO UPDATE SET
         email = EXCLUDED.email,
         full_name = EXCLUDED.full_name,
         phone_number = EXCLUDED.phone_number,
         beacon_code = COALESCE(users.beacon_code, EXCLUDED.beacon_code),
         updated_at = NOW()
       RETURNING id, firebase_uid, email, full_name, phone_number, beacon_code, role, created_at, updated_at`,
      [uid, email, full_name.trim(), normalizedPhone, beaconCode]
    );

    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("BOOTSTRAP ERROR:", e);

    // If beacon_code uniqueness ever collides (rare), retry by returning clear error
    if (e?.code === "23505") {
      return res.status(409).json({ message: "Conflict. Please try again." });
    }

    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

/**
 * GET /me
 * Returns the Postgres user profile for the current Firebase user.
 */
router.get("/me", requireAuth, async (req, res) => {
  const { uid } = req.auth;

  const result = await pool.query(
    `SELECT id, firebase_uid, email, full_name, phone_number, beacon_code, role, created_at, updated_at
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
