import express from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { requireAdminAuth } from "../middleware/adminAuth.js";
import { notifyUserLifecycleEvent } from "../services/userNotifications.js";

const router = express.Router();
const MAX_IMAGES_PER_INCIDENT = 5;
const INCIDENT_STATUSES = ["pending", "dispatched", "in_progress", "resolved"];
const INCIDENT_PRIORITIES = ["critical", "high", "medium", "low"];
const INCIDENT_DEPARTMENTS = [
  "Emergency Medical Unit",
  "Fire Station Unit",
  "Police Personnel",
  "Traffic Enforcement Unit"
];
const IS_DEBUG_LOG = String(process.env.LOG_LEVEL || "").toLowerCase() === "debug";

function logDebug(event, payload) {
  if (!IS_DEBUG_LOG) {
    return;
  }
  console.debug(`[incident-routes] ${event}`, payload);
}

function getRequestTrace(req, overrides = {}) {
  return {
    requestId: req.get?.("x-request-id") || randomUUID(),
    adminId: Number(req.admin?.adminId ?? null),
    ...overrides,
  };
}

async function notifyAdminsAboutIncident({ incidentId, incidentType }) {
  const title = "New Incident Report";
  const safeIncidentType =
    typeof incidentType === "string" && incidentType.trim()
      ? incidentType.trim()
      : "incident";
  const message = `A new ${safeIncidentType} incident was reported.`;

  const insertResult = await pool.query(
    `
    INSERT INTO notifications (
      recipient_admin_id, type, title, message, metadata, is_read, created_at
    )
    SELECT
      a.id,
      'incident',
      $1,
      $2,
      jsonb_build_object(
        'reference_id',
        $3::bigint,
        'incident_id',
        $3::bigint,
        'fallback_route',
        '/admin/incidents/' || $3::text
      ),
      false,
      NOW()
    FROM admins a
    WHERE a.status = 'active'
    `,
    [title, message, Number(incidentId)]
  );
  logDebug("notifications.insert", {
    incidentId: Number(incidentId),
    incidentType: safeIncidentType,
    recipientCount: insertResult.rowCount ?? 0
  });
  if ((insertResult.rowCount ?? 0) === 0) {
    console.warn("[incident-routes] No active admin recipients for incident notification", {
      incidentId: Number(incidentId)
    });
  }
}

function parsePositiveInt(value) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return null;
  }
  return num;
}

