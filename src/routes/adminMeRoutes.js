import express from "express";
import { pool } from "../db.js";
import { requireAuth, getAdminPermissions } from "../middleware/adminAuth.js";
import { isMongoConnected } from "../mongo.js";
import { AdminAccount } from "../models/Remaining.js";

const router = express.Router();

/**
 * GET /admin/me
 * Returns the logged-in admin details + role + permissions
 */
router.get("/admin/me", requireAuth, async (req, res) => {
  try {
    const adminId = req.admin.adminId;
    if (!adminId) return res.status(401).json({ message: "UNAUTHORIZED" });

    if (isMongoConnected()) {
      const admin = await AdminAccount.findOne({ public_id: adminId }).lean();
      if (!admin) return res.status(401).json({ message: "UNAUTHORIZED" });
      return res.json({
        id: Number(admin.public_id), email: admin.email, full_name: admin.full_name,
        role_id: admin.role_id, role: admin.role, permissions: admin.permission_names ?? [],
      });
    }

    const adminResult = await pool.query(
      `
      SELECT a.id, a.email, a.full_name, a.role_id, r.name AS role
      FROM admins a
      JOIN roles r ON r.id = a.role_id
      WHERE a.id = $1
      `,
      [adminId]
    );

    if (adminResult.rowCount === 0) {
      return res.status(401).json({ message: "UNAUTHORIZED" });
    }

    const admin = adminResult.rows[0];
    const permissions = await getAdminPermissions(adminId);

    return res.json({
      id: admin.id,
      email: admin.email,
      full_name: admin.full_name,
      role_id: admin.role_id,
      role: admin.role,
      permissions,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
