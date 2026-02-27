import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";

const router = express.Router();

function normalizeBeaconCode(code) {
  return String(code).trim().toUpperCase();
}

/**
 * POST /friends/request
 * Body: { beacon_code }
 */
router.post("/friends/request", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const { beacon_code } = req.body;

  if (!beacon_code || typeof beacon_code !== "string") {
    return res.status(400).json({ message: "Invalid beacon_code" });
  }

  const code = normalizeBeaconCode(beacon_code);

  // Get current user
  const meRes = await pool.query("SELECT id FROM users WHERE firebase_uid = $1", [uid]);
  if (meRes.rowCount === 0) return res.status(404).json({ message: "User not found" });
  const myId = meRes.rows[0].id;

  // Find target user
  const targetRes = await pool.query("SELECT id FROM users WHERE beacon_code = $1", [code]);
  if (targetRes.rowCount === 0) return res.status(404).json({ message: "User not found" });
  const targetId = targetRes.rows[0].id;

  if (myId === targetId) return res.status(400).json({ message: "Cannot add yourself" });

  // Already friends?
  const friendCheck = await pool.query(
    `SELECT 1 FROM public.friendships WHERE user_id = $1 AND friend_user_id = $2`,
    [myId, targetId]
  );
  if (friendCheck.rowCount > 0) return res.status(409).json({ message: "Already friends" });

  try {
    const result = await pool.query(
      `INSERT INTO friend_requests (requester_user_id, addressee_user_id)
       VALUES ($1, $2)
       RETURNING id, requester_user_id, addressee_user_id, status, created_at`,
      [myId, targetId]
    );

    res.status(201).json(result.rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ message: "Request already sent" });
    console.error("FRIEND REQUEST ERROR:", e);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /friends/requests/incoming
 * Lists pending requests sent to me.
 */
router.get("/friends/requests/incoming", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const meRes = await pool.query("SELECT id FROM users WHERE firebase_uid = $1", [uid]);
  if (meRes.rowCount === 0) return res.status(404).json({ message: "User not found" });
  const myId = meRes.rows[0].id;

  const r = await pool.query(
    `SELECT fr.id,
            fr.requester_user_id,
            u.full_name AS requester_name,
            u.email AS requester_email,
            u.beacon_code AS requester_beacon_code,
            fr.status,
            fr.created_at
     FROM friend_requests fr
     JOIN users u ON u.id = fr.requester_user_id
     WHERE fr.addressee_user_id = $1 AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [myId]
  );

  res.json(r.rows);
});

/**
 * POST /friends/requests/:id/accept
 * Accept a request (must be addressee) and create friendships both directions.
 */
router.post("/friends/requests/:id/accept", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const requestId = Number(req.params.id);

  if (!Number.isFinite(requestId)) return res.status(400).json({ message: "Invalid request id" });

  const client = await pool.connect();
  try {
    const meRes = await client.query("SELECT id FROM users WHERE firebase_uid = $1", [uid]);
    if (meRes.rowCount === 0) return res.status(404).json({ message: "User not found" });
    const myId = meRes.rows[0].id;

    await client.query("BEGIN");

    // Lock request row
    const frRes = await client.query(
      `SELECT id, requester_user_id, addressee_user_id, status
       FROM friend_requests
       WHERE id = $1
       FOR UPDATE`,
      [requestId]
    );

    if (frRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Request not found" });
    }

    const fr = frRes.rows[0];

    if (fr.addressee_user_id !== myId) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Forbidden" });
    }

    if (fr.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Request already ${fr.status}` });
    }

    const requesterId = fr.requester_user_id;
    const addresseeId = fr.addressee_user_id;

    // Mark accepted
    await client.query(
      `UPDATE friend_requests
       SET status = 'accepted', updated_at = NOW()
       WHERE id = $1`,
      [requestId]
    );

    // Friendships both directions (idempotent)
    await client.query(
      `INSERT INTO public.friendships (user_id, friend_user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [requesterId, addresseeId]
    );

    await client.query(
      `INSERT INTO public.friendships (user_id, friend_user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [addresseeId, requesterId]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("ACCEPT FRIEND REQUEST ERROR:", e);
    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

/**
 * POST /friends/requests/:id/reject
 * Reject a request (must be addressee).
 */
router.post("/friends/requests/:id/reject", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const requestId = Number(req.params.id);

  if (!Number.isFinite(requestId)) return res.status(400).json({ message: "Invalid request id" });

  const meRes = await pool.query("SELECT id FROM users WHERE firebase_uid = $1", [uid]);
  if (meRes.rowCount === 0) return res.status(404).json({ message: "User not found" });
  const myId = meRes.rows[0].id;

  const r = await pool.query(
    `UPDATE friend_requests
     SET status = 'rejected', updated_at = NOW()
     WHERE id = $1 AND addressee_user_id = $2 AND status = 'pending'
     RETURNING id`,
    [requestId, myId]
  );

  if (r.rowCount === 0) return res.status(404).json({ message: "Request not found or not pending" });

  res.json({ ok: true });
});

/**
 * DELETE /friends/:id
 * Removes friendship both directions for the current user and target friend.
 */
router.delete("/friends/:id", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const friendId = Number(req.params.id);

  if (!Number.isFinite(friendId)) return res.status(400).json({ message: "Invalid friend id" });

  const meRes = await pool.query("SELECT id FROM users WHERE firebase_uid = $1", [uid]);
  if (meRes.rowCount === 0) return res.status(404).json({ message: "User not found" });
  const myId = meRes.rows[0].id;

  if (myId === friendId) return res.status(400).json({ message: "Cannot remove yourself" });

  const r = await pool.query(
    `DELETE FROM public.friendships
     WHERE (user_id = $1 AND friend_user_id = $2)
        OR (user_id = $2 AND friend_user_id = $1)
     RETURNING user_id, friend_user_id`,
    [myId, friendId]
  );

  if (r.rowCount === 0) return res.status(404).json({ message: "Friendship not found" });

  res.json({ ok: true });
});

