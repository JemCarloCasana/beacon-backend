import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { assertAccountActive } from "../middleware/adminAuth.js";
import { AdminRecord } from "../models/Reduced.js";
import {
  SIGNUP_ROLE,
  buildValidationError,
  validateLoginPayload,
  validateSignupPayload
} from "../utils/adminAuthValidation.js";
import { auditLog } from "../utils/auditLog.js";

const router = express.Router();
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!JWT_SECRET) throw new Error("Missing ADMIN_JWT_SECRET in .env");

const DEFAULT_ADMIN_JWT_TTL = "7d";

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

function logAdminLoginDebug({ submittedEmail, adminFound, status, compareResult }) {
  console.debug("[admin-auth] login-debug", {
    submittedEmail,
    adminFound,
    status,
    compareResult
  });
}

// POST /admin/auth/signup
router.post("/admin/auth/signup", async (req, res) => {
  let email = null;
  try {
    const { errors, normalized } = validateSignupPayload(req.body);
    if (Object.keys(errors).length > 0) {
      return res.status(422).json(buildValidationError(errors));
    }
    email = normalized.email;

    const existing = await AdminRecord.findOne({ record_type: "account", email: normalized.email }).select({ _id: 1 }).lean();
    if (existing) {
      auditLog({ action: "admin.signup", actor: null, target: normalized.email, outcome: "duplicate_email" });
      return res.status(409).json({ message: "Email already registered" });
    }
    const password_hash = await bcrypt.hash(normalized.password, 12);
    const admin = await AdminRecord.create({
      record_type: "account", email: normalized.email,
      password_hash, full_name: normalized.full_name, role: SIGNUP_ROLE, permissions: [],
    });
    const permissions = admin.permissions ?? [];
    const token = jwt.sign(
      { sub: admin._id.toString(), adminId: admin._id.toString(), role: SIGNUP_ROLE },
      JWT_SECRET, { expiresIn: jwtTtl.ttl }
    );
    auditLog({ action: "admin.signup", actor: admin._id.toString(), target: admin.email, outcome: "created" });
    return res.status(201).json({ token, admin: { id: admin._id.toString(), email: admin.email, full_name: admin.full_name, role: SIGNUP_ROLE, permissions } });
    } catch (e) {
      if (e?.code === 11000) {
        auditLog({ action: "admin.signup", actor: null, target: email, outcome: "duplicate_email" });
        return res.status(409).json({ message: "Email already registered" });
      }
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /admin/auth/login
router.post("/admin/auth/login", async (req, res) => {
  try {
    const { errors, normalized } = validateLoginPayload(req.body);
    if (Object.keys(errors).length > 0) {
      return res.status(422).json(buildValidationError(errors));
    }

    const row = await AdminRecord.findOne({ record_type: "account", email: normalized.email }).lean();
    if (!row) {
      logAdminLoginDebug({ submittedEmail: normalized.email, adminFound: false, status: null, compareResult: null });
      auditLog({ action: "admin.login", actor: null, target: normalized.email, outcome: "invalid_credentials" });
      return res.status(401).json({ message: "Invalid credentials" });
    }
    logAdminLoginDebug({
      submittedEmail: normalized.email,
      adminFound: true,
      status: row.status,
      compareResult: null
    });

    const ok = await bcrypt.compare(normalized.password, row.password_hash);
    logAdminLoginDebug({
      submittedEmail: normalized.email,
      adminFound: true,
      status: row.status,
      compareResult: ok
    });

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
    const token = jwt.sign(
      { sub: row._id.toString(), adminId: row._id.toString(), role: row.role },
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

export default router;
