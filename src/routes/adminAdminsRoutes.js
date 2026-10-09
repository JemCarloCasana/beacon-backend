import express from "express";
import bcrypt from "bcrypt";
import { getAdminPermissions } from "../middleware/adminAuth.js";
import { buildValidationError, validateAdminCreatePayload } from "../utils/adminAuthValidation.js";
import { requireAuth, requirePermission } from "../middleware/adminAuth.js"; // ✅ FIXED
import { mongoose } from "../mongo.js";
import { auditLog } from "../utils/auditLog.js";
import { AdminRecord, Notification, ReducedUserProfile as UserProfile } from "../models/Reduced.js";
import { parseObjectId } from "../utils/objectId.js";

const router = express.Router();
const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMIN_USER_PATCH_ALLOWED_FIELDS = ["full_name", "email", "status"];
const ADMIN_ACCOUNT_PATCH_ALLOWED_FIELDS = ["full_name", "email"];
const ACCOUNT_STATUSES = ["active", "deactivated"];
const ADMIN_LIST_STATUSES = ["active", "deactivated", "all"];
const IS_DEBUG_LOG = String(process.env.LOG_LEVEL || "").toLowerCase() === "debug";

function logDebug(event, payload) {
  if (!IS_DEBUG_LOG) {
    return;
  }
  console.debug(`[admin-admins] ${event}`, payload);
}

function applyNotificationNoStoreHeaders(res) {
  res.set("Cache-Control", "no-store, private, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Vary", "Authorization");
  res.set("Expires", "0");
}

function normalizeNotificationMetadata(metadata) {
  if (metadata == null) {
    return {};
  }

  let normalized = metadata;
  if (typeof metadata === "string") {
    try {
      normalized = JSON.parse(metadata);
    } catch {
      return {};
    }
  }

  if (typeof normalized !== "object" || Array.isArray(normalized)) {
    return {};
  }

  return { ...normalized };
}

