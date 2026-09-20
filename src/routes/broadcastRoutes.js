import express from "express";
import { pool } from "../db.js";
import { requireAdminAuth, requirePermission, getAdminPermissions } from "../middleware/adminAuth.js";
import { requireAuth as requireFirebaseAuth } from "../middleware/requireAuth.js";
import { sendBroadcastPush } from "../services/fcm.js";
import { sendBroadcastByPublicId } from "../services/broadcastSend.js";
import { auditLog } from "../utils/auditLog.js";
import { Broadcast, hasValidBroadcastAudience } from "../models/Broadcast.js";
import { BroadcastDelivery } from "../models/BroadcastDelivery.js";
import { Counter } from "../models/Counter.js";

const router = express.Router();

const ALLOWED_SEVERITIES = ["announcement", "warning", "danger"];
const ALLOWED_AUDIENCE_TYPES = ["all", "role"];
const ALLOWED_APP_AUDIENCE_ROLES = new Set(["citizen", "student"]);

function parsePositiveInt(value) {
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num <= 0) {
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

function normalizeAudienceRoles(audienceRoles) {
  if (!Array.isArray(audienceRoles) || audienceRoles.length === 0) {
    return null;
  }

  const normalized = [];
  for (const role of audienceRoles) {
    if (typeof role !== "string") {
      return null;
    }

    const candidate = role.trim().toLowerCase();
    if (!ALLOWED_APP_AUDIENCE_ROLES.has(candidate)) {
      return null;
    }
    normalized.push(candidate);
  }

  return [...new Set(normalized)];
}

function hasOwnProperty(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj ?? {}, key);
}

