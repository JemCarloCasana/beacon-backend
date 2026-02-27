import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";

const router = express.Router();

const PHONE_REGEX = /^(?:\+639\d{9}|09\d{9})$/;

function normalizePH(phone) {
  if (!phone) return null;
  const p = phone.replace(/\s+/g, "").replace(/-/g, "");
  if (p.startsWith("09")) return "+63" + p.substring(1);
  return p;
}

async function getUserIdByFirebaseUid(uid) {
  const userRes = await pool.query(
    "SELECT id FROM users WHERE firebase_uid = $1",
    [uid]
  );
  if (userRes.rowCount === 0) return null;
  return userRes.rows[0].id;
}

/**
 * GET /contacts
 * Returns ALL contacts for logged-in user, including relation + is_primary.
 */
router.get("/contacts", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const userId = await getUserIdByFirebaseUid(uid);
  if (!userId) return res.status(404).json({ message: "User not found" });

  const r = await pool.query(
    `SELECT id, contact_name, phone_number, relation, is_primary, created_at
     FROM emergency_contacts
     WHERE owner_user_id = $1
     ORDER BY is_primary DESC, created_at DESC`,
    [userId]
  );

  res.json(r.rows);
});

/**
 * POST /contacts
 * Body: { contact_name, phone_number, relation?, is_primary? }
 */
router.post("/contacts", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const { contact_name, phone_number, relation, is_primary } = req.body;

  if (!contact_name || typeof contact_name !== "string" || contact_name.trim().length < 2) {
    return res.status(400).json({ message: "Invalid contact_name" });
  }

  if (!phone_number || typeof phone_number !== "string" || !PHONE_REGEX.test(phone_number)) {
    return res.status(400).json({ message: "Invalid phone_number" });
  }

  const normalized = normalizePH(phone_number);
  const rel = typeof relation === "string" ? relation.trim() : null;
  const primary = typeof is_primary === "boolean" ? is_primary : false;

  const userId = await getUserIdByFirebaseUid(uid);
  if (!userId) return res.status(404).json({ message: "User not found" });

  try {
    const r = await pool.query(
      `INSERT INTO emergency_contacts (owner_user_id, contact_name, phone_number, relation, is_primary)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, contact_name, phone_number, relation, is_primary, created_at`,
      [userId, contact_name.trim(), normalized, rel, primary]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    // duplicate phone for same owner (uq_emergency_contact_owner_phone)
    if (e.code === "23505") {
      return res.status(409).json({ message: "Contact already exists" });
    }
    // trigger: max 3 primary contacts
    if (e.code === "P0001") {
      return res.status(400).json({ message: e.message });
    }
    throw e;
  }
});

/**
 * PATCH /contacts/:id
 * Body: { contact_name, phone_number, relation? }
 */
router.patch("/contacts/:id", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const contactId = Number(req.params.id);

  if (!Number.isFinite(contactId)) {
    return res.status(400).json({ message: "Invalid id" });
  }

  const { contact_name, phone_number, relation } = req.body;

  if (!contact_name || typeof contact_name !== "string" || contact_name.trim().length < 2) {
    return res.status(400).json({ message: "Invalid contact_name" });
  }

  if (!phone_number || typeof phone_number !== "string" || !PHONE_REGEX.test(phone_number)) {
    return res.status(400).json({ message: "Invalid phone_number" });
  }

  const normalized = normalizePH(phone_number);
  const rel = typeof relation === "string" ? relation.trim() : null;

  const userId = await getUserIdByFirebaseUid(uid);
  if (!userId) return res.status(404).json({ message: "User not found" });

  try {
    const r = await pool.query(
      `UPDATE emergency_contacts
       SET contact_name = $1,
           phone_number = $2,
           relation = $3
       WHERE id = $4 AND owner_user_id = $5
       RETURNING id, contact_name, phone_number, relation, is_primary, created_at`,
      [contact_name.trim(), normalized, rel, contactId, userId]
    );

    if (r.rowCount === 0) return res.status(404).json({ message: "Contact not found" });

    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505") {
      return res.status(409).json({ message: "Contact already exists" });
    }
    throw e;
  }
});

/**
 * PATCH /contacts/:id/primary
 * Body: { is_primary: boolean }
 * Sets/unsets primary status.
 */
router.patch("/contacts/:id/primary", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const contactId = Number(req.params.id);

  if (!Number.isFinite(contactId)) {
    return res.status(400).json({ message: "Invalid id" });
  }

  const { is_primary } = req.body;
  if (typeof is_primary !== "boolean") {
    return res.status(400).json({ message: "Invalid is_primary" });
  }

  const userId = await getUserIdByFirebaseUid(uid);
  if (!userId) return res.status(404).json({ message: "User not found" });

  try {
    const r = await pool.query(
      `UPDATE emergency_contacts
       SET is_primary = $1
       WHERE id = $2 AND owner_user_id = $3
       RETURNING id, contact_name, phone_number, relation, is_primary, created_at`,
      [is_primary, contactId, userId]
    );

    if (r.rowCount === 0) return res.status(404).json({ message: "Contact not found" });

    res.json(r.rows[0]);
  } catch (e) {
    // trigger: max 3 primary contacts
    if (e.code === "P0001") {
      return res.status(400).json({ message: e.message });
    }
    throw e;
  }
});

/**
 * DELETE /contacts/:id
 */
router.delete("/contacts/:id", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const contactId = Number(req.params.id);

  if (!Number.isFinite(contactId)) {
    return res.status(400).json({ message: "Invalid id" });
  }

  const userId = await getUserIdByFirebaseUid(uid);
  if (!userId) return res.status(404).json({ message: "User not found" });

  const del = await pool.query(
    `DELETE FROM emergency_contacts
     WHERE id = $1 AND owner_user_id = $2
     RETURNING id`,
    [contactId, userId]
  );

  if (del.rowCount === 0) {
    return res.status(404).json({ message: "Contact not found" });
  }

  res.json({ ok: true });
});

export default router;
