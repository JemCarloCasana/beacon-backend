import express from "express";
import { pool } from "../db.js";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import {
  findUserIdByFirebaseUid,
  FRIEND_PAIR_STATE,
  getFriendPairState,
  lockFriendPair,
} from "../services/friendships.js";

const router = express.Router();

function normalizeBeaconCode(code) {
  return String(code).trim().toUpperCase();
}

async function createFriendRequestForTargetId(res, currentUserId, targetId) {
  if (currentUserId === targetId) {
    return res.status(400).json({ message: "Cannot add yourself" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockFriendPair(client, currentUserId, targetId);

    const pairState = await getFriendPairState(client, currentUserId, targetId);
    if (pairState.state === FRIEND_PAIR_STATE.FRIENDS) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Already friends", code: "ALREADY_FRIENDS" });
    }
    if (pairState.state === FRIEND_PAIR_STATE.PENDING) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "Open friend request already exists",
        code: "FRIEND_REQUEST_PENDING",
      });
    }

    const result = await client.query(
      `INSERT INTO friend_requests (requester_user_id, addressee_user_id)
       VALUES ($1, $2)
       RETURNING id, requester_user_id, addressee_user_id, status, created_at`,
      [currentUserId, targetId]
    );

    await client.query("COMMIT");
    return res.status(201).json(result.rows[0]);
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    if (e.code === "23505" && e.constraint === "idx_friend_requests_pending_pair_unique") {
      return res.status(409).json({
        message: "Open friend request already exists",
        code: "FRIEND_REQUEST_PENDING",
      });
    }
    console.error("FRIEND REQUEST ERROR:", e);
    return res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
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

  const myId = await findUserIdByFirebaseUid(pool, uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });

  // Find target user
  const targetRes = await pool.query("SELECT id FROM users WHERE beacon_code = $1", [code]);
  if (targetRes.rowCount === 0) return res.status(404).json({ message: "User not found" });
  const targetId = Number(targetRes.rows[0].id);

  return createFriendRequestForTargetId(res, myId, targetId);
});

/**
 * POST /friends/request/by-user
 * Body: { user_id }
 */
router.post("/friends/request/by-user", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const { user_id } = req.body ?? {};
  const targetId = Number(user_id);

  if (!Number.isInteger(targetId) || targetId < 1) {
    return res.status(400).json({ message: "Invalid user_id" });
  }

  const myId = await findUserIdByFirebaseUid(pool, uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });

  const targetRes = await pool.query("SELECT id FROM users WHERE id = $1", [targetId]);
  if (targetRes.rowCount === 0) return res.status(404).json({ message: "User not found" });

  return createFriendRequestForTargetId(res, myId, targetId);
});

/**
 * GET /friends/requests/incoming
 * Lists pending requests sent to me.
 */
router.get("/friends/requests/incoming", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const myId = await findUserIdByFirebaseUid(pool, uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });

  const r = await pool.query(
    `SELECT fr.id,
            fr.requester_user_id,
            fr.addressee_user_id,
            u.full_name AS requester_name,
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
    const myId = Number(meRes.rows[0].id);

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
      return res.status(409).json({
        message: "Friend request is no longer pending",
        code: "STALE_FRIEND_REQUEST",
        status: fr.status,
      });
    }

    const requesterId = Number(fr.requester_user_id);
    const addresseeId = Number(fr.addressee_user_id);
    const { lowUserId, highUserId } = await lockFriendPair(client, requesterId, addresseeId);

    const pairState = await getFriendPairState(client, requesterId, addresseeId);
    if (pairState.state === FRIEND_PAIR_STATE.FRIENDS) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "Friend request is stale or invalid",
        code: "STALE_FRIEND_REQUEST",
      });
    }
    if (pairState.state !== FRIEND_PAIR_STATE.PENDING || pairState.pendingRequest?.id !== requestId) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "Friend request is stale or invalid",
        code: "STALE_FRIEND_REQUEST",
      });
    }

    const insertFriendship = await client.query(
      `INSERT INTO public.friendships (user_id, friend_user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [lowUserId, highUserId]
    );

    if (insertFriendship.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: "Friend request is stale or invalid",
        code: "STALE_FRIEND_REQUEST",
      });
    }

    await client.query(
      `UPDATE friend_requests
       SET status = 'accepted', updated_at = NOW()
       WHERE id = $1`,
      [requestId]
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

  const myId = await findUserIdByFirebaseUid(pool, uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });

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

  const myId = await findUserIdByFirebaseUid(pool, uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });

  if (myId === friendId) return res.status(400).json({ message: "Cannot remove yourself" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { lowUserId, highUserId } = await lockFriendPair(client, myId, friendId);

    await client.query(
      `DELETE FROM public.friendships
       WHERE user_id = $1 AND friend_user_id = $2`,
      [lowUserId, highUserId]
    );

    await client.query(
      `UPDATE public.friend_requests
       SET status = 'cancelled', updated_at = NOW()
       WHERE LEAST(requester_user_id, addressee_user_id) = $1
         AND GREATEST(requester_user_id, addressee_user_id) = $2
         AND status = 'pending'`,
      [lowUserId, highUserId]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("UNFRIEND ERROR:", e);
    res.status(500).json({ message: "Server error" });
  } finally {
    client.release();
  }
});

/**
 * GET /friends/search?q=...
 * Searches accepted friends for the current user by name, email, phone, or beacon code.
 */
router.get("/friends/search", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const q = String(req.query.q ?? "").trim();

  if (!q) return res.status(400).json({ message: "Missing search query" });

  const myId = await findUserIdByFirebaseUid(pool, uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });

  const search = `%${q}%`;
  const r = await pool.query(
    `SELECT u.id,
            u.full_name,
            u.email,
            u.phone_number,
            u.beacon_code
     FROM public.friendships f
     JOIN users u
       ON u.id = CASE
         WHEN f.user_id = $1 THEN f.friend_user_id
         ELSE f.user_id
       END
     WHERE $1 IN (f.user_id, f.friend_user_id)
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

  const myId = await findUserIdByFirebaseUid(pool, uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });

  const r = await pool.query(
    `SELECT u.id,
            u.full_name,
            u.email,
            u.phone_number,
            u.beacon_code
     FROM public.friendships f
     JOIN users u
       ON u.id = CASE
         WHEN f.user_id = $1 THEN f.friend_user_id
         ELSE f.user_id
       END
     WHERE $1 IN (f.user_id, f.friend_user_id)
     ORDER BY u.full_name ASC`,
    [myId]
  );

  res.json(r.rows);
});

export default router;
