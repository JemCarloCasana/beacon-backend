import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { assertAccountActive, getAdminPermissions } from "../middleware/adminAuth.js";
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

async function getRoleIdByName(roleName) {
  const r = await pool.query("SELECT id FROM roles WHERE name = $1", [roleName]);
  return r.rowCount ? r.rows[0].id : null;
}

// POST /admin/auth/signup
router.post("/admin/auth/signup", async (req, res) => {
  try {
    const { errors, normalized } = validateSignupPayload(req.body);
    if (Object.keys(errors).length > 0) {
      return res.status(422).json(buildValidationError(errors));
    }

    const roleId = await getRoleIdByName(SIGNUP_ROLE);
    if (!roleId) return res.status(500).json({ message: "Role configuration missing in DB" });

    const existing = await pool.query("SELECT id FROM admins WHERE lower(email) = $1", [normalized.email]);
    if (existing.rowCount > 0) {
      auditLog({ action: "admin.signup", actor: null, target: normalized.email, outcome: "duplicate_email" });
      return res.status(409).json({ message: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(normalized.password, 12);

    const inserted = await pool.query(
      `INSERT INTO admins (email, password_hash, full_name, role_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, role_id, created_at`,
      [normalized.email, password_hash, normalized.full_name, roleId]
    );

    const admin = inserted.rows[0];

    const permissions = await getAdminPermissions(admin.id);

    const token = jwt.sign(
      { sub: String(admin.id), adminId: admin.id, role: SIGNUP_ROLE, roleId: admin.role_id },
      JWT_SECRET,
      { expiresIn: jwtTtl.ttl }
    );

    auditLog({ action: "admin.signup", actor: admin.id, target: admin.email, outcome: "created" });

    return res.status(201).json({
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        full_name: admin.full_name,
        role: SIGNUP_ROLE,
        role_id: admin.role_id,
        permissions
      }
    });
    } catch (e) {
      if (e?.code === "23505") {
        auditLog({ action: "admin.signup", actor: null, target: normalized.email, outcome: "duplicate_email" });
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

    const result = await pool.query(
      `SELECT a.id, a.email, a.full_name, a.password_hash, a.role_id, a.status, r.name AS role
       FROM admins a
       JOIN roles r ON r.id = a.role_id
       WHERE lower(a.email) = $1`,
      [normalized.email]
    );

    if (result.rowCount === 0) {
      logAdminLoginDebug({
        submittedEmail: normalized.email,
        adminFound: false,
        status: null,
        compareResult: null
      });
      auditLog({ action: "admin.login", actor: null, target: normalized.email, outcome: "invalid_credentials" });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const row = result.rows[0];
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
      auditLog({ action: "admin.login", actor: row.id, target: normalized.email, outcome: "invalid_credentials" });
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const activeCheck = assertAccountActive(row);
    if (!activeCheck.ok) {
      return res.status(activeCheck.statusCode).json({ message: activeCheck.message });
    }

    const permissions = await getAdminPermissions(row.id);
    const token = jwt.sign(
      { sub: String(row.id), adminId: row.id, role: row.role, roleId: row.role_id },
      JWT_SECRET,
      { expiresIn: jwtTtl.ttl }
    );

    auditLog({ action: "admin.login", actor: row.id, target: row.email, outcome: "success" });

    return res.json({
      token,
      admin: {
        id: row.id,
        email: row.email,
        full_name: row.full_name,
        role: row.role,
        role_id: row.role_id,
        permissions
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
