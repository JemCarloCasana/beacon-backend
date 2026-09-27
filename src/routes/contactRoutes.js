import express from "express";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { findProfileByUid } from "../services/userProfiles.js";
import { parseObjectId } from "../utils/objectId.js";

const router = express.Router();
const PHONE_REGEX = /^(?:\+639\d{9}|09\d{9})$/;

function normalizePH(phone) {
  if (!phone) return null;
  const value = phone.replace(/\s+/g, "").replace(/-/g, "");
  return value.startsWith("09") ? `+63${value.substring(1)}` : value;
}

function contactDto(contact) {
  return {
    id: contact._id.toString(),
    contact_name: contact.contact_name,
    phone_number: contact.phone_number,
    relation: contact.relation ?? null,
    is_primary: Boolean(contact.is_primary),
    created_at: contact.created_at,
  };
}

router.get("/contacts", requireAppAuth, async (req, res) => {
  const profile = await findProfileByUid(req.auth.uid);
  if (!profile) return res.status(404).json({ message: "User not found" });
  const contacts = [...profile.emergency_contacts].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || b.created_at - a.created_at);
  return res.json(contacts.map(contactDto));
});

router.post("/contacts", requireAppAuth, async (req, res) => {
  const { contact_name, phone_number, relation, is_primary } = req.body ?? {};
  if (typeof contact_name !== "string" || contact_name.trim().length < 2) return res.status(400).json({ message: "Invalid contact_name" });
  if (typeof phone_number !== "string" || !PHONE_REGEX.test(phone_number)) return res.status(400).json({ message: "Invalid phone_number" });
  const profile = await findProfileByUid(req.auth.uid);
  if (!profile) return res.status(404).json({ message: "User not found" });
  const normalizedPhone = normalizePH(phone_number);
  if (profile.emergency_contacts.some((contact) => contact.phone_number === normalizedPhone)) return res.status(409).json({ message: "Contact already exists" });
  const primary = typeof is_primary === "boolean" ? is_primary : false;
  if (primary && profile.emergency_contacts.filter((contact) => contact.is_primary).length >= 3) return res.status(400).json({ message: "Maximum of 3 primary contacts allowed" });
  profile.emergency_contacts.push({ contact_name: contact_name.trim(), phone_number: normalizedPhone, relation: typeof relation === "string" ? relation.trim() : null, is_primary: primary });
  await profile.save();
  return res.status(201).json(contactDto(profile.emergency_contacts.at(-1)));
});

router.patch("/contacts/:id", requireAppAuth, async (req, res) => {
  const contactId = parseObjectId(req.params.id);
  if (!contactId) return res.status(400).json({ message: "Invalid id" });
  const { contact_name, phone_number, relation } = req.body ?? {};
  if (typeof contact_name !== "string" || contact_name.trim().length < 2) return res.status(400).json({ message: "Invalid contact_name" });
  if (typeof phone_number !== "string" || !PHONE_REGEX.test(phone_number)) return res.status(400).json({ message: "Invalid phone_number" });
  const profile = await findProfileByUid(req.auth.uid);
  if (!profile) return res.status(404).json({ message: "User not found" });
  const contact = profile.emergency_contacts.id(contactId);
  if (!contact) return res.status(404).json({ message: "Contact not found" });
  const normalizedPhone = normalizePH(phone_number);
  if (profile.emergency_contacts.some((item) => !item._id.equals(contactId) && item.phone_number === normalizedPhone)) return res.status(409).json({ message: "Contact already exists" });
  contact.contact_name = contact_name.trim();
  contact.phone_number = normalizedPhone;
  contact.relation = typeof relation === "string" ? relation.trim() : null;
  contact.updated_at = new Date();
  await profile.save();
  return res.json(contactDto(contact));
});

router.patch("/contacts/:id/primary", requireAppAuth, async (req, res) => {
  const contactId = parseObjectId(req.params.id);
  if (!contactId) return res.status(400).json({ message: "Invalid id" });
  if (typeof req.body?.is_primary !== "boolean") return res.status(400).json({ message: "Invalid is_primary" });
  const profile = await findProfileByUid(req.auth.uid);
  if (!profile) return res.status(404).json({ message: "User not found" });
  const contact = profile.emergency_contacts.id(contactId);
  if (!contact) return res.status(404).json({ message: "Contact not found" });
  if (req.body.is_primary && profile.emergency_contacts.filter((item) => item.is_primary && !item._id.equals(contactId)).length >= 3) return res.status(400).json({ message: "Maximum of 3 primary contacts allowed" });
  contact.is_primary = req.body.is_primary;
  contact.updated_at = new Date();
  await profile.save();
  return res.json(contactDto(contact));
});

router.delete("/contacts/:id", requireAppAuth, async (req, res) => {
  const contactId = parseObjectId(req.params.id);
  if (!contactId) return res.status(400).json({ message: "Invalid id" });
  const profile = await findProfileByUid(req.auth.uid);
  if (!profile) return res.status(404).json({ message: "User not found" });
  const contact = profile.emergency_contacts.id(contactId);
  if (!contact) return res.status(404).json({ message: "Contact not found" });
  contact.deleteOne();
  await profile.save();
  return res.json({ ok: true });
});

export default router;
