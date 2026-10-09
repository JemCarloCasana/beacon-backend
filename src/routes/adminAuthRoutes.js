import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { assertAccountActive, requireAdminAuth } from "../middleware/adminAuth.js";
import { AdminRecord } from "../models/Reduced.js";
import {
  buildValidationError,
  validateLoginPayload,
  validateAdminCreatePayload
} from "../utils/adminAuthValidation.js";
import { auditLog } from "../utils/auditLog.js";

const router = express.Router();
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!JWT_SECRET) throw new Error("Missing ADMIN_JWT_SECRET in .env");

const DEFAULT_ADMIN_JWT_TTL = "8h";

export function resolveAdminJwtTtl() {
  const allowTestTtl = String(process.env.ALLOW_TEST_JWT_TTL || "").toLowerCase() === "true";
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (allowTestTtl && !isProduction) {
    const testTtl = String(process.env.ADMIN_JWT_TEST_TTL || "").trim();
    if (testTtl) {
      return { ttl: testTtl, testHook: true };
    }
  }
  return { ttl: DEFAULT_ADMIN_JWT_TTL, testHook: false };
}

const jwtTtl = resolveAdminJwtTtl();
if (jwtTtl.testHook) {
  console.warn(`[admin-auth] TEST JWT TTL enabled: expiresIn=${jwtTtl.ttl} (never enable in production)`);
}

// POST /admin/auth/login
router.post("/admin/auth/login", async (req, res) => {
  try {
    const { errors, normalized } = validateLoginPayload(req.body);
    if (Object.keys(errors).length > 0) {
      return res.status(422).json(buildValidationError(errors));
    }

    const row = await AdminRecord.findOne({ record_type: "account", email: normalized.email }).lean();
    if (!row) {
      auditLog({ action: "admin.login", actor: null, target: normalized.email, outcome: "invalid_credentials" });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(normalized.password, row.password_hash);

    if (!ok) {
      auditLog({ action: "admin.login", actor: row._id.toString(), target: normalized.email, outcome: "invalid_credentials" });
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const activeCheck = assertAccountActive(row);
    if (!activeCheck.ok) {
      auditLog({ action: "admin.login", actor: row._id.toString(), target: normalized.email, outcome: "deactivated" });
      return res.status(activeCheck.statusCode).json({ message: activeCheck.message });
    }

    const permissions = row.permissions ?? [];
    if (row.token_version == null) await AdminRecord.updateOne({ _id: row._id, record_type: "account", token_version: { $exists: false } }, { $set: { token_version: 0 } });
    const token = jwt.sign(
      { sub: row._id.toString(), adminId: row._id.toString(), role: row.role, token_version: row.token_version ?? 0 },
      JWT_SECRET,
      { expiresIn: jwtTtl.ttl }
    );

    auditLog({ action: "admin.login", actor: row._id.toString(), target: row.email, outcome: "success" });

    return res.json({
      token,
      admin: {
        id: row._id.toString(),
        email: row.email,
        full_name: row.full_name,
        role: row.role,
        permissions
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/auth/logout", requireAdminAuth, async (req, res) => {
  try {
    const result = await AdminRecord.updateOne({ _id: req.admin.adminId, record_type: "account", token_version: req.admin.token_version }, { $inc: { token_version: 1 } });
    if (result.matchedCount !== 1) return res.status(401).json({ message: "Invalid or expired token" });
    return res.status(204).end();
  } catch { return res.status(503).json({ message: "Session invalidation unavailable" }); }
});

router.post("/admin/auth/change-password", requireAdminAuth, async (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  const { errors } = validateAdminCreatePayload({ email: "validation@example.com", full_name: "Validation Account", role: "personnel", password: new_password });
  if (typeof current_password !== "string" || errors.password) return res.status(422).json({ message: errors.password ?? "Current password is required" });
  try {
    const account = await AdminRecord.findOne({ _id: req.admin.adminId, record_type: "account" }).lean();
    if (!account || !await bcrypt.compare(current_password, account.password_hash)) return res.status(401).json({ message: "Current password is incorrect" });
    const password_hash = await bcrypt.hash(new_password, 12);
    const result = await AdminRecord.updateOne({ _id: account._id, record_type: "account", password_hash: account.password_hash, token_version: req.admin.token_version }, { $set: { password_hash, updated_at: new Date() }, $inc: { token_version: 1 } });
    if (result.matchedCount !== 1) return res.status(409).json({ message: "Account changed; sign in again" });
    return res.status(204).end();
  } catch { return res.status(503).json({ message: "Password update unavailable" }); }
});

export default router;
