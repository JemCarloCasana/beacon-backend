import express from "express";
import { pool } from "../db.js";
import { requireAdminAuth, requirePermission } from "../middleware/adminAuth.js";
import { sendBroadcastPush } from "../services/fcm.js";

const router = express.Router();

router.post(
  "/admin/broadcasts/:id/publish",
  requireAdminAuth,
  requirePermission("manage_broadcasts"),
  async (req, res) => {
    const broadcastId = Number(req.params.id);
    if (!Number.isInteger(broadcastId) || broadcastId <= 0) {
      return res.status(400).json({ message: "Invalid broadcast id" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const up = await client.query(
        `
        UPDATE broadcasts
        SET sent_at = now(), updated_at = now()
        WHERE id = $1 AND sent_at IS NULL
        RETURNING *
        `,
        [broadcastId]
      );

      if (up.rowCount === 0) {
        const existing = await client.query(`SELECT id FROM broadcasts WHERE id = $1`, [broadcastId]);
        await client.query("ROLLBACK");
        if (existing.rowCount === 0) {
          return res.status(404).json({ message: "Broadcast not found" });
        }
        return res.status(409).json({ message: "Broadcast already sent" });
      }

      const b = up.rows[0];
      const deliveryInsert = await client.query(
        `
        INSERT INTO broadcast_user_deliveries (broadcast_id, user_id)
        SELECT DISTINCT $1, u.id
        FROM users u
        WHERE ($2 = 'all')
           OR (
             $2 = 'role'
             AND (
               EXISTS (
                 SELECT 1
                 FROM unnest(COALESCE($3::text[], ARRAY[]::text[])) AS ar(role_name)
                 WHERE lower(ar.role_name) = lower(u.role)
               )
               OR (
                 COALESCE(array_length($3::text[], 1), 0) = 0
                 AND EXISTS (
                   SELECT 1
                   FROM unnest(COALESCE($4::int[], ARRAY[]::int[])) AS rid(role_id)
                   JOIN roles r ON r.id = rid.role_id
                   WHERE lower(r.name) = lower(u.role)
                 )
               )
             )
           )
        ON CONFLICT DO NOTHING
        `,
        [broadcastId, b.audience_type, b.audience_roles || [], b.audience_role_ids || []]
      );

      await client.query("COMMIT");

      const push = await sendBroadcastPush({
        broadcastId,
        title: b.title,
        body: b.body,
        data: {
          type: "broadcast",
          broadcast_id: b.id,
          severity: b.severity ?? "",
          audience_type: b.audience_type ?? "",
        },
      });

      res.json({ broadcast: b, delivered_count: deliveryInsert.rowCount, push });
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      console.error("publish broadcast error:", e);
      res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
    }
  }
);

export default router;