export function toBroadcastRow(doc) {
  if (!doc || typeof doc !== "object") {
    return doc;
  }
  return {
    id: doc.public_id,
    title: doc.title,
    body: doc.body,
    severity: doc.severity,
    audience_type: doc.audience_type,
    audience_roles: doc.audience_roles ?? null,
    audience_role_ids: doc.audience_role_ids ?? null,
    created_by_admin_id: doc.created_by_admin_id,
    is_active: doc.is_active ?? true,
    sent_at: doc.sent_at ?? null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
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
      let audienceRoles = null;
      if (audienceType === "role") {
        if (hasOwnProperty(req.body, "audience_roles")) {
          audienceRoles = normalizeAudienceRoles(req.body?.audience_roles);
          if (!audienceRoles) {
            return res.status(400).json({
              message:
                "audience_roles must be a non-empty array containing only citizen/student. audience_role_ids is deprecated fallback.",
            });
          }
        } else if (hasOwnProperty(req.body, "audience_role_ids")) {
          audienceRoleIds = normalizeRoleIds(req.body?.audience_role_ids);
          if (!audienceRoleIds) {
            return res.status(400).json({
              message:
                "audience_role_ids must be a non-empty array of integers (deprecated). Prefer audience_roles.",
            });
          }
        } else {
          return res.status(400).json({
            message: "audience_roles is required when audience_type=role. audience_role_ids is deprecated fallback.",
          });
        }
      }

      const publicId = await Counter.nextPublicId("broadcasts");
      const created = await Broadcast.create({
        public_id: publicId,
        title,
        body,
        severity,
        audience_type: audienceType,
        ...(audienceRoles ? { audience_roles: audienceRoles } : {}),
        ...(audienceRoleIds ? { audience_role_ids: audienceRoleIds } : {}),
        created_by_admin_id: adminId,
        is_active: true,
        sent_at: null,
      });

      const createdRow =
        typeof created.toObject === "function" ? created.toObject() : created;
      auditLog({
        action: "broadcast.created",
        actor: adminId,
        target: `broadcast:${publicId}`,
        outcome: "created",
      });
      return res.status(201).json(toBroadcastRow(createdRow));
    } catch (err) {
      if (err?.name === "ValidationError") {
        return res.status(400).json({ message: "Invalid broadcast fields" });
      }
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
    try {
      const broadcastId = parsePositiveInt(req.params.id);
      if (!broadcastId) {
        return res.status(400).json({ message: "Invalid broadcast id" });
      }

      let outcome;
      try {
        outcome = await sendBroadcastByPublicId(broadcastId);
      } catch (err) {
        console.error("POST /admin/broadcasts/:id/send error:", err);
        return res.status(500).json({ message: "Server error" });
      }

      if (outcome.status === "not_found") {
        return res.status(404).json({ message: "Broadcast not found" });
      }

      if (outcome.status === "already_sent") {
        return res.status(409).json({ message: "Broadcast already sent" });
      }

      const broadcast = outcome.broadcast;
      const push = await sendBroadcastPush({
        broadcastPublicId: broadcastId,
        title: broadcast.title,
        body: broadcast.body,
        data: {
          type: "broadcast",
          broadcast_id: broadcast.public_id,
          severity: broadcast.severity ?? "",
          audience_type: broadcast.audience_type ?? "",
        },
      });

      auditLog({
        action: "broadcast.sent",
        actor: Number(req.admin?.adminId),
        target: `broadcast:${broadcastId}`,
        outcome: "sent",
        details: { deliveredCount: outcome.deliveredCount },
      });

      return res.json({
        ok: true,
        broadcast_id: broadcastId,
        sent_at: broadcast.sent_at,
        delivered_count: outcome.deliveredCount,
        push,
      });
    } catch (err) {
      console.error("POST /admin/broadcasts/:id/send error:", err);
      return res.status(500).json({ message: "Server error" });
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
    const filter = {};

    if (sent === "1") {
      filter.sent_at = { $ne: null };
    } else if (sent === "0") {
      filter.sent_at = null;
    }

    const docs = await Broadcast.find(filter).sort({ created_at: -1 }).lean();

    return res.json(docs.map(toBroadcastRow));
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

    const deliveries = await BroadcastDelivery.find({ recipient_user_id: userId })
      .sort({ delivered_at: -1 })
      .lean();

    if (deliveries.length === 0) {
      return res.json([]);
    }

    const broadcastIds = [...new Set(deliveries.map((entry) => String(entry.broadcast_id)))];
    const broadcasts = await Broadcast.find({ _id: { $in: broadcastIds } }).lean();
    const broadcastById = new Map(broadcasts.map((entry) => [String(entry._id), entry]));

    const inbox = [];
    for (const delivery of deliveries) {
      const broadcast = broadcastById.get(String(delivery.broadcast_id));
      if (!broadcast) {
        continue;
      }
      inbox.push({
        ...toBroadcastRow(broadcast),
        delivered_at: delivery.delivered_at,
        acknowledged_at: delivery.acknowledged_at ?? null,
      });
    }

    return res.json(inbox);
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

    const broadcast = await Broadcast.findOne({ public_id: broadcastId }).lean();

    if (!broadcast) {
      return res.status(404).json({ message: "Broadcast not found" });
    }

    const delivery = await BroadcastDelivery.findOneAndUpdate(
      { broadcast_public_id: broadcastId, recipient_user_id: userId },
      [{ $set: { acknowledged_at: { $ifNull: ["$acknowledged_at", "$$NOW"] } } }],
      { new: true, updatePipeline: true }
    ).lean();

    if (!delivery) {
      return res.status(404).json({ message: "Delivery not found" });
    }

    return res.json({
      ok: true,
      broadcast_id: broadcastId,
      acknowledged_at: delivery.acknowledged_at,
    });
  } catch (err) {
    console.error("POST /admin/broadcasts/:id/ack error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch(
  "/admin/broadcasts/:id",
  requireAdminAuth,
  requirePermission("manage_broadcasts"),
  async (req, res) => {
    try {
      const broadcastId = parsePositiveInt(req.params.id);
      if (!broadcastId) {
        return res.status(400).json({ message: "Invalid broadcast id" });
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const allowedFields = new Set([
        "title",
        "body",
        "severity",
        "audience_type",
        "audience_roles",
        "audience_role_ids",
      ]);
      for (const key of Object.keys(body)) {
        if (!allowedFields.has(key)) {
          return res.status(400).json({ message: `Field is not allowed: ${key}` });
        }
      }

      const existing = await Broadcast.findOne({ public_id: broadcastId }).lean();
      if (!existing) {
        return res.status(404).json({ message: "Broadcast not found" });
      }
      if (existing.sent_at != null) {
        return res.status(409).json({ message: "Broadcast already sent" });
      }

      const setFields = {};
      const unsetFields = {};

      if (hasOwnProperty(body, "title")) {
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title) {
          return res.status(400).json({ message: "title is required" });
        }
        setFields.title = title;
      }

      if (hasOwnProperty(body, "body")) {
        const text = typeof body.body === "string" ? body.body.trim() : "";
        if (!text) {
          return res.status(400).json({ message: "body is required" });
        }
        setFields.body = text;
      }

      if (hasOwnProperty(body, "severity")) {
        const severity =
          typeof body.severity === "string" ? body.severity.trim().toLowerCase() : "";
        if (!ALLOWED_SEVERITIES.includes(severity)) {
          return res.status(400).json({ message: "Invalid severity" });
        }
        setFields.severity = severity;
      }

      let effectiveAudienceType = existing.audience_type;
      if (hasOwnProperty(body, "audience_type")) {
        const audienceType =
          typeof body.audience_type === "string"
            ? body.audience_type.trim().toLowerCase()
            : "";
        if (!ALLOWED_AUDIENCE_TYPES.includes(audienceType)) {
          return res.status(400).json({ message: "Invalid audience_type" });
        }
        setFields.audience_type = audienceType;
        effectiveAudienceType = audienceType;
      }

      if (effectiveAudienceType === "all") {
        if (hasOwnProperty(body, "audience_roles") || hasOwnProperty(body, "audience_role_ids")) {
          return res.status(400).json({
            message: "audience_roles and audience_role_ids are only allowed when audience_type=role",
          });
        }
        unsetFields.audience_roles = "";
        unsetFields.audience_role_ids = "";
      } else if (hasOwnProperty(body, "audience_roles") || hasOwnProperty(body, "audience_role_ids")) {
        if (hasOwnProperty(body, "audience_roles")) {
          const audienceRoles = normalizeAudienceRoles(body.audience_roles);
          if (!audienceRoles) {
            return res.status(400).json({
              message:
                "audience_roles must be a non-empty array containing only citizen/student. audience_role_ids is deprecated fallback.",
            });
          }
          setFields.audience_roles = audienceRoles;
          unsetFields.audience_role_ids = "";
        } else {
          const audienceRoleIds = normalizeRoleIds(body.audience_role_ids);
          if (!audienceRoleIds) {
            return res.status(400).json({
              message:
                "audience_role_ids must be a non-empty array of integers (deprecated). Prefer audience_roles.",
            });
          }
          setFields.audience_role_ids = audienceRoleIds;
          unsetFields.audience_roles = "";
        }
      }

      if (Object.keys(setFields).length === 0 && Object.keys(unsetFields).length === 0) {
        return res.status(400).json({ message: "No updatable fields provided" });
      }

      setFields.updated_at = new Date();
      const candidate = { ...existing, ...setFields };
      for (const key of Object.keys(unsetFields)) delete candidate[key];
      if (!hasValidBroadcastAudience(candidate)) {
        return res.status(400).json({ message: "Role audience requires a valid recipient selector" });
      }
      const update = { $set: setFields };
      if (Object.keys(unsetFields).length > 0) {
        update.$unset = unsetFields;
      }

      const updated = await Broadcast.findOneAndUpdate(
        {
          public_id: broadcastId, sent_at: null,
          audience_type: existing.audience_type,
          audience_roles: existing.audience_roles ?? null,
          audience_role_ids: existing.audience_role_ids ?? null,
        },
        update,
        { new: true, runValidators: true }
      ).lean();

      if (!updated) {
        const current = await Broadcast.findOne({ public_id: broadcastId }).lean();
        if (!current) return res.status(404).json({ message: "Broadcast not found" });
        return res.status(409).json({ message: current.sent_at != null ? "Broadcast already sent" : "Broadcast changed; reload and retry" });
      }

      auditLog({
        action: "broadcast.edited",
        actor: Number(req.admin?.adminId),
        target: `broadcast:${broadcastId}`,
        outcome: "updated",
      });

      return res.json(toBroadcastRow(updated));
    } catch (err) {
      if (err?.name === "ValidationError") {
        return res.status(400).json({ message: "Invalid broadcast fields" });
      }
      console.error("PATCH /admin/broadcasts/:id error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

router.delete(
  "/admin/broadcasts/:id",
  requireAdminAuth,
  requirePermission("manage_broadcasts"),
  async (req, res, next) => {
    try {
      const result = await pool.query(
        "SELECT r.name AS role FROM admins a JOIN roles r ON r.id = a.role_id WHERE a.id = $1",
        [req.admin.adminId]
      );
      if (result.rows[0]?.role !== "admin") {
        return res.status(403).json({ message: "Insufficient permissions" });
      }
      return next();
    } catch {
      return res.status(500).json({ message: "Server error" });
    }
  },
  async (req, res) => {
    try {
      const broadcastId = parsePositiveInt(req.params.id);
      if (!broadcastId) {
        return res.status(400).json({ message: "Invalid broadcast id" });
      }

      const deleted = await Broadcast.findOneAndDelete({
        public_id: broadcastId,
        sent_at: null,
      }).lean();

      if (!deleted) {
        const existing = await Broadcast.findOne({ public_id: broadcastId }).lean();
        if (!existing) {
          return res.status(404).json({ message: "Broadcast not found" });
        }
        return res.status(409).json({ message: "Broadcast already sent" });
      }

      await BroadcastDelivery.deleteMany({ broadcast_public_id: broadcastId });

      auditLog({
        action: "broadcast.deleted",
        actor: Number(req.admin?.adminId),
        target: `broadcast:${broadcastId}`,
        outcome: "deleted",
      });

      return res.json({ ok: true, broadcast_id: broadcastId });
    } catch (err) {
      console.error("DELETE /admin/broadcasts/:id error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

export default router;
