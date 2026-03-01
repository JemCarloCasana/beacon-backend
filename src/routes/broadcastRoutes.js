import express from "express";
import { pool } from "../db.js";
import { requireAdminAuth, requirePermission, getAdminPermissions } from "../middleware/adminAuth.js";
import { requireAuth as requireFirebaseAuth } from "../middleware/requireAuth.js";
import { sendBroadcastPush } from "../services/fcm.js";

const router = express.Router();

const ALLOWED_SEVERITIES = ["info", "medium", "high", "critical"];
const ALLOWED_AUDIENCE_TYPES = ["all", "role"];

function parsePositiveInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return null;
  }
  return num;
}

function normalizeRoleIds(audienceRoleIds) {
  if (!Array.isArray(audienceRoleIds) || audienceRoleIds.length === 0) {
    return null;
  }

  const normalized = [];
  for (const roleId of audienceRoleIds) {
    const num = Number(roleId);
    if (!Number.isInteger(num) || num <= 0) {
      return null;
    }
    normalized.push(num);
  }

  return [...new Set(normalized)];
}

async function resolveAuthenticatedInboxUserId(req, res) {
  const uid = typeof req.auth?.uid === "string" ? req.auth.uid.trim() : "";
  if (!uid) {
    res.status(401).json({ message: "Invalid token: missing uid claim" });
    return null;
  }

  const userResult = await pool.query(
    `
    SELECT id
    FROM users
    WHERE firebase_uid = $1
    LIMIT 1
    `,
    [uid]
  );

  if (userResult.rowCount === 0) {
    res.status(404).json({ message: "User account not found. Call /me/bootstrap first." });
    return null;
  }

  return Number(userResult.rows[0].id);
}

