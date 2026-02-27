import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { requireAdminAuth } from "../middleware/adminAuth.js";

const router = express.Router();
const MAX_IMAGES_PER_INCIDENT = 5;

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
    const status = typeof req.query?.status === "string" ? req.query.status.trim().toLowerCase() : "";
    const values = [];
    let whereClause = "";

    if (status) {
      values.push(status);
      whereClause = `WHERE ir.status = $${values.length}`;
    }

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
        ir.status,
        ir.created_at,
        COALESCE(img.images_count, 0) AS images_count
      FROM incident_reports ir
      LEFT JOIN (
        SELECT incident_report_id, COUNT(*)::int AS images_count
        FROM incident_report_images
        GROUP BY incident_report_id
      ) img ON img.incident_report_id = ir.id
      ${whereClause}
      ORDER BY ir.created_at DESC, ir.id DESC
      `,
      values
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("GET /admin/incidents error:", err);
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


