import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const JWT_SECRET = process.env.ADMIN_JWT_SECRET;

const router = express.Router();

export async function getAdminPermissions(adminId) {
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

    if (!token) return res.status(401).json({ message: "Missing Bearer token" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const parsedAdminId = Number(decoded.adminId ?? decoded.sub);
    if (!Number.isInteger(parsedAdminId) || parsedAdminId <= 0) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    req.admin = {
      adminId: parsedAdminId,
      role: decoded.role,
      roleId: decoded.roleId
    };

    next();
  } catch (err) {
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
