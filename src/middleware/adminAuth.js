import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { auditLog } from "../utils/auditLog.js";
import { isMongoConnected } from "../mongo.js";
import { AdminAccount } from "../models/Remaining.js";

const JWT_SECRET = process.env.ADMIN_JWT_SECRET;

const router = express.Router();
const DEACTIVATED_MESSAGE = "Account is deactivated";

export function assertAccountActive(account) {
  if (account?.status === "deactivated") {
    return { ok: false, statusCode: 403, message: DEACTIVATED_MESSAGE };
  }
  return { ok: true };
}

export async function getAdminAuthAccount(adminId) {
  if (isMongoConnected()) {
    const account = await AdminAccount.findOne({ public_id: adminId }).select({ public_id: 1, status: 1 }).lean();
    return account ? { id: Number(account.public_id), status: account.status } : null;
  }
  const result = await pool.query(
    `
    SELECT id, status
    FROM admins
    WHERE id = $1
    LIMIT 1
    `,
    [adminId]
  );
  return result.rows[0] ?? null;
}

export async function getAdminPermissions(adminId) {
  if (isMongoConnected()) {
    const account = await AdminAccount.findOne({ public_id: adminId }).select({ permission_names: 1 }).lean();
    return account?.permission_names ?? [];
  }
  const result = await pool.query(
    `
    SELECT COALESCE(array_agg(DISTINCT p.name) FILTER (WHERE p.name IS NOT NULL), '{}') AS permissions
    FROM admins a
    JOIN roles r ON r.id = a.role_id
    LEFT JOIN role_permissions rp ON rp.role_id = r.id
    LEFT JOIN permissions p ON p.id = rp.permission_id
    WHERE a.id = $1
    `,
    [adminId]
  );

  return result.rows[0]?.permissions ?? [];
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      auditLog({ action: "admin.auth", target: `${req.method} ${req.path}`, outcome: "missing_token" });
      return res.status(401).json({ message: "Missing Bearer token" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const parsedAdminId = Number(decoded.adminId ?? decoded.sub);
    if (!Number.isInteger(parsedAdminId) || parsedAdminId <= 0) {
      auditLog({ action: "admin.auth", target: `${req.method} ${req.path}`, outcome: "invalid_token" });
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const account = await getAdminAuthAccount(parsedAdminId);
    if (!account) {
      auditLog({ action: "admin.auth", actor: parsedAdminId, target: `${req.method} ${req.path}`, outcome: "unknown_account" });
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    const activeCheck = assertAccountActive(account);
    if (!activeCheck.ok) {
      auditLog({ action: "admin.auth", actor: parsedAdminId, target: `${req.method} ${req.path}`, outcome: "deactivated" });
      return res.status(activeCheck.statusCode).json({ message: activeCheck.message });
    }

    req.admin = {
      adminId: parsedAdminId,
      role: decoded.role,
      roleId: decoded.roleId
    };

    next();
  } catch (err) {
    auditLog({ action: "admin.auth", target: `${req.method} ${req.path}`, outcome: "invalid_or_expired" });
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

export function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      if (!req.admin?.adminId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const permissions = await getAdminPermissions(req.admin.adminId);
      
      if (!permissions.includes(permission)) {
        auditLog({
          action: "auth.forbidden",
          actor: req.admin.adminId,
          target: `${req.method} ${req.path}`,
          outcome: "denied",
          details: { permission },
        });
        return res.status(403).json({ message: "Insufficient permissions" });
      }

      next();
    } catch (err) {
      console.error("Permission check error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  };
}

export const requireAdminAuth = requireAuth;

/**
 * GET /admin/personnel
 * Returns all personnel/admin accounts
 * Permission required: manage_users
 */
router.get(
  "/admin/personnel",
  requireAuth,
  requirePermission("manage_users"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT 
          a.id,
          a.email,
          a.full_name,
          r.name AS role,
          a.role_id,
          a.created_at
        FROM admins a
        JOIN roles r ON r.id = a.role_id
        ORDER BY a.created_at DESC
        `
      );

      return res.json(result.rows);
    } catch (err) {
      console.error("Error fetching personnel:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

export default router;
