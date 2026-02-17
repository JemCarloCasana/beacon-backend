import express from "express";
import { pool } from "../db.js";

const router = express.Router();

/**
 * GET /users/:id/public
 * Returns limited public info (safe for friends)
 */
router.get("/users/:id/public", async (req, res) => {
  const { id } = req.params;

  const result = await pool.query(
    `SELECT id, full_name, beacon_code
     FROM users
     WHERE id = $1`,
    [id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ message: "User not found" });
  }

  res.json(result.rows[0]);
});

export default router;
