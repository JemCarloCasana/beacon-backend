import jwt from "jsonwebtoken";
import { auditLog } from "../utils/auditLog.js";
import { AdminRecord } from "../models/Reduced.js";
import { parseObjectId } from "../utils/objectId.js";

const JWT_SECRET = process.env.ADMIN_JWT_SECRET;

const DEACTIVATED_MESSAGE = "Account is deactivated";

export function assertAccountActive(account) {
  if (account?.status === "deactivated") {
    return { ok: false, statusCode: 403, message: DEACTIVATED_MESSAGE };
  }
  return { ok: true };
}

export async function getAdminAuthAccount(adminId) {
  const objectId = parseObjectId(adminId);
  if (!objectId) return null;
  const account = await AdminRecord.findOne({ _id: objectId, record_type: "account" }).select({ _id: 1, status: 1 }).lean();
  return account ? { id: account._id.toString(), status: account.status } : null;
}

export async function getAdminPermissions(adminId) {
  const objectId = parseObjectId(adminId);
  if (!objectId) return [];
  const account = await AdminRecord.findOne({ _id: objectId, record_type: "account" }).select({ permissions: 1 }).lean();
  return account?.permissions ?? [];
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
    const parsedAdminId = parseObjectId(decoded.adminId ?? decoded.sub);
    if (!parsedAdminId) {
      auditLog({ action: "admin.auth", target: `${req.method} ${req.path}`, outcome: "invalid_token" });
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const adminId = parsedAdminId.toString();
    const account = await getAdminAuthAccount(adminId);
    if (!account) {
      auditLog({ action: "admin.auth", actor: adminId, target: `${req.method} ${req.path}`, outcome: "unknown_account" });
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    const activeCheck = assertAccountActive(account);
    if (!activeCheck.ok) {
      auditLog({ action: "admin.auth", actor: adminId, target: `${req.method} ${req.path}`, outcome: "deactivated" });
      return res.status(activeCheck.statusCode).json({ message: activeCheck.message });
    }

    req.admin = { adminId, role: decoded.role };

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