router.post(
  "/admin/broadcasts",
  requireAdminAuth,
  requirePermission("manage_broadcasts"),
  async (req, res) => {
    try {
      const adminId = Number(req.admin?.adminId);
      if (!Number.isInteger(adminId) || adminId <= 0) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
      const severity = typeof req.body?.severity === "string" ? req.body.severity.trim().toLowerCase() : "";
      const audienceType =
        typeof req.body?.audience_type === "string"
          ? req.body.audience_type.trim().toLowerCase()
          : "";

      if (!title) {
        return res.status(400).json({ message: "title is required" });
      }
      if (!body) {
        return res.status(400).json({ message: "body is required" });
      }
      if (!ALLOWED_SEVERITIES.includes(severity)) {
        return res.status(400).json({ message: "Invalid severity" });
      }
      if (!ALLOWED_AUDIENCE_TYPES.includes(audienceType)) {
        return res.status(400).json({ message: "Invalid audience_type" });
      }

      let audienceRoleIds = null;
      if (audienceType === "role") {
        audienceRoleIds = normalizeRoleIds(req.body?.audience_role_ids);
        if (!audienceRoleIds) {
          return res.status(400).json({ message: "audience_role_ids must be a non-empty array of integers" });
        }
      }

      const result = await pool.query(
        `
        INSERT INTO broadcasts (
          title,
          body,
          severity,
          audience_type,
          audience_role_ids,
          created_by_admin_id,
          sent_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NULL)
        RETURNING *
        `,
        [title, body, severity, audienceType, audienceRoleIds, adminId]
      );

      return res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("POST /admin/broadcasts error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

router.post(
  "/admin/broadcasts/:id/send",
  requireAdminAuth,
  requirePermission("manage_broadcasts"),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const broadcastId = parsePositiveInt(req.params.id);
      if (!broadcastId) {
        return res.status(400).json({ message: "Invalid broadcast id" });
      }

      await client.query("BEGIN");

      const updateResult = await client.query(
        `
        UPDATE broadcasts
        SET sent_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND sent_at IS NULL
        RETURNING *
        `,
        [broadcastId]
      );

      if (updateResult.rowCount === 0) {
        const existing = await client.query(
          `
          SELECT id
          FROM broadcasts
          WHERE id = $1
          `,
          [broadcastId]
        );

        await client.query("ROLLBACK");

        if (existing.rowCount === 0) {
          return res.status(404).json({ message: "Broadcast not found" });
        }

        return res.status(409).json({ message: "Broadcast already sent" });
      }

      const broadcast = updateResult.rows[0];
      const deliveryInsert = await client.query(
        `
        INSERT INTO broadcast_user_deliveries (broadcast_id, user_id)
        SELECT DISTINCT $1::bigint, u.id
        FROM users u
        WHERE ($2 = 'all')
           OR (
             $2 = 'role'
             AND EXISTS (
               SELECT 1
               FROM unnest(COALESCE($3::int[], ARRAY[]::int[])) AS rid(role_id)
               JOIN roles r ON r.id = rid.role_id
               WHERE lower(r.name) = lower(u.role)
             )
           )
        ON CONFLICT DO NOTHING
        `,
        [broadcastId, broadcast.audience_type, broadcast.audience_role_ids || []]
      );

      await client.query("COMMIT");

      const push = await sendBroadcastPush({
        broadcastId,
        title: broadcast.title,
        body: broadcast.body,
        data: {
          type: "broadcast",
          broadcast_id: broadcast.id,
          severity: broadcast.severity ?? "",
          audience_type: broadcast.audience_type ?? "",
        },
      });

      return res.json({
        ok: true,
        broadcast_id: broadcastId,
        sent_at: broadcast.sent_at,
        delivered_count: deliveryInsert.rowCount,
        push,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("POST /admin/broadcasts/:id/send rollback error:", rollbackErr);
      }
      console.error("POST /admin/broadcasts/:id/send error:", err);
      return res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
    }
  }
);

router.get("/admin/broadcasts", requireAdminAuth, async (req, res) => {
  try {
    const adminId = Number(req.admin?.adminId);
    if (!Number.isInteger(adminId) || adminId <= 0) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const viewPermissionExistsResult = await pool.query(
      `
      SELECT 1
      FROM permissions
      WHERE name = 'view_broadcasts'
      LIMIT 1
      `
    );

    if (viewPermissionExistsResult.rowCount > 0) {
      const permissions = await getAdminPermissions(adminId);
      if (!permissions.includes("view_broadcasts")) {
        return res.status(403).json({ message: "Insufficient permissions" });
      }
    }

    const sent = req.query?.sent;
    const where = [];

    if (sent === "1") {
      where.push("sent_at IS NOT NULL");
    } else if (sent === "0") {
      where.push("sent_at IS NULL");
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const result = await pool.query(
      `
      SELECT *
      FROM broadcasts
      ${whereClause}
      ORDER BY created_at DESC
      `
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/broadcasts error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/broadcasts/my/inbox", requireFirebaseAuth, async (req, res) => {
  try {
    const userId = await resolveAuthenticatedInboxUserId(req, res);
    if (!userId) {
      return;
    }

    const result = await pool.query(
      `
      SELECT b.*, d.delivered_at
      FROM broadcast_user_deliveries d
      JOIN broadcasts b ON b.id = d.broadcast_id
      WHERE d.user_id = $1
      ORDER BY d.delivered_at DESC
      `,
      [userId]
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/broadcasts/my/inbox error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.post("/admin/broadcasts/:id/ack", requireFirebaseAuth, async (req, res) => {
  try {
    const broadcastId = parsePositiveInt(req.params.id);

    if (!broadcastId) {
      return res.status(400).json({ message: "Invalid broadcast id" });
    }

    const userId = await resolveAuthenticatedInboxUserId(req, res);
    if (!userId) {
      return;
    }

    const broadcastExists = await pool.query(
      `
      SELECT id
      FROM broadcasts
      WHERE id = $1
      LIMIT 1
      `,
      [broadcastId]
    );

    if (broadcastExists.rowCount === 0) {
      return res.status(404).json({ message: "Broadcast not found" });
    }

    const result = await pool.query(
      `
      SELECT 1
      FROM broadcast_user_deliveries
      WHERE broadcast_id = $1 AND user_id = $2
      LIMIT 1
      `,
      [broadcastId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Delivery not found" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /admin/broadcasts/:id/ack error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
