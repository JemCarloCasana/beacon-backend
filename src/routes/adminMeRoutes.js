import express from "express";
import { requireAuth } from "../middleware/adminAuth.js";
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

    const admin = await AdminAccount.findOne({ public_id: adminId }).lean();
    if (!admin) return res.status(401).json({ message: "UNAUTHORIZED" });
    return res.json({
      id: Number(admin.public_id),
      email: admin.email,
      full_name: admin.full_name,
      role_id: admin.role_id,
      role: admin.role,
      permissions: admin.permission_names ?? [],
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
