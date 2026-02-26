import express from "express";
import { getAdminPermissions } from "../middleware/adminAuth.js";
import { pool } from "../db.js";
import { requireAuth, requirePermission } from "../middleware/adminAuth.js"; // ✅ FIXED

const router = express.Router();
const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMIN_USER_PATCH_ALLOWED_FIELDS = ["full_name", "email"];
const ADMIN_ACCOUNT_PATCH_ALLOWED_FIELDS = ["full_name", "email"];
const ADMIN_USER_RETURN_FIELDS = `
  id,
  firebase_uid,
  email,
  full_name,
  phone_number,
  role,
  profile_image_url
`;

function buildValidationError(errors) {
  return { message: "Validation failed", errors };
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
      const userId = Number(req.params.id);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(422).json(
          buildValidationError({
            id: ["Must be a positive integer"],
          })
        );
      }

      const { normalized, errors } = validateAdminUserPatchPayload(req.body);
      if (Object.keys(errors).length > 0) {
        return res.status(422).json(buildValidationError(errors));
      }

      const updates = [];
      const values = [];

      if (Object.prototype.hasOwnProperty.call(normalized, "full_name")) {
        values.push(normalized.full_name);
        updates.push(`full_name = $${values.length}`);
      }
      if (Object.prototype.hasOwnProperty.call(normalized, "email")) {
        values.push(normalized.email);
        updates.push(`email = $${values.length}`);
      }

      values.push(userId);
      const result = await pool.query(
        `
        UPDATE users
        SET ${updates.join(", ")}, updated_at = NOW()
        WHERE id = $${values.length}
        RETURNING ${ADMIN_USER_RETURN_FIELDS}
        `,
        values
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ message: "User not found" });
      }

      return res.json(result.rows[0]);
    } catch (err) {
      if (err?.code === "23505") {
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
      const adminId = Number(req.params.id);
      if (!Number.isInteger(adminId) || adminId <= 0) {
        return res.status(422).json(
          buildValidationError({
            id: ["Must be a positive integer"],
          })
        );
      }

      const { normalized, errors } = validateAdminAccountPatchPayload(req.body);
      if (Object.keys(errors).length > 0) {
        return res.status(422).json(buildValidationError(errors));
      }

      const updates = [];
      const values = [];

      if (Object.prototype.hasOwnProperty.call(normalized, "full_name")) {
        values.push(normalized.full_name);
        updates.push(`full_name = $${values.length}`);
      }
      if (Object.prototype.hasOwnProperty.call(normalized, "email")) {
        values.push(normalized.email);
        updates.push(`email = $${values.length}`);
      }

      values.push(adminId);
      const result = await pool.query(
        `
        UPDATE admins
        SET ${updates.join(", ")}
        WHERE id = $${values.length}
        RETURNING id, email, full_name, role_id, created_at
        `,
        values
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Admin not found" });
      }

      return res.json(result.rows[0]);
    } catch (err) {
      if (err?.code === "23505") {
        return res.status(409).json({ message: "Email already exists" });
      }
      console.error("PATCH /admin/admins/:id error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * DELETE /admin/admins/:id
 * Deletes an admin/personnel account by id.
 */
router.delete(
  "/admin/admins/:id",
  requireAuth,
  requirePermission("manage_admins"),
  async (req, res) => {
    try {
      const targetAdminId = Number(req.params.id);
      const requestingAdminId = Number(req.admin?.adminId);

      if (!Number.isInteger(targetAdminId) || targetAdminId <= 0) {
        return res.status(400).json({ message: "Invalid admin id" });
      }
      if (!Number.isInteger(requestingAdminId) || requestingAdminId <= 0) {
        return res.status(401).json({ message: "Unauthorized" });
      }
      if (targetAdminId === requestingAdminId) {
        return res.status(409).json({ message: "You cannot delete your own account" });
      }

      const deleteResult = await pool.query(
        `
        DELETE FROM admins
        WHERE id = $1
        RETURNING id, email, full_name, role_id, created_at
        `,
        [targetAdminId]
      );

      if (deleteResult.rowCount === 0) {
        return res.status(404).json({ message: "Admin not found" });
      }

      return res.json({
        message: "Admin deleted successfully",
        admin: deleteResult.rows[0],
      });
    } catch (err) {
      console.error("DELETE /admin/admins/:id error:", err);
      return res.status(500).json({ message: "Server error" });
    }
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
      const result = await pool.query(
        `
        SELECT
          ar.*,
          p.full_name AS personnel_name,
          p.email AS personnel_email
        FROM admin_requests ar
        JOIN admins p ON p.id = ar.personnel_id
        ORDER BY ar.created_at DESC
        `
      );

      return res.json(result.rows);
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
    const adminId = Number(req.admin?.adminId);
    if (!Number.isInteger(adminId) || adminId <= 0) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const notificationsResult = await pool.query(
      `
      SELECT id, recipient_admin_id, type, title, message, metadata, is_read, created_at
      FROM notifications
      WHERE recipient_admin_id = $1
      ORDER BY created_at DESC
      `,
      [adminId]
    );

    return res.json(notificationsResult.rows);
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
    const client = await pool.connect();
    try {
      const personnelId = Number(req.body?.personnel_id);
      const requestedByAdminId = Number(req.admin?.adminId);
      const note =
        typeof req.body?.note === "string" && req.body.note.trim().length > 0
          ? req.body.note.trim()
          : null;

      if (!Number.isInteger(personnelId) || personnelId <= 0) {
        return res.status(400).json({ message: "Invalid personnel_id" });
      }
      if (!Number.isInteger(requestedByAdminId) || requestedByAdminId <= 0) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      await client.query("BEGIN");

      const personnelResult = await client.query(
        `
        SELECT a.id, r.name AS role
        FROM admins a
        JOIN roles r ON r.id = a.role_id
        WHERE a.id = $1
        `,
        [personnelId]
      );

      if (personnelResult.rowCount === 0) {
        return res.status(404).json({ message: "Personnel not found" });
      }

      if (personnelResult.rows[0].role !== "personnel") {
        return res.status(409).json({ message: "Only personnel accounts can be requested" });
      }

      const insertResult = await client.query(
        `
        INSERT INTO admin_requests (personnel_id, requested_by_admin_id, note)
        VALUES ($1, $2, $3)
        RETURNING id, personnel_id, requested_by_admin_id, status, note, created_at
        `,
        [personnelId, requestedByAdminId, note]
      );

      const adminRequest = insertResult.rows[0];
      await client.query(
        `
        INSERT INTO notifications (
          recipient_admin_id, type, title, message, metadata, is_read, created_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, false, NOW())
        `,
        [
          personnelId,
          "admin_request",
          "Admin Access Request",
          "You have received an admin access request.",
          JSON.stringify({
            admin_request_id: adminRequest.id,
            requested_by_admin_id: requestedByAdminId,
          }),
        ]
      );

      await client.query("COMMIT");

      return res.status(201).json({
        message: "Admin request sent",
        request: adminRequest,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("POST /admin/admin-requests rollback error:", rollbackErr);
      }
      if (err?.code === "23505") {
        return res.status(409).json({ message: "A pending request already exists for this personnel" });
      }
      console.error("POST /admin/admin-requests error:", err);
      return res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
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
    const client = await pool.connect();
    try {
      const requestId = Number(req.params.id);
      const decidedByAdminId = Number(req.admin?.adminId);
      const note =
        typeof req.body?.note === "string" && req.body.note.trim().length > 0
          ? req.body.note.trim()
          : null;

      if (!Number.isInteger(requestId) || requestId <= 0) {
        return res.status(400).json({ message: "Invalid request id" });
      }
      if (!Number.isInteger(decidedByAdminId) || decidedByAdminId <= 0) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      await client.query("BEGIN");

      const lockResult = await client.query(
        `
        SELECT id, personnel_id, status
        FROM admin_requests
        WHERE id = $1
        FOR UPDATE
        `,
        [requestId]
      );

      if (lockResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Admin request not found" });
      }

      const current = lockResult.rows[0];
      if (current.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: `Admin request ${requestId} is already ${current.status}` });
      }

      if (decidedByAdminId !== Number(current.personnel_id)) {
        const permissions = await getAdminPermissions(decidedByAdminId);
        if (!permissions.includes("manage_admins")) {
          await client.query("ROLLBACK");
          return res.status(403).json({ message: "Insufficient permissions" });
        }
      }

      const adminRoleResult = await client.query(
        `
        SELECT id
        FROM roles
        WHERE lower(name) = 'admin'
        LIMIT 1
        `
      );

      if (adminRoleResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(500).json({ message: 'Role "admin" not found in roles table' });
      }

      const adminRoleId = adminRoleResult.rows[0].id;

      const roleUpdateResult = await client.query(
        `
        UPDATE admins
        SET role_id = $2
        WHERE id = $1
        RETURNING id
        `,
        [current.personnel_id, adminRoleId]
      );

      if (roleUpdateResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: `Personnel/admin record ${current.personnel_id} not found` });
      }

      const requestUpdateResult = await client.query(
        `
        UPDATE admin_requests
        SET
          status = 'approved',
          decision_note = COALESCE($2, decision_note),
          reviewed_at = NOW(),
          reviewed_by_admin_id = $3
        WHERE id = $1
        RETURNING id AS request_id, personnel_id, status
        `,
        [requestId, note, decidedByAdminId]
      );

      await client.query("COMMIT");

      return res.json({
        message: "Admin request approved",
        request: requestUpdateResult.rows[0],
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("PATCH /admin/admin-requests/:id/accept rollback error:", rollbackErr);
      }
      console.error("PATCH /admin/admin-requests/:id/accept error:", err);
      return res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
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
    const client = await pool.connect();
    try {
      const requestId = Number(req.params.id);
      const decidedByAdminId = Number(req.admin?.adminId);
      const note =
        typeof req.body?.note === "string" && req.body.note.trim().length > 0
          ? req.body.note.trim()
          : null;

      if (!Number.isInteger(requestId) || requestId <= 0) {
        return res.status(400).json({ message: "Invalid request id" });
      }
      if (!Number.isInteger(decidedByAdminId) || decidedByAdminId <= 0) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      await client.query("BEGIN");

      const lockResult = await client.query(
        `
        SELECT id, personnel_id, status
        FROM admin_requests
        WHERE id = $1
        FOR UPDATE
        `,
        [requestId]
      );

      if (lockResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Admin request not found" });
      }

      const current = lockResult.rows[0];
      if (current.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: `Admin request ${requestId} is already ${current.status}` });
      }

      if (decidedByAdminId !== Number(current.personnel_id)) {
        const permissions = await getAdminPermissions(decidedByAdminId);
        if (!permissions.includes("manage_admins")) {
          await client.query("ROLLBACK");
          return res.status(403).json({ message: "Insufficient permissions" });
        }
      }

      const updateResult = await client.query(
        `
        UPDATE admin_requests
        SET
          status = 'rejected',
          decision_note = $2,
          reviewed_at = NOW(),
          reviewed_by_admin_id = $3
        WHERE id = $1
        RETURNING id AS request_id, personnel_id, status
        `,
        [requestId, note, decidedByAdminId]
      );

      await client.query("COMMIT");

      return res.json({
        message: "Admin request rejected",
        request: updateResult.rows[0],
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("PATCH /admin/admin-requests/:id/reject rollback error:", rollbackErr);
      }
      console.error("PATCH /admin/admin-requests/:id/reject error:", err);
      return res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
    }
  }
);

/**
 * PATCH /admin/notifications/:id/read
 */
router.patch("/admin/notifications/:id/read", requireAuth, async (req, res) => {
  try {
    const notificationId = Number(req.params.id);
    const adminId = Number(req.admin?.adminId);

    if (!Number.isInteger(notificationId) || notificationId <= 0) {
      return res.status(400).json({ message: "Invalid notification id" });
    }
    if (!Number.isInteger(adminId) || adminId <= 0) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const updateResult = await pool.query(
      `
      UPDATE notifications
      SET is_read = true
      WHERE id = $1 AND recipient_admin_id = $2
      RETURNING id, recipient_admin_id, type, title, message, metadata, is_read, created_at
      `,
      [notificationId, adminId]
    );

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ message: "Notification not found" });
    }

    return res.json({
      message: "Notification marked as read",
      notification: updateResult.rows[0],
    });
  } catch (err) {
    console.error("PATCH /admin/notifications/:id/read error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;
