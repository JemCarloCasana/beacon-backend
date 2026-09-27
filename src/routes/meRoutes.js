import express from "express";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { bootstrapProfile, findProfileByUid, profileToDto, searchProfiles } from "../services/userProfiles.js";

const router = express.Router();

// ✅ Phone validation + normalization (PH)
const PHONE_REGEX = /^(?:\+63|0)\d{10}$/;
const PATCH_PHONE_REGEX = /^\+?\d{10,20}$/;
const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APP_USER_ROLES = new Set(["citizen", "student"]);
const USER_SEARCH_MIN_QUERY_LENGTH = 2;
const USER_SEARCH_LIMIT = 20;
function normalizePH(phone) {
  if (!phone) return null;
  const p = String(phone).replace(/\s+/g, "").replace(/-/g, "");
  if (p.startsWith("09") && p.length === 11) return "+63" + p.substring(1);
  if (p.startsWith("+63") && p.length === 13) return p;
  return p; // return as-is (validation will reject bad ones)
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

function normalizeAppUserRole(role) {
  if (typeof role !== "string") return null;
  const normalized = role.trim().toLowerCase();
  if (!APP_USER_ROLES.has(normalized)) return null;
  return normalized;
}

function normalizeSearchQuery(rawQuery) {
  return String(rawQuery ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function isValidBootstrapFullName(value) {
  return typeof value === "string"
    && /^[\p{L}][\p{L}\s.'-]{1,49}$/u.test(value.trim());
}

/**
 * POST /me/bootstrap
 * Ensures a profile exists for the current Firebase user.
 * Call after signup (best) or login if needed.
 *
 * Adds: beacon_code (generated once)
 */
router.post("/me/bootstrap", requireAppAuth, async (req, res) => {
  const { uid, email } = req.auth;
  const { full_name, phone_number, role } = req.body ?? {};

  if (!full_name || !isValidBootstrapFullName(full_name)) {
    return res.status(400).json({ message: "Invalid full_name" });
  }

  let normalizedPhone = null;
  if (phone_number != null && String(phone_number).trim() !== "") {
    const raw = String(phone_number).trim();
    if (!PHONE_REGEX.test(raw)) return res.status(400).json({ message: "Invalid phone_number" });
    normalizedPhone = normalizePH(raw);
  }

  const normalizedRole = normalizeAppUserRole(role);
  if (!normalizedRole) return res.status(400).json({ message: "Invalid role" });

  try {
    const profile = await bootstrapProfile({
      uid,
      email,
      fullName: full_name.trim(),
      phoneNumber: normalizedPhone,
      role: normalizedRole,
    });
    return res.json(profileToDto(profile));
  } catch (error) {
    console.error("BOOTSTRAP ERROR:", error?.message || error);
    if (error?.code === 11000) return res.status(409).json({ message: "Conflict. Please try again." });
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /me
 * Returns the current Firebase user's profile.
 */
router.get("/me", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const profile = await findProfileByUid(uid);
  if (!profile) return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
  return res.json(profileToDto(profile));
});

/**
 * PATCH /me
 * Partially updates current authenticated user's profile.
 */
router.patch("/me", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const { full_name, email, phone_number, role, profile_image_url } = req.body || {};

  let normalizedFullName;
  let normalizedEmail;
  let normalizedPhoneNumber;
  let normalizedRole;
  let normalizedProfileImageUrl;

  try {
    normalizedFullName = validateOptionalFullName(full_name);
    normalizedEmail = validateOptionalEmail(email);
    normalizedPhoneNumber = validateOptionalPatchPhone(phone_number);
    if (role != null) {
      normalizedRole = normalizeAppUserRole(role);
      if (!normalizedRole) {
        throw new Error("Invalid role");
      }
    }
    normalizedProfileImageUrl = validateOptionalProfileImageUrl(profile_image_url);
  } catch (err) {
    return res.status(400).json({ message: err?.message || "Invalid request body" });
  }

  const profile = await findProfileByUid(uid);
  if (!profile) return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
  if (full_name != null) profile.full_name = normalizedFullName;
  if (email != null) profile.email = normalizedEmail;
  if (phone_number != null) profile.phone_number = normalizedPhoneNumber;
  if (role != null) profile.role = normalizedRole;
  if (profile_image_url != null) profile.profile_image_url = normalizedProfileImageUrl;
  profile.updated_at = new Date();
  try {
    await profile.save();
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: "Conflict. Please try again." });
    throw error;
  }
  return res.json(profileToDto(profile));
});

/**
 * GET /users
 * Compatibility alias for clients expecting this route for current profile.
 * Requires Bearer auth and returns the authenticated user's profile.
 */
router.get("/users", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const profile = await findProfileByUid(uid);
  if (!profile) return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
  return res.json(profileToDto(profile));
});

/**
 * GET /users/search?q=...
 * Searches app users by full_name and returns lightweight discovery results.
 */
router.get("/users/search", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const normalizedQuery = normalizeSearchQuery(req.query.q);

  if (normalizedQuery.length < USER_SEARCH_MIN_QUERY_LENGTH) {
    return res.status(400).json({
      message: `Search query must be at least ${USER_SEARCH_MIN_QUERY_LENGTH} characters`,
    });
  }

  const results = await searchProfiles({ uid, query: normalizedQuery, limit: USER_SEARCH_LIMIT });
  if (!results) return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
  return res.json(results);
});

export default router;
