import { pool } from "../db.js";
import { requireAuth } from "./requireAuth.js";

function sanitizeName(name) {
  if (typeof name !== "string") return null;
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.slice(0, 50);
}

function deriveNameFromEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) return "Beacon User";
  const local = email.split("@")[0];
  const normalized = local
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Beacon User";
  return normalized.slice(0, 50);
}

function buildBootstrapProfile(decoded) {
  const email = typeof decoded.email === "string" && decoded.email.trim()
    ? decoded.email.trim().toLowerCase().slice(0, 320)
    : `${decoded.uid}@firebase.local`;
  const fullName = sanitizeName(decoded.name) || deriveNameFromEmail(email);

  return { email, fullName };
}

function generateBeaconCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "BCN-";
  for (let i = 0; i < 6; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function upsertUserFromToken(decoded) {
  const { email, fullName } = buildBootstrapProfile(decoded);

  for (let i = 0; i < 10; i += 1) {
    const beaconCode = generateBeaconCode();
    try {
      await pool.query(
        `
        INSERT INTO users (firebase_uid, full_name, email, beacon_code)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (firebase_uid)
        DO UPDATE SET
          email = EXCLUDED.email,
          updated_at = NOW(),
          beacon_code = COALESCE(users.beacon_code, EXCLUDED.beacon_code)
        `,
        [decoded.uid, fullName, email, beaconCode]
      );
      return;
    } catch (err) {
      if (err?.code === "23505") continue;
      throw err;
    }
  }

  throw new Error("Unable to generate unique beacon code after retries");
}

export async function requireAppAuth(req, res, next) {
  return requireAuth(req, res, async () => {
    try {
      await upsertUserFromToken(req.auth.claims);
      return next();
    } catch (err) {
      console.error("App auth bootstrap error:", err?.message || err);
      return res.status(500).json({ message: "Unable to initialize user profile" });
    }
  });
}
