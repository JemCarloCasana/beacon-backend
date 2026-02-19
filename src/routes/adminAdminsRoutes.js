import express from "express";
import { pool } from "../db.js";
import { requireAuth, requirePermission } from "../middleware/adminAuth.js"; // ✅ FIXED

const router = express.Router();

/**
 * GET /admin/admins
 * Returns all personnel/admin accounts
 */
router.get(
  "/admin/admins",
  requireAuth,
  requirePermission("manage_users"),
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT id, email, full_name, role_id, created_at
        FROM admins
        ORDER BY created_at DESC
        `
      );

      return res.json(result.rows);
    } catch (err) {
      console.error("GET /admin/admins error:", err); // ✅ IMPORTANT
      return res.status(500).json({ message: "Server error" });
    }
  }
);

export default router;