/**
 * GET /friends/search?q=...
 * Searches accepted friends for the current user by name, email, phone, or beacon code.
 */
router.get("/friends/search", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const q = String(req.query.q ?? "").trim();

  if (!q) return res.status(400).json({ message: "Missing search query" });

  const meRes = await pool.query("SELECT id FROM users WHERE firebase_uid = $1", [uid]);
  if (meRes.rowCount === 0) return res.status(404).json({ message: "User not found" });
  const myId = meRes.rows[0].id;

  const search = `%${q}%`;
  const r = await pool.query(
    `SELECT u.id,
            u.full_name,
            u.email,
            u.phone_number,
            u.beacon_code
     FROM public.friendships f
     JOIN users u ON u.id = f.friend_user_id
     WHERE f.user_id = $1
       AND (
         u.full_name ILIKE $2
         OR u.email ILIKE $2
         OR u.phone_number ILIKE $2
         OR u.beacon_code ILIKE $2
       )
     ORDER BY u.full_name ASC`,
    [myId, search]
  );

  res.json(r.rows);
});

/**
 * GET /friends
 * Lists accepted friends for the current user.
 */
router.get("/friends", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const meRes = await pool.query("SELECT id FROM users WHERE firebase_uid = $1", [uid]);
  if (meRes.rowCount === 0) return res.status(404).json({ message: "User not found" });
  const myId = meRes.rows[0].id;

  const r = await pool.query(
    `SELECT u.id,
            u.full_name,
            u.email,
            u.phone_number,
            u.beacon_code
     FROM public.friendships f
     JOIN users u ON u.id = f.friend_user_id
     WHERE f.user_id = $1
     ORDER BY u.full_name ASC`,
    [myId]
  );

  res.json(r.rows);
});

export default router;
