import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

const PHONE_REGEX = /^(?:\+639\d{9}|09\d{9})$/;

function normalizePH(phone) {
  if (!phone) return null;
  const p = phone.replace(/\s+/g, "").replace(/-/g, "");
  if (p.startsWith("09")) return "+63" + p.substring(1);
  return p;
}

// GET /contacts  (list my contacts)
router.get("/contacts", requireAuth, async (req, res) => {
  const { uid } = req.auth;

  const userRes = await pool.query(
    "SELECT id FROM users WHERE firebase_uid = $1",
    [uid]
  );
  if (userRes.rowCount === 0) return res.status(404).json({ message: "User not found" });

  const userId = userRes.rows[0].id;

  const r = await pool.query(
    `SELECT id, contact_name, phone_number, created_at
     FROM emergency_contacts
     WHERE owner_user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  res.json(r.rows);
});

// POST /contacts (add)
router.post("/contacts", requireAuth, async (req, res) => {
  const { uid } = req.auth;
  const { contact_name, phone_number } = req.body;

  if (!contact_name || typeof contact_name !== "string" || contact_name.trim().length < 2) {
    return res.status(400).json({ message: "Invalid contact_name" });
  }

  if (!phone_number || typeof phone_number !== "string" || !PHONE_REGEX.test(phone_number)) {
    return res.status(400).json({ message: "Invalid phone_number" });
  }

  const normalized = normalizePH(phone_number);

  const userRes = await pool.query(
    "SELECT id FROM users WHERE firebase_uid = $1",
    [uid]
  );
  if (userRes.rowCount === 0) return res.status(404).json({ message: "User not found" });

  const userId = userRes.rows[0].id;

  try {
    const r = await pool.query(
      `INSERT INTO emergency_contacts (owner_user_id, contact_name, phone_number)
       VALUES ($1, $2, $3)
       RETURNING id, contact_name, phone_number, created_at`,
      [userId, contact_name.trim(), normalized]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    // duplicate phone for same owner
    if (e.code === "23505") {
      return res.status(409).json({ message: "Contact already exists" });
    }
    throw e;
  }
});

// DELETE /contacts/:id (delete my contact)
router.delete("/contacts/:id", requireAuth, async (req, res) => {
  const { uid } = req.auth;
  const contactId = Number(req.params.id);

  if (!Number.isFinite(contactId)) {
    return res.status(400).json({ message: "Invalid id" });
  }

  const userRes = await pool.query(
    "SELECT id FROM users WHERE firebase_uid = $1",
    [uid]
  );
  if (userRes.rowCount === 0) return res.status(404).json({ message: "User not found" });

  const userId = userRes.rows[0].id;

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
