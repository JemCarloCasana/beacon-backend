import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = express.Router();
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!JWT_SECRET) throw new Error("Missing ADMIN_JWT_SECRET in .env");

const ALLOWED_ROLE_NAMES = new Set(["admin", "personnel"]);

function isValidEmail(email) {
  return typeof email === "string" && email.includes("@") && email.length <= 254;
}

async function getRoleIdByName(roleName) {
  const r = await pool.query("SELECT id FROM roles WHERE name = $1", [roleName]);
  return r.rowCount ? r.rows[0].id : null;
}

// POST /admin/auth/signup
router.post("/admin/auth/signup", async (req, res) => {
  try {
    const { email, password, full_name, role } = req.body;

    if (!isValidEmail(email)) return res.status(400).json({ message: "Invalid email" });
    if (typeof full_name !== "string" || full_name.trim().length < 2)
      return res.status(400).json({ message: "Invalid full name" });
    if (typeof password !== "string" || password.length < 8)
      return res.status(400).json({ message: "Password must be at least 8 characters" });

    const requestedRole = typeof role === "string" ? role.toLowerCase().trim() : "personnel";
    const finalRoleName = ALLOWED_ROLE_NAMES.has(requestedRole) ? requestedRole : "personnel";

    const roleId = await getRoleIdByName(finalRoleName);
    if (!roleId) return res.status(500).json({ message: "Role configuration missing in DB" });

    const existing = await pool.query("SELECT id FROM admins WHERE email = $1", [email.toLowerCase()]);
    if (existing.rowCount > 0) return res.status(409).json({ message: "Email already registered" });

    const password_hash = await bcrypt.hash(password, 12);

    const inserted = await pool.query(
      `INSERT INTO admins (email, password_hash, full_name, role_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, role_id, created_at`,
      [email.toLowerCase(), password_hash, full_name.trim(), roleId]
    );

    const admin = inserted.rows[0];

    // include role name in response
    const roleRow = await pool.query("SELECT name FROM roles WHERE id = $1", [admin.role_id]);
    const roleName = roleRow.rowCount ? roleRow.rows[0].name : finalRoleName;

    const token = jwt.sign({ adminId: admin.id, role: roleName, roleId: admin.role_id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.status(201).json({
      admin: { id: admin.id, email: admin.email, full_name: admin.full_name, role: roleName, role_id: admin.role_id },
      token,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

// POST /admin/auth/login
router.post("/admin/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!isValidEmail(email)) return res.status(400).json({ message: "Invalid email" });
    if (typeof password !== "string") return res.status(400).json({ message: "Invalid password" });

    const result = await pool.query(
      `SELECT a.id, a.email, a.full_name, a.password_hash, a.role_id, r.name AS role
       FROM admins a
       JOIN roles r ON r.id = a.role_id
       WHERE a.email = $1`,
      [email.toLowerCase()]
    );

    if (result.rowCount === 0) return res.status(401).json({ message: "Invalid credentials" });

    const row = result.rows[0];
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign({ adminId: row.id, role: row.role, roleId: row.role_id }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      admin: { id: row.id, email: row.email, full_name: row.full_name, role: row.role, role_id: row.role_id },
      token,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