function toIso(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function toImageRefArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toIncidentImageUrl(incidentId, imageId, isAdminRoute = false) {
  if (isAdminRoute) {
    return `/admin/incidents/${incidentId}/images/${imageId}`;
  }
  return `/incidents/${incidentId}/images/${imageId}`;
}

function toIncidentDto(row, { isAdminRoute = false } = {}) {
  const imageRefs = toImageRefArray(row.images)
    .map((item) => ({
      id: Number(item?.id),
      sort_order: Number(item?.sort_order)
    }))
    .filter((item) => Number.isInteger(item.id) && item.id > 0)
    .sort((a, b) => {
      if (a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
      }
      return a.id - b.id;
    });

  const imageUrls = imageRefs.map((item) =>
    toIncidentImageUrl(Number(row.id), item.id, isAdminRoute)
  );

  // Canonical incident response uses snake_case for lifecycle timestamps and resolution fields.
  return {
    id: Number(row.id),
    title: `Incident #${row.id}`,
    incident_type: row.incident_type ?? "",
    assigned_department: row.assigned_department ?? null,
    description: row.description ?? "",
    priority: row.priority ?? "medium",
    status: row.status,
    location: {
      latitude: row.latitude == null ? null : Number(row.latitude),
      longitude: row.longitude == null ? null : Number(row.longitude),
      address: row.address ?? null
    },
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    dispatched_at: toIso(row.dispatched_at),
    resolved_at: toIso(row.resolved_at),
    reportedByUserId: row.user_id == null ? null : Number(row.user_id),
    resolution_notes: row.resolution_notes ?? null,
    image_url: imageUrls[0] ?? null,
    images: imageUrls
  };
}

function canTransitionStatus(currentStatus, nextStatus) {
  if (!nextStatus || currentStatus === nextStatus) {
    return true;
  }

  const allowedNext = {
    pending: "dispatched",
    dispatched: "in_progress",
    in_progress: "resolved",
    resolved: null
  };

  return allowedNext[currentStatus] === nextStatus;
}

async function listIncidents({ status, limit, offset }) {
  const values = [];
  const where = [];

  if (status) {
    values.push(status);
    where.push(`ir.status = $${values.length}`);
  }

  values.push(limit);
  const limitParam = `$${values.length}`;
  values.push(offset);
  const offsetParam = `$${values.length}`;
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const result = await pool.query(
    `
    SELECT
      ir.id,
      ir.user_id,
      ir.incident_type,
      ir.description,
      ir.latitude,
      ir.longitude,
      ir.address,
      ir.priority,
      ir.status,
      ir.created_at,
      ir.updated_at,
      ir.dispatched_at,
      ir.resolved_at,
      ir.assigned_department,
      ir.resolution_notes,
      COALESCE(img.images, '[]'::json) AS images
    FROM incident_reports ir
    LEFT JOIN LATERAL (
      SELECT
        json_agg(
          json_build_object(
            'id', iri.id,
            'sort_order', iri.sort_order
          )
          ORDER BY iri.sort_order ASC, iri.id ASC
        ) AS images
      FROM incident_report_images iri
      WHERE iri.incident_report_id = ir.id
    ) img ON TRUE
    ${whereClause}
    ORDER BY ir.created_at DESC, ir.id DESC
    LIMIT ${limitParam}
    OFFSET ${offsetParam}
    `,
    values
  );

  return result.rows;
}

async function getIncidentById(incidentId) {
  const result = await pool.query(
    `
    SELECT
      ir.id,
      ir.user_id,
      ir.incident_type,
      ir.description,
      ir.latitude,
      ir.longitude,
      ir.address,
      ir.priority,
      ir.status,
      ir.created_at,
      ir.updated_at,
      ir.dispatched_at,
      ir.resolved_at,
      ir.assigned_department,
      ir.resolution_notes,
      COALESCE(img.images, '[]'::json) AS images
    FROM incident_reports ir
    LEFT JOIN LATERAL (
      SELECT
        json_agg(
          json_build_object(
            'id', iri.id,
            'sort_order', iri.sort_order
          )
          ORDER BY iri.sort_order ASC, iri.id ASC
        ) AS images
      FROM incident_report_images iri
      WHERE iri.incident_report_id = ir.id
    ) img ON TRUE
    WHERE ir.id = $1
    LIMIT 1
    `,
    [incidentId]
  );

  return result.rows[0] ?? null;
}

async function getIncidentImage({ incidentId, imageId, firebaseUid }) {
  const values = [incidentId, imageId];
  const userFilter =
    typeof firebaseUid === "string" && firebaseUid.trim()
      ? `AND EXISTS (
          SELECT 1
          FROM users u
          WHERE u.id = ir.user_id
            AND u.firebase_uid = $3
        )`
      : "";

  if (userFilter) {
    values.push(firebaseUid.trim());
  }

  const result = await pool.query(
    `
    SELECT iri.image_data, iri.content_type
    FROM incident_report_images iri
    JOIN incident_reports ir ON ir.id = iri.incident_report_id
    WHERE ir.id = $1
      AND iri.id = $2
      ${userFilter}
    LIMIT 1
    `,
    values
  );

  return result.rows[0] ?? null;
}

function detectImageContentType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function parseImageInput(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Each image must be a non-empty base64 string");
  }

  const trimmed = value.trim();
  const dataUriMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  let declaredContentType = null;
  let base64Payload = trimmed;

  if (dataUriMatch) {
    declaredContentType = dataUriMatch[1].toLowerCase();
    base64Payload = dataUriMatch[2];
  }

  const normalizedBase64 = base64Payload.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64) || normalizedBase64.length % 4 !== 0) {
    throw new Error("Invalid base64 image payload");
  }

  const imageData = Buffer.from(normalizedBase64, "base64");
  if (!imageData.length) {
    throw new Error("Decoded image is empty");
  }

  const roundTrip = imageData.toString("base64").replace(/=+$/g, "");
  const incoming = normalizedBase64.replace(/=+$/g, "");
  if (roundTrip !== incoming) {
    throw new Error("Invalid base64 image payload");
  }

  const sniffedType = detectImageContentType(imageData);
  const contentType = declaredContentType || sniffedType;

  if (!contentType || !contentType.startsWith("image/")) {
    throw new Error("Image content type must be an image/* type");
  }
  if (sniffedType && declaredContentType && sniffedType !== declaredContentType) {
    throw new Error("Declared image type does not match decoded image data");
  }

  return {
    imageData,
    contentType
  };
}


