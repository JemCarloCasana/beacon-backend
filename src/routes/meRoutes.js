import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";

const router = express.Router();

// ✅ Phone validation + normalization (PH)
const PHONE_REGEX = /^(?:\+63|0)\d{10}$/;
const PATCH_PHONE_REGEX = /^\+?\d{10,20}$/;
const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_SELECT_FIELDS = `
  id,
  firebase_uid,
  email,
  full_name,
  phone_number,
  role,
  profile_image_url,
  beacon_code,
  created_at,
  updated_at
`;

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

function userToDto(row) {
  return {
    id: row.id,
    firebase_uid: row.firebase_uid,
    email: row.email,
    full_name: row.full_name,
    phone_number: row.phone_number,
    role: row.role,
    profile_image_url: row.profile_image_url ?? null
  };
}

function validateOptionalEmail(email) {
  if (email == null) return null;
  if (typeof email !== "string" || !SIMPLE_EMAIL_REGEX.test(email.trim())) {
    throw new Error("Invalid email");
  }
  return email.trim().toLowerCase();
}

function validateOptionalFullName(fullName) {
  if (fullName == null) return null;
  if (typeof fullName !== "string") {
    throw new Error("Invalid full_name");
  }
  const normalized = fullName.trim();
  if (normalized.length < 2 || normalized.length > 50) {
    throw new Error("Invalid full_name");
  }
  return normalized;
}

function validateOptionalPatchPhone(phoneNumber) {
  if (phoneNumber == null) return null;
  if (typeof phoneNumber !== "string") {
    throw new Error("Invalid phone_number");
  }
  const normalized = phoneNumber.trim();
  if (!PATCH_PHONE_REGEX.test(normalized)) {
    throw new Error("Invalid phone_number");
  }
  return normalized;
}

function validateOptionalProfileImageUrl(profileImageUrl) {
  if (profileImageUrl == null) return null;
  if (typeof profileImageUrl !== "string" || !profileImageUrl.trim()) {
    throw new Error("Invalid profile_image_url");
  }
  const normalized = profileImageUrl.trim();
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Invalid profile_image_url");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid profile_image_url");
  }
  return normalized;
}

/**
 * POST /me/bootstrap
 * Ensures a Postgres profile exists for the current Firebase user.
 * Call after signup (best) or login if needed.
 *
 * Adds: beacon_code (generated once)
 */
router.post("/me/bootstrap", requireAppAuth, async (req, res) => {
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
       RETURNING ${USER_SELECT_FIELDS}`,
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
router.get("/me", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const result = await pool.query(
    `SELECT ${USER_SELECT_FIELDS}
     FROM users
     WHERE firebase_uid = $1`,
    [uid]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
  }

  return res.json(result.rows[0]);
});

/**
 * PATCH /me
 * Partially updates current authenticated user's profile.
 */
router.patch("/me", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const { full_name, email, phone_number, profile_image_url } = req.body || {};

  let normalizedFullName;
  let normalizedEmail;
  let normalizedPhoneNumber;
  let normalizedProfileImageUrl;

  try {
    normalizedFullName = validateOptionalFullName(full_name);
    normalizedEmail = validateOptionalEmail(email);
    normalizedPhoneNumber = validateOptionalPatchPhone(phone_number);
    normalizedProfileImageUrl = validateOptionalProfileImageUrl(profile_image_url);
  } catch (err) {
    return res.status(400).json({ message: err?.message || "Invalid request body" });
  }

  const updates = [];
  const values = [];

  if (full_name != null) {
    updates.push(`full_name = $${values.length + 1}`);
    values.push(normalizedFullName);
  }
  if (email != null) {
    updates.push(`email = $${values.length + 1}`);
    values.push(normalizedEmail);
  }
  if (phone_number != null) {
    updates.push(`phone_number = $${values.length + 1}`);
    values.push(normalizedPhoneNumber);
  }
  if (profile_image_url != null) {
    updates.push(`profile_image_url = $${values.length + 1}`);
    values.push(normalizedProfileImageUrl);
  }

  let result;

  if (updates.length > 0) {
    values.push(uid);
    result = await pool.query(
      `UPDATE users
       SET ${updates.join(", ")}, updated_at = NOW()
       WHERE firebase_uid = $${values.length}
       RETURNING ${USER_SELECT_FIELDS}`,
      values
    );
  } else {
    result = await pool.query(
      `SELECT ${USER_SELECT_FIELDS}
       FROM users
       WHERE firebase_uid = $1`,
      [uid]
    );
  }

  if (result.rowCount === 0) {
    return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
  }

  return res.json(userToDto(result.rows[0]));
});

/**
 * GET /users
 * Compatibility alias for clients expecting this route for current profile.
 * Requires Bearer auth and returns the authenticated user's profile.
 */
router.get("/users", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const result = await pool.query(
    `SELECT ${USER_SELECT_FIELDS}
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