function toPositiveIntegerOrNull(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function withNormalizedNotificationTargets(metadata, type) {
  const normalized = {
    ...metadata,
  };
  const adminRequestId = toPositiveIntegerOrNull(normalized.admin_request_id);
  if (adminRequestId != null) {
    normalized.admin_request_id = adminRequestId;
  }

  const incidentId = toPositiveIntegerOrNull(normalized.incident_id);
  const sosId = toPositiveIntegerOrNull(normalized.sos_id);
  const referenceId = toPositiveIntegerOrNull(normalized.reference_id);
  if (incidentId != null) {
    normalized.incident_id = incidentId;
  }
  if (sosId != null) {
    normalized.sos_id = sosId;
  }

  if (referenceId != null) {
    normalized.reference_id = referenceId;
  } else if (incidentId != null) {
    normalized.reference_id = incidentId;
  } else if (sosId != null) {
    normalized.reference_id = sosId;
  }

  const typeKey = String(type || "").trim().toLowerCase();
  const fallbackRoute =
    typeof normalized.fallback_route === "string" && normalized.fallback_route.trim()
      ? normalized.fallback_route.trim()
      : null;
  if (fallbackRoute == null) {
    if (typeKey === "incident" && normalized.incident_id != null) {
      normalized.fallback_route = `/admin/incidents/${normalized.incident_id}`;
    } else if (typeKey === "sos" && normalized.sos_id != null) {
      normalized.fallback_route = `/admin/sos/${normalized.sos_id}`;
    }
  }

  return normalized;
}

function normalizeNotificationRow(row) {
  if (!row || typeof row !== "object") {
    return row;
  }
  return {
    ...row,
    metadata: withNormalizedNotificationTargets(normalizeNotificationMetadata(row.metadata), row.type),
  };
}

function toAdminNotificationRow(doc) {
  if (!doc || typeof doc !== "object") {
    return doc;
  }
  return {
    id: doc._id.toString(),
    recipient_admin_id: doc.recipient_id.toString(),
    type: doc.type,
    title: doc.title,
    message: doc.message,
    metadata: doc.metadata,
    is_read: doc.is_read,
    created_at: doc.created_at,
  };
}

function addFieldError(errors, field, message) {
  if (!errors[field]) {
    errors[field] = [];
  }
  errors[field].push(message);
}

function validateAdminUserPatchPayload(body) {
  const errors = {};
  const normalized = {};
  const payload = body && typeof body === "object" ? body : {};
  const keys = Object.keys(payload);

  for (const key of keys) {
    if (!ADMIN_USER_PATCH_ALLOWED_FIELDS.includes(key)) {
      addFieldError(errors, key, "Field is not allowed");
    }
  }

  if (!ADMIN_USER_PATCH_ALLOWED_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(payload, field))) {
    addFieldError(errors, "body", "At least one of full_name, email, or status is required");
  }

  if (Object.prototype.hasOwnProperty.call(payload, "full_name")) {
    const fullName = payload.full_name;
    if (typeof fullName !== "string") {
      addFieldError(errors, "full_name", "Must be a string");
    } else {
      const trimmed = fullName.trim();
      if (trimmed.length < 2 || trimmed.length > 50) {
        addFieldError(errors, "full_name", "Must be between 2 and 50 characters");
      } else {
        normalized.full_name = trimmed;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, "email")) {
    const email = payload.email;
    if (typeof email !== "string") {
      addFieldError(errors, "email", "Must be a string");
    } else {
      const normalizedEmail = email.trim().toLowerCase();
      if (!SIMPLE_EMAIL_REGEX.test(normalizedEmail)) {
        addFieldError(errors, "email", "Invalid email format");
      } else {
        normalized.email = normalizedEmail;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, "status")) {
    const status = payload.status;
    if (typeof status !== "string") {
      addFieldError(errors, "status", 'Must be "active" or "deactivated"');
    } else {
      const normalizedStatus = status.trim().toLowerCase();
      if (!ACCOUNT_STATUSES.includes(normalizedStatus)) {
        addFieldError(errors, "status", 'Must be "active" or "deactivated"');
      } else {
        normalized.status = normalizedStatus;
      }
    }
  }

  return { normalized, errors };
}

function validateAdminAccountPatchPayload(body) {
  const errors = {};
  const normalized = {};
  const payload = body && typeof body === "object" ? body : {};
  const keys = Object.keys(payload);

  for (const key of keys) {
    if (!ADMIN_ACCOUNT_PATCH_ALLOWED_FIELDS.includes(key)) {
      addFieldError(errors, key, "Field is not allowed");
    }
  }

  if (!ADMIN_ACCOUNT_PATCH_ALLOWED_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(payload, field))) {
    addFieldError(errors, "body", "At least one of full_name or email is required");
  }

  if (Object.prototype.hasOwnProperty.call(payload, "full_name")) {
    const fullName = payload.full_name;
    if (typeof fullName !== "string") {
      addFieldError(errors, "full_name", "Must be a string");
    } else {
      const trimmed = fullName.trim();
      if (trimmed.length < 2 || trimmed.length > 50) {
        addFieldError(errors, "full_name", "Must be between 2 and 50 characters");
      } else {
        normalized.full_name = trimmed;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, "email")) {
    const email = payload.email;
    if (typeof email !== "string") {
      addFieldError(errors, "email", "Must be a string");
    } else {
      const normalizedEmail = email.trim().toLowerCase();
      if (!SIMPLE_EMAIL_REGEX.test(normalizedEmail)) {
        addFieldError(errors, "email", "Invalid email format");
      } else {
        normalized.email = normalizedEmail;
      }
    }
  }

  return { normalized, errors };
}

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
      const statusFilterRaw = typeof req.query?.status === "string" ? req.query.status.trim().toLowerCase() : "all";
      const statusFilter = statusFilterRaw.length > 0 ? statusFilterRaw : "all";
      if (!ADMIN_LIST_STATUSES.includes(statusFilter)) {
        return res.status(400).json({ message: "Invalid status filter" });
      }

      const filter = { record_type: "account", ...(statusFilter === "all" ? {} : { status: statusFilter }) };
      const rows = await AdminRecord.find(filter).sort({ created_at: -1 }).lean();
      return res.json(rows.map((row) => ({ id: row._id.toString(), email: row.email, full_name: row.full_name, role: row.role, created_at: row.created_at, status: row.status })));
    } catch (err) {
      console.error("GET /admin/admins error:", err); // ✅ IMPORTANT
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * POST /admin/admins
 * Admin-only account creation for admin/personnel accounts.
 */
router.post(
  "/admin/admins",
  requireAuth,
  requirePermission("manage_admins"),
  async (req, res) => {
    try {
      const { errors, normalized } = validateAdminCreatePayload(req.body);
      if (Object.keys(errors).length > 0) {
        return res.status(422).json(buildValidationError(errors));
      }

      const passwordHash = await bcrypt.hash(normalized.password, 12);
      const existing = await AdminRecord.findOne({ record_type: "account", email: normalized.email }).lean();
      if (existing) return res.status(409).json({ message: "Email already exists" });
      const createdAdmin = await AdminRecord.create({ record_type: "account", email: normalized.email, password_hash: passwordHash, full_name: normalized.full_name, role: normalized.role, permissions: [], status: "active", created_at: new Date(), updated_at: new Date() });
      auditLog({
        action: "admin.account_created",
        actor: req.admin?.adminId,
        target: createdAdmin.email,
        outcome: "created",
        details: { id: createdAdmin._id.toString() },
      });
      return res.status(201).json({ id: createdAdmin._id.toString(), email: createdAdmin.email, full_name: createdAdmin.full_name, created_at: createdAdmin.created_at, status: createdAdmin.status, role: normalized.role });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({ message: "Email already exists" });
      }
      console.error("POST /admin/admins error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * GET /admin/users/:id
 * Admin-only user profile lookup by id.
 */
router.get(
  "/admin/users/:id",
  requireAuth,
  requirePermission("manage_users"),
  async (req, res) => {
    try {
      const userId = parseObjectId(req.params.id);
      if (!userId) {
        return res.status(422).json(
          buildValidationError({
            id: ["Must be a valid ObjectId"],
          })
        );
      }

      const user = await UserProfile.findById(userId).lean();
      if (!user) return res.status(404).json({ message: "User not found" });
      return res.json({ id: user._id.toString(), firebase_uid: user.firebase_uid, email: user.email, full_name: user.full_name, phone_number: user.phone_number, role: user.role, profile_image_url: user.profile_image_url, status: user.status });
    } catch (err) {
      console.error("GET /admin/users/:id error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * PATCH /admin/users/:id
 * Admin-only partial update for mobile users.
 */
router.patch(
  "/admin/users/:id",
  requireAuth,
  requirePermission("manage_users"),
  async (req, res) => {
    try {
      const userId = parseObjectId(req.params.id);
      if (!userId) {
        return res.status(422).json(
          buildValidationError({
            id: ["Must be a valid ObjectId"],
          })
        );
      }

      const { normalized, errors } = validateAdminUserPatchPayload(req.body);
      if (Object.keys(errors).length > 0) {
        return res.status(422).json(buildValidationError(errors));
      }

      if (Object.prototype.hasOwnProperty.call(normalized, "status")) {
        const admin = await AdminRecord.findOne({ _id: userId, record_type: "account" }).lean();
        if (admin) {
          if (admin.role !== "personnel") {
            return res.status(409).json({ message: "Only personnel accounts can be deactivated/reactivated" });
          }

          const updated = await AdminRecord.findOneAndUpdate(
            { _id: userId, record_type: "account", role: "personnel" },
            { $set: { status: normalized.status, updated_at: new Date() } },
            { returnDocument: "after" }
          ).lean();

          auditLog({
            action: "admin.account_status_changed",
            actor: req.admin?.adminId,
            target: updated.email,
            outcome: updated.status,
            details: { id: updated._id.toString() },
          });

          return res.json({
            id: updated._id.toString(),
            firebase_uid: null,
            email: updated.email,
            full_name: updated.full_name,
            phone_number: null,
            role: "personnel",
            profile_image_url: null,
            status: updated.status,
          });
        }
      }

      const current = await UserProfile.findById(userId).lean();
      if (!current) return res.status(404).json({ message: "User not found" });
      if (normalized.email && normalized.email !== current.email && await UserProfile.exists({ email: normalized.email })) return res.status(409).json({ message: "Email already exists" });
      const updated = await UserProfile.findByIdAndUpdate(userId, { $set: { ...normalized, updated_at: new Date() } }, { returnDocument: "after" }).lean();
      auditLog({
        action: "admin.user_updated",
        actor: req.admin?.adminId,
        target: updated.email,
        outcome: "updated",
        details: { id: updated._id.toString() },
      });
      return res.json({ id: updated._id.toString(), firebase_uid: updated.firebase_uid, email: updated.email, full_name: updated.full_name, phone_number: updated.phone_number, role: updated.role, profile_image_url: updated.profile_image_url, status: updated.status });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({ message: "Email already exists" });
      }
      console.error("PATCH /admin/users/:id error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * PATCH /admin/admins/:id
 * Admin-only partial update for admin/personnel accounts.
 */
router.patch(
  "/admin/admins/:id",
  requireAuth,
  requirePermission("manage_admins"),
  async (req, res) => {
    try {
      const adminId = parseObjectId(req.params.id);
      if (!adminId) {
        return res.status(422).json(
          buildValidationError({
            id: ["Must be a valid ObjectId"],
          })
        );
      }

      const { normalized, errors } = validateAdminAccountPatchPayload(req.body);
      if (Object.keys(errors).length > 0) {
        return res.status(422).json(buildValidationError(errors));
      }

      const current = await AdminRecord.findOne({ _id: adminId, record_type: "account" }).lean();
      if (!current) return res.status(404).json({ message: "Admin not found" });
      if (normalized.email && normalized.email !== current.email && await AdminRecord.exists({ record_type: "account", email: normalized.email })) return res.status(409).json({ message: "Email already exists" });
      const updated = await AdminRecord.findOneAndUpdate({ _id: adminId, record_type: "account" }, { $set: { ...normalized, updated_at: new Date() } }, { returnDocument: "after" }).lean();
      auditLog({ action: "admin.account_updated", actor: req.admin?.adminId, target: updated.email, outcome: "updated", details: { id: updated._id.toString() } });
      return res.json({ id: updated._id.toString(), email: updated.email, full_name: updated.full_name, created_at: updated.created_at });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({ message: "Email already exists" });
      }
      console.error("PATCH /admin/admins/:id error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * DELETE /admin/admins/:id
 * Disabled to prevent permanent deletion. Use PATCH status updates instead.
 */
router.delete(
  "/admin/admins/:id",
  requireAuth,
  requirePermission("manage_admins"),
  async (req, res) => {
    return res.status(410).json({
      message: "Admin deletion is disabled. Use PATCH /admin/users/:id with status=deactivated or status=active.",
    });
  }
);

/**
 * GET /admin/admin-requests
 * Returns admin requests with personnel details.
 */
router.get(
  "/admin/admin-requests",
  requireAuth,
      requirePermission("manage_admins"),
  async (req, res) => {
    try {
      const requests = await AdminRecord.find({ record_type: "access_request" }).sort({ created_at: -1 }).lean();
      const personnel = await AdminRecord.find({ _id: { $in: requests.map((row) => row.personnel_admin_id) }, record_type: "account" }).lean();
      const byId = new Map(personnel.map((row) => [row._id.toString(), row]));
      return res.json(requests.map((row) => ({ id: row._id.toString(), personnel_id: row.personnel_admin_id.toString(), requested_by_admin_id: row.requested_by_admin_id.toString(), status: row.status, note: row.note, decision_note: row.decision_note, created_at: row.created_at, reviewed_at: row.reviewed_at, reviewed_by_admin_id: row.reviewed_by_admin_id?.toString() ?? null, personnel_name: byId.get(row.personnel_admin_id.toString())?.full_name ?? null, personnel_email: byId.get(row.personnel_admin_id.toString())?.email ?? null })));
    } catch (err) {
      console.error("GET /admin/admin-requests error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * GET /admin/notifications
 * Returns notifications for the logged-in admin's mapped user account.
 */
router.get("/admin/notifications", requireAuth, async (req, res) => {
  try {
    applyNotificationNoStoreHeaders(res);
    const adminId = parseObjectId(req.admin?.adminId);
    if (!adminId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const permissions = await getAdminPermissions(adminId.toString());
    const operational = { sos: "manage_sos", incident: "view_incidents", incident_report: "view_incidents", broadcast: "view_broadcasts" };
    const excluded = Object.keys(operational).filter(type => !permissions.includes(operational[type]));
    const docs = await Notification.find({ record_type: "admin", recipient_type: "admin", recipient_id: adminId, type: { $nin: excluded } })
      .sort({ created_at: -1, _id: -1 })
      .lean();
    logDebug("notifications.list", {
      currentAdminId: adminId.toString(),
      resultCount: docs.length,
    });
    if (IS_DEBUG_LOG) {
      res.set("X-Current-Admin-Id", adminId.toString());
      res.set("X-Notifications-Count", String(docs.length));
    }
    return res.json(docs.map((doc) => normalizeNotificationRow(toAdminNotificationRow(doc))));
  } catch (err) {
    console.error("GET /admin/notifications error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

/**
 * POST /admin/admin-requests
 * Body: { personnel_id: number }
 * Sends an admin request for an existing personnel account.
 */
router.post(
  "/admin/admin-requests",
  requireAuth,
  requirePermission("manage_admins"),
  async (req, res) => {
    try {
      const personnelId = parseObjectId(req.body?.personnel_id);
      const requestedByAdminId = parseObjectId(req.admin?.adminId);
      const note =
        typeof req.body?.note === "string" && req.body.note.trim().length > 0
          ? req.body.note.trim()
          : null;

      if (!personnelId) {
        return res.status(400).json({ message: "Invalid personnel_id" });
      }
      if (!requestedByAdminId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const personnel = await AdminRecord.findOne({ _id: personnelId, record_type: "account" }).lean();
      if (!personnel) return res.status(404).json({ message: "Personnel not found" });
      if (personnel.role !== "personnel") return res.status(409).json({ message: "Only personnel accounts can be requested" });
      if (await AdminRecord.exists({ record_type: "access_request", personnel_admin_id: personnelId, status: "pending" })) return res.status(409).json({ message: "A pending request already exists for this personnel" });
      const created = await AdminRecord.create({ record_type: "access_request", personnel_admin_id: personnelId, requested_by_admin_id: requestedByAdminId, status: "pending", note, created_at: new Date(), updated_at: new Date() });
      try {
        await Notification.create({ record_type: "admin", recipient_type: "admin", recipient_id: personnelId, type: "admin_request", title: "Admin Access Request", message: "You have received an admin access request.", metadata: { admin_request_id: created._id.toString(), requested_by_admin_id: requestedByAdminId.toString() }, is_read: false, created_at: new Date() });
      } catch (notifyErr) {
        console.error("POST /admin/admin-requests notification error:", notifyErr?.message || notifyErr);
      }
      return res.status(201).json({ message: "Admin request sent", request: { id: created._id.toString(), personnel_id: created.personnel_admin_id.toString(), requested_by_admin_id: created.requested_by_admin_id.toString(), status: created.status, note: created.note, created_at: created.created_at } });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({ message: "A pending request already exists for this personnel" });
      }
      console.error("POST /admin/admin-requests error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * PATCH /admin/admin-requests/:id/accept
 * Body: { note?: string }
 */
router.patch(
  "/admin/admin-requests/:id/accept",
  requireAuth,
  async (req, res) => {
    try {
      const requestId = parseObjectId(req.params.id);
      const decidedByAdminId = parseObjectId(req.admin?.adminId);
      const note =
        typeof req.body?.note === "string" && req.body.note.trim().length > 0
          ? req.body.note.trim()
          : null;

      if (!requestId) {
        return res.status(400).json({ message: "Invalid request id" });
      }
      if (!decidedByAdminId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const current = await AdminRecord.findOne({ _id: requestId, record_type: "access_request" }).lean();
      if (!current) return res.status(404).json({ message: "Admin request not found" });
      if (current.status !== "pending") return res.status(409).json({ message: `Admin request ${requestId} is already ${current.status}` });
      if (!decidedByAdminId.equals(current.personnel_admin_id) && !(await getAdminPermissions(decidedByAdminId.toString())).includes("manage_admins")) return res.status(403).json({ message: "Insufficient permissions" });

      const session = await mongoose.startSession();
      let updated;
      try {
        await session.withTransaction(async () => {
          const promoted = await AdminRecord.findOneAndUpdate(
            { _id: current.personnel_admin_id, record_type: "account", role: "personnel" },
            { $set: { role: "admin", role_definition: { name: "admin" }, updated_at: new Date() } },
            { returnDocument: "after", session }
          ).lean();
          if (!promoted) throw Object.assign(new Error("Personnel/admin record not found"), { statusCode: 404 });
          updated = await AdminRecord.findOneAndUpdate(
            { _id: requestId, record_type: "access_request", status: "pending" },
            { $set: { status: "approved", decision_note: note ?? current.decision_note, reviewed_at: new Date(), reviewed_by_admin_id: decidedByAdminId, updated_at: new Date() } },
            { returnDocument: "after", session }
          ).lean();
          if (!updated) throw Object.assign(new Error("Admin request is no longer pending"), { statusCode: 409 });
        });
      } finally {
        await session.endSession();
      }
      auditLog({ action: "admin.admin_request_approved", actor: decidedByAdminId.toString(), target: `admin_request:${requestId}`, outcome: "approved" });
      return res.json({ message: "Admin request approved", request: { request_id: updated._id.toString(), personnel_id: updated.personnel_admin_id.toString(), status: updated.status } });

    } catch (err) {
      if (err?.statusCode) return res.status(err.statusCode).json({ message: err.message });
      console.error("PATCH /admin/admin-requests/:id/accept error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * PATCH /admin/admin-requests/:id/reject
 * Body: { note?: string }
 */
router.patch(
  "/admin/admin-requests/:id/reject",
  requireAuth,
  async (req, res) => {
    try {
      const requestId = parseObjectId(req.params.id);
      const decidedByAdminId = parseObjectId(req.admin?.adminId);
      const note =
        typeof req.body?.note === "string" && req.body.note.trim().length > 0
          ? req.body.note.trim()
          : null;

      if (!requestId) {
        return res.status(400).json({ message: "Invalid request id" });
      }
      if (!decidedByAdminId) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const current = await AdminRecord.findOne({ _id: requestId, record_type: "access_request" }).lean();
      if (!current) return res.status(404).json({ message: "Admin request not found" });
      if (current.status !== "pending") return res.status(409).json({ message: `Admin request ${requestId} is already ${current.status}` });
      if (!decidedByAdminId.equals(current.personnel_admin_id) && !(await getAdminPermissions(decidedByAdminId.toString())).includes("manage_admins")) return res.status(403).json({ message: "Insufficient permissions" });
      const updated = await AdminRecord.findOneAndUpdate(
        { _id: requestId, record_type: "access_request", status: "pending" },
        { $set: { status: "rejected", decision_note: note, reviewed_at: new Date(), reviewed_by_admin_id: decidedByAdminId, updated_at: new Date() } },
        { returnDocument: "after" }
      ).lean();
      if (!updated) return res.status(409).json({ message: `Admin request ${requestId} is no longer pending` });
      auditLog({ action: "admin.admin_request_rejected", actor: decidedByAdminId.toString(), target: `admin_request:${requestId}`, outcome: "rejected" });
      return res.json({ message: "Admin request rejected", request: { request_id: updated._id.toString(), personnel_id: updated.personnel_admin_id.toString(), status: updated.status } });

    } catch (err) {
      if (err?.statusCode) return res.status(err.statusCode).json({ message: err.message });
      console.error("PATCH /admin/admin-requests/:id/reject error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * PATCH /admin/notifications/:id/read
 */
router.patch("/admin/notifications/:id/read", requireAuth, async (req, res) => {
  try {
    applyNotificationNoStoreHeaders(res);
    const notificationId = parseObjectId(req.params.id);
    const adminId = parseObjectId(req.admin?.adminId);

    if (!notificationId) {
      return res.status(400).json({ message: "Invalid notification id" });
    }
    if (!adminId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const doc = await Notification.findOneAndUpdate(
      { _id: notificationId, record_type: "admin", recipient_id: adminId },
      { $set: { is_read: true } },
      { new: true }
    ).lean();

    if (!doc) {
      return res.status(404).json({ message: "Notification not found" });
    }

    return res.json({
      message: "Notification marked as read",
      notification: normalizeNotificationRow(toAdminNotificationRow(doc)),
    });
  } catch (err) {
    console.error("PATCH /admin/notifications/:id/read error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