router.get("/admin/incidents", requireAdminAuth, async (req, res) => {
  try {
    const status = typeof req.query?.status === "string" ? req.query.status.trim().toLowerCase() : null;
    if (status && !INCIDENT_STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid status filter" });
    }

    const page = parsePositiveInt(req.query?.page) ?? 1;
    const limit = Math.min(parsePositiveInt(req.query?.limit) ?? 20, 100);
    const offset = (page - 1) * limit;

    const rows = await listIncidents({ status, limit, offset });
    return res.json(rows.map((row) => toIncidentDto(row, { isAdminRoute: true })));
  } catch (err) {
    console.error("GET /admin/incidents error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.get("/admin/incidents/:id", requireAdminAuth, async (req, res) => {
  try {
    const incidentId = parsePositiveInt(req.params?.id);
    if (!incidentId) {
      return res.status(400).json({ message: "Invalid incident id" });
    }

    const row = await getIncidentById(incidentId);
    if (!row) {
      return res.status(404).json({ message: "Incident not found" });
    }

    return res.json(toIncidentDto(row, { isAdminRoute: true }));
  } catch (err) {
    console.error("GET /admin/incidents/:id error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

router.patch(
  "/admin/incidents/:id",
  requireAdminAuth,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const incidentId = parsePositiveInt(req.params?.id);
      if (!incidentId) {
        return res.status(400).json({ message: "Invalid incident id" });
      }
      const trace = getRequestTrace(req, {
        action: "admin_incident_update",
        entityType: "incident",
        entityId: incidentId,
      });

      const nextStatus =
        typeof req.body?.status === "string" ? req.body.status.trim().toLowerCase() : undefined;
      const nextPriority =
        typeof req.body?.priority === "string" ? req.body.priority.trim().toLowerCase() : undefined;
      const nextIncidentTypeRaw = req.body?.incident_type;
      const hasAssignedDepartmentKey =
        Object.prototype.hasOwnProperty.call(req.body ?? {}, "assigned_department") ||
        Object.prototype.hasOwnProperty.call(req.body ?? {}, "assignedDepartment");
      const assignedDepartmentRaw = Object.prototype.hasOwnProperty.call(
        req.body ?? {},
        "assigned_department"
      )
        ? req.body?.assigned_department
        : req.body?.assignedDepartment;
      const resolutionNotesRaw = req.body?.resolutionNotes;

      if (
        Object.prototype.hasOwnProperty.call(req.body ?? {}, "assigned_admin_id") ||
        Object.prototype.hasOwnProperty.call(req.body ?? {}, "assignedAdminId")
      ) {
        return res.status(400).json({
          message: "assigned_admin_id is no longer supported; use assigned_department"
        });
      }
      if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "category")) {
        return res.status(400).json({
          message: "category is no longer supported; use incident_type"
        });
      }

      if (nextStatus != null && !INCIDENT_STATUSES.includes(nextStatus)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      if (nextPriority != null && !INCIDENT_PRIORITIES.includes(nextPriority)) {
        return res.status(400).json({ message: "Invalid priority" });
      }
      let nextIncidentType = undefined;
      if (nextIncidentTypeRaw !== undefined) {
        if (typeof nextIncidentTypeRaw !== "string" || !nextIncidentTypeRaw.trim()) {
          return res.status(400).json({ message: "Invalid incident_type" });
        }
        nextIncidentType = nextIncidentTypeRaw.trim();
      }

      let assignedDepartment = undefined;
      if (hasAssignedDepartmentKey) {
        if (assignedDepartmentRaw === null) {
          assignedDepartment = null;
        } else if (typeof assignedDepartmentRaw === "string") {
          const normalizedDepartment = assignedDepartmentRaw.trim();
          if (!INCIDENT_DEPARTMENTS.includes(normalizedDepartment)) {
            return res.status(400).json({ message: "Invalid assigned_department" });
          }
          assignedDepartment = normalizedDepartment;
        } else {
          return res.status(400).json({ message: "Invalid assigned_department" });
        }
      }

      let resolutionNotes = undefined;
      if (resolutionNotesRaw !== undefined) {
        if (resolutionNotesRaw === null) {
          resolutionNotes = null;
        } else if (typeof resolutionNotesRaw === "string") {
          resolutionNotes = resolutionNotesRaw.trim() || null;
        } else {
          return res.status(400).json({ message: "Invalid resolutionNotes" });
        }
      }

      if (
        nextStatus === undefined &&
        nextPriority === undefined &&
        nextIncidentType === undefined &&
        assignedDepartment === undefined &&
        resolutionNotes === undefined
      ) {
        return res.status(400).json({ message: "No valid updates provided" });
      }

      await client.query("BEGIN");

      const currentResult = await client.query(
        `
        SELECT
          id,
          user_id,
          status,
          assigned_department,
          dispatched_at,
          resolved_at
        FROM incident_reports
        WHERE id = $1
        LIMIT 1
        `,
        [incidentId]
      );

      if (currentResult.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Incident not found" });
      }

      const current = currentResult.rows[0];
      const effectiveStatus = nextStatus ?? current.status;
      const shouldNotifySender =
        nextStatus !== undefined &&
        current.status !== effectiveStatus &&
        ["dispatched", "in_progress", "resolved"].includes(effectiveStatus);
      if (!shouldNotifySender) {
        console.info("[incident-routes] sender notification skipped", {
          ...trace,
          currentStatus: current.status,
          nextStatus: nextStatus ?? null,
          effectiveStatus,
          reason:
            nextStatus === undefined
              ? "status_unchanged_or_missing"
              : current.status === effectiveStatus
                ? "status_unchanged_or_missing"
                : "non_milestone_status",
        });
      }
      if (!canTransitionStatus(current.status, effectiveStatus)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Invalid status transition" });
      }

      const values = [incidentId];
      const setClauses = [];

      if (nextIncidentType !== undefined) {
        values.push(nextIncidentType);
        setClauses.push(`incident_type = $${values.length}`);
      }

      if (nextStatus !== undefined) {
        values.push(nextStatus);
        setClauses.push(`status = $${values.length}`);
      }

      if (nextPriority !== undefined) {
        values.push(nextPriority);
        setClauses.push(`priority = $${values.length}`);
      }

      if (assignedDepartment !== undefined) {
        values.push(assignedDepartment);
        setClauses.push(`assigned_department = $${values.length}`);
      }

      if (resolutionNotes !== undefined) {
        values.push(resolutionNotes);
        setClauses.push(`resolution_notes = $${values.length}`);
      }

      if (effectiveStatus === "dispatched" && current.dispatched_at == null) {
        setClauses.push("dispatched_at = NOW()");
      }

      if (effectiveStatus === "resolved" && current.resolved_at == null) {
        setClauses.push("resolved_at = NOW()");
      }

      setClauses.push("updated_at = NOW()");

      const updateResult = await client.query(
        `
        UPDATE incident_reports
        SET ${setClauses.join(", ")}
        WHERE id = $1
        RETURNING id
        `,
        values
      );

      await client.query("COMMIT");
      const updated = await getIncidentById(updateResult.rows[0].id);
      if (shouldNotifySender) {
        console.info("[incident-routes] sender notification dispatch queued", {
          ...trace,
          recipientUserId: Number(current.user_id ?? null),
          status: effectiveStatus,
          assignedDepartment: updated?.assigned_department ?? current.assigned_department ?? null,
        });
        notifyUserLifecycleEvent({
          recipient_user_id: current.user_id,
          entity_type: "incident",
          entity_id: updateResult.rows[0].id,
          status: effectiveStatus,
          assigned_department: updated?.assigned_department ?? current.assigned_department ?? null,
          trace: {
            ...trace,
            recipientUserId: Number(current.user_id ?? null),
            notificationType: "incident_update",
            status: effectiveStatus,
          }
        })
          .then((result) => {
            console.info("[incident-routes] sender notification result", {
              ...trace,
              recipientUserId: Number(current.user_id ?? null),
              status: effectiveStatus,
              notificationId: result?.notification?.id ?? null,
              skipped: result?.skipped ?? false,
              reason: result?.reason ?? result?.push?.reason ?? result?.push?.error ?? null,
              push: result?.push ?? null,
            });
          })
          .catch((notifyErr) => {
            console.error("sender incident notification failed:", notifyErr?.message || notifyErr, {
              ...trace,
              recipientUserId: Number(current.user_id ?? null),
            });
          });
      }
      return res.json(toIncidentDto(updated, { isAdminRoute: true }));
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("PATCH /admin/incidents/:id rollback error:", rollbackErr);
      }
      console.error("PATCH /admin/incidents/:id error:", err);
      return res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
    }
  }
);

router.get(
  "/admin/incidents/:incidentId/images/:imageId",
  requireAdminAuth,
  async (req, res) => {
    try {
      const incidentId = parsePositiveInt(req.params?.incidentId);
      const imageId = parsePositiveInt(req.params?.imageId);
      if (!incidentId || !imageId) {
        return res.status(400).json({ message: "Invalid incident/image id" });
      }

      const image = await getIncidentImage({ incidentId, imageId });
      if (!image) {
        return res.status(404).json({ message: "Image not found" });
      }

      res.set("Content-Type", image.content_type || "application/octet-stream");
      return res.send(image.image_data);
    } catch (err) {
      console.error("GET /admin/incidents/:incidentId/images/:imageId error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  }
);

router.get("/incidents/:incidentId/images/:imageId", requireAppAuth, async (req, res) => {
  try {
    const incidentId = parsePositiveInt(req.params?.incidentId);
    const imageId = parsePositiveInt(req.params?.imageId);
    if (!incidentId || !imageId) {
      return res.status(400).json({ message: "Invalid incident/image id" });
    }

    const image = await getIncidentImage({
      incidentId,
      imageId,
      firebaseUid: req.auth?.uid
    });
    if (!image) {
      return res.status(404).json({ message: "Image not found" });
    }

    res.set("Content-Type", image.content_type || "application/octet-stream");
    return res.send(image.image_data);
  } catch (err) {
    console.error("GET /incidents/:incidentId/images/:imageId error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});
/**
 * POST /incidents
 * Body: {
 *   incident_type,
 *   description,
 *   latitude?,
 *   longitude?,
 *   address?,
 *   images?: ["data:image/jpeg;base64,..."] | ["<plain-base64>"]
 * }
 */
router.post("/incidents", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const { incident_type, description, latitude, longitude, address, images } = req.body;

  if (!incident_type || typeof incident_type !== "string") {
    return res.status(400).json({ message: "Invalid incident_type" });
  }
  if (!description || typeof description !== "string" || description.trim().length < 5) {
    return res.status(400).json({ message: "Description must be at least 5 characters" });
  }
  if (latitude != null && typeof latitude !== "number") {
    return res.status(400).json({ message: "Invalid latitude" });
  }
  if (longitude != null && typeof longitude !== "number") {
    return res.status(400).json({ message: "Invalid longitude" });
  }
  if (address != null && typeof address !== "string") {
    return res.status(400).json({ message: "Invalid address" });
  }
  if (images != null && !Array.isArray(images)) {
    return res.status(400).json({ message: "Invalid images. Expected an array of base64 strings." });
  }
  if (Array.isArray(images) && images.length > MAX_IMAGES_PER_INCIDENT) {
    return res.status(400).json({ message: `Max ${MAX_IMAGES_PER_INCIDENT} images are allowed per incident` });
  }

  let parsedImages = [];
  try {
    parsedImages = Array.isArray(images) ? images.map(parseImageInput) : [];
  } catch (err) {
    return res.status(400).json({ message: err?.message || "Invalid image payload" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Map firebase uid -> postgres user id
    const userRes = await client.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (userRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "User not found. Call /me/bootstrap first." });
    }

    const userId = userRes.rows[0].id;

    const insertRes = await client.query(
      `INSERT INTO incident_reports (user_id, incident_type, description, latitude, longitude, address)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, incident_type, description, latitude, longitude, address, status, created_at`,
      [
        userId,
        incident_type.trim(),
        description.trim(),
        latitude ?? null,
        longitude ?? null,
        address ?? null
      ]
    );

    const incidentReport = insertRes.rows[0];
    for (let i = 0; i < parsedImages.length; i++) {
      const { imageData, contentType } = parsedImages[i];
      await client.query(
        `INSERT INTO incident_report_images (incident_report_id, image_data, content_type, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [incidentReport.id, imageData, contentType, i]
      );
    }

    await client.query("COMMIT");
    logDebug("create.completed", {
      incidentId: Number(incidentReport.id),
      userId: Number(userId),
      incidentType: incidentReport.incident_type
    });
    try {
      await notifyAdminsAboutIncident({
        incidentId: incidentReport.id,
        incidentType: incidentReport.incident_type,
      });
    } catch (notifyErr) {
      // Best-effort notification fan-out should not block incident creation flow.
      console.error("Incident admin notification insert failed:", notifyErr?.message || notifyErr, {
        code: notifyErr?.code,
        incidentId: Number(incidentReport.id)
      });
    }
    return res.status(201).json({
      ...incidentReport,
      images_count: parsedImages.length
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create incident failed:", err?.message || err);
    return res.status(500).json({ message: "Failed to create incident report" });
  } finally {
    client.release();
  }
});

export default router;


