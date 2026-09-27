import express from "express";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { Counter } from "../models/Counter.js";
import { EmergencyContact } from "../models/Remaining.js";
import { findProfileByUid } from "../services/userProfiles.js";

const router = express.Router();

const PHONE_REGEX = /^(?:\+639\d{9}|09\d{9})$/;

function normalizePH(phone) {
  if (!phone) return null;
  const p = phone.replace(/\s+/g, "").replace(/-/g, "");
  if (p.startsWith("09")) return "+63" + p.substring(1);
  return p;
}

/**
 * GET /contacts
 * Returns ALL contacts for logged-in user, including relation + is_primary.
 */
router.get("/contacts", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const profile = await findProfileByUid(uid);
  if (!profile) return res.status(404).json({ message: "User not found" });
  const contacts = await EmergencyContact.find({ owner_user_id: profile.public_id })
    .sort({ is_primary: -1, created_at: -1 }).lean();
  return res.json(contacts.map((contact) => ({
    id: Number(contact.public_id), contact_name: contact.contact_name, phone_number: contact.phone_number,
    relation: contact.relation ?? null, is_primary: Boolean(contact.is_primary), created_at: contact.created_at,
  })));
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

  const profile = await findProfileByUid(uid);
  if (!profile) return res.status(404).json({ message: "User not found" });
  if (primary && await EmergencyContact.countDocuments({ owner_user_id: profile.public_id, is_primary: true }) >= 3) {
    return res.status(400).json({ message: "Maximum of 3 primary contacts allowed" });
  }

  try {
    const contact = await EmergencyContact.create({
      public_id: await Counter.nextPublicId("emergency_contacts"), owner_user_id: profile.public_id,
      contact_name: contact_name.trim(), phone_number: normalized, relation: rel, is_primary: primary,
    });
    return res.status(201).json({ id: contact.public_id, contact_name: contact.contact_name, phone_number: contact.phone_number, relation: contact.relation, is_primary: contact.is_primary, created_at: contact.created_at });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "Contact already exists" });
    }
    throw error;
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

  const profile = await findProfileByUid(uid);
  if (!profile) return res.status(404).json({ message: "User not found" });

  try {
    const contact = await EmergencyContact.findOneAndUpdate(
      { public_id: contactId, owner_user_id: profile.public_id },
      { $set: { contact_name: contact_name.trim(), phone_number: normalized, relation: rel, updated_at: new Date() } },
      { returnDocument: "after", runValidators: true }
    ).lean();
    if (!contact) return res.status(404).json({ message: "Contact not found" });
    return res.json({ id: contact.public_id, contact_name: contact.contact_name, phone_number: contact.phone_number, relation: contact.relation, is_primary: contact.is_primary, created_at: contact.created_at });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "Contact already exists" });
    }
    throw error;
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

  const profile = await findProfileByUid(uid);
  if (!profile) return res.status(404).json({ message: "User not found" });
  if (is_primary && await EmergencyContact.countDocuments({ owner_user_id: profile.public_id, is_primary: true, public_id: { $ne: contactId } }) >= 3) {
    return res.status(400).json({ message: "Maximum of 3 primary contacts allowed" });
  }
  const contact = await EmergencyContact.findOneAndUpdate(
    { public_id: contactId, owner_user_id: profile.public_id }, { $set: { is_primary } },
    { returnDocument: "after", runValidators: true }
  ).lean();
  if (!contact) return res.status(404).json({ message: "Contact not found" });
  return res.json({ id: contact.public_id, contact_name: contact.contact_name, phone_number: contact.phone_number, relation: contact.relation, is_primary: contact.is_primary, created_at: contact.created_at });
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

  const profile = await findProfileByUid(uid);
  if (!profile) return res.status(404).json({ message: "User not found" });
  const deleted = await EmergencyContact.findOneAndDelete({ public_id: contactId, owner_user_id: profile.public_id }).lean();
  if (!deleted) return res.status(404).json({ message: "Contact not found" });
  return res.json({ ok: true });
});

export default router;
