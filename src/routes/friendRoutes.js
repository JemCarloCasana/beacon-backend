import express from "express";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { mongoose } from "../mongo.js";
import { Counter } from "../models/Counter.js";
import { FriendRequest, Friendship, UserProfile } from "../models/Remaining.js";
import { findProfileByUid } from "../services/userProfiles.js";

const router = express.Router();
const FRIEND_PAIR_STATE = { NONE: "NONE", PENDING: "PENDING", FRIENDS: "FRIENDS" };

async function mongoUserId(uid) {
  const profile = await findProfileByUid(uid);
  return profile ? Number(profile.public_id) : null;
}

async function mongoPairState(userAId, userBId, session) {
  const [low, high] = [Number(userAId), Number(userBId)].sort((a, b) => a - b);
  const friendshipQuery = Friendship.findOne({ user_id: low, friend_user_id: high });
  if (session) friendshipQuery.session(session);
  const friendship = await friendshipQuery.lean();
  if (friendship) return { state: FRIEND_PAIR_STATE.FRIENDS, friendship, pendingRequest: null, lowUserId: low, highUserId: high };
  const pendingQuery = FriendRequest.findOne({
    status: "pending",
    $or: [{ requester_user_id: low, addressee_user_id: high }, { requester_user_id: high, addressee_user_id: low }],
  }).sort({ created_at: -1, public_id: -1 });
  if (session) pendingQuery.session(session);
  const pendingRequest = await pendingQuery.lean();
  return { state: pendingRequest ? FRIEND_PAIR_STATE.PENDING : FRIEND_PAIR_STATE.NONE, friendship: null, pendingRequest, lowUserId: low, highUserId: high };
}

async function createMongoFriendRequest(res, currentUserId, targetId) {
  if (currentUserId === targetId) return res.status(400).json({ message: "Cannot add yourself" });
  const pairState = await mongoPairState(currentUserId, targetId);
  if (pairState.state === FRIEND_PAIR_STATE.FRIENDS) return res.status(409).json({ message: "Already friends", code: "ALREADY_FRIENDS" });
  if (pairState.state === FRIEND_PAIR_STATE.PENDING) return res.status(409).json({ message: "Open friend request already exists", code: "FRIEND_REQUEST_PENDING" });
  try {
    const request = await FriendRequest.create({
      public_id: await Counter.nextPublicId("friend_requests"), requester_user_id: currentUserId,
      addressee_user_id: targetId, status: "pending",
    });
    return res.status(201).json({ id: request.public_id, requester_user_id: request.requester_user_id, addressee_user_id: request.addressee_user_id, status: request.status, created_at: request.created_at });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: "Open friend request already exists", code: "FRIEND_REQUEST_PENDING" });
    throw error;
  }
}

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

  const myId = await mongoUserId(uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });
  const target = await UserProfile.findOne({ beacon_code: code }).select({ public_id: 1 }).lean();
  if (!target) return res.status(404).json({ message: "User not found" });
  return createMongoFriendRequest(res, myId, Number(target.public_id));
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

  const myId = await mongoUserId(uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });
  const target = await UserProfile.findOne({ public_id: targetId }).select({ public_id: 1 }).lean();
  if (!target) return res.status(404).json({ message: "User not found" });
  return createMongoFriendRequest(res, myId, targetId);
});

/**
 * GET /friends/requests/incoming
 * Lists pending requests sent to me.
 */
router.get("/friends/requests/incoming", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const myId = await mongoUserId(uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });
  const requests = await FriendRequest.find({ addressee_user_id: myId, status: "pending" }).sort({ created_at: -1 }).lean();
  const requesterIds = requests.map((request) => request.requester_user_id);
  const users = await UserProfile.find({ public_id: { $in: requesterIds } }).select({ public_id: 1, full_name: 1, beacon_code: 1 }).lean();
  const byId = new Map(users.map((user) => [Number(user.public_id), user]));
  return res.json(requests.map((request) => ({
    id: request.public_id, requester_user_id: request.requester_user_id, addressee_user_id: request.addressee_user_id,
    requester_name: byId.get(Number(request.requester_user_id))?.full_name ?? null,
    requester_beacon_code: byId.get(Number(request.requester_user_id))?.beacon_code ?? null,
    status: request.status, created_at: request.created_at,
  })));
});

/**
 * POST /friends/requests/:id/accept
 * Accept a request (must be addressee) and create friendships both directions.
 */
router.post("/friends/requests/:id/accept", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const requestId = Number(req.params.id);

  if (!Number.isFinite(requestId)) return res.status(400).json({ message: "Invalid request id" });

  const myId = await mongoUserId(uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });
  const request = await FriendRequest.findOne({ public_id: requestId }).lean();
  if (!request) return res.status(404).json({ message: "Request not found" });
  if (Number(request.addressee_user_id) !== myId) return res.status(403).json({ message: "Forbidden" });
  if (request.status !== "pending") return res.status(409).json({ message: "Friend request is no longer pending", code: "STALE_FRIEND_REQUEST", status: request.status });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await FriendRequest.findOne({ public_id: requestId, status: "pending" }).session(session).lean();
      if (!current) throw Object.assign(new Error("Stale friend request"), { code: "STALE_FRIEND_REQUEST" });
      const pairState = await mongoPairState(current.requester_user_id, current.addressee_user_id, session);
      if (pairState.state !== FRIEND_PAIR_STATE.PENDING || Number(pairState.pendingRequest?.public_id) !== requestId) {
        throw Object.assign(new Error("Stale friend request"), { code: "STALE_FRIEND_REQUEST" });
      }
      const now = new Date();
      await Friendship.create([{ user_id: pairState.lowUserId, friend_user_id: pairState.highUserId, created_at: now }], { session });
      const updated = await FriendRequest.updateOne(
        { _id: current._id, status: "pending" }, { $set: { status: "accepted", updated_at: now } }, { session }
      );
      if (updated.modifiedCount !== 1) throw Object.assign(new Error("Stale friend request"), { code: "STALE_FRIEND_REQUEST" });
    });
    return res.json({ ok: true });
  } catch (error) {
    if (error?.code === 11000 || error?.code === "STALE_FRIEND_REQUEST") return res.status(409).json({ message: "Friend request is stale or invalid", code: "STALE_FRIEND_REQUEST" });
    console.error("ACCEPT FRIEND REQUEST ERROR:", error);
    return res.status(500).json({ message: "Server error" });
  } finally {
    await session.endSession();
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

  const myId = await mongoUserId(uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });
  const request = await FriendRequest.findOneAndUpdate(
    { public_id: requestId, addressee_user_id: myId, status: "pending" },
    { $set: { status: "declined", updated_at: new Date() } },
    { returnDocument: "after" }
  ).lean();
  if (!request) return res.status(404).json({ message: "Request not found or not pending" });
  return res.json({ ok: true });
});

/**
 * DELETE /friends/:id
 * Removes friendship both directions for the current user and target friend.
 */
router.delete("/friends/:id", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;
  const friendId = Number(req.params.id);

  if (!Number.isFinite(friendId)) return res.status(400).json({ message: "Invalid friend id" });

  const myId = await mongoUserId(uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });
  if (myId === friendId) return res.status(400).json({ message: "Cannot remove yourself" });
  const [lowUserId, highUserId] = [myId, friendId].sort((a, b) => a - b);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Friendship.deleteOne({ user_id: lowUserId, friend_user_id: highUserId }, { session });
      await FriendRequest.updateMany({
        status: "pending",
        $or: [{ requester_user_id: lowUserId, addressee_user_id: highUserId }, { requester_user_id: highUserId, addressee_user_id: lowUserId }],
      }, { $set: { status: "cancelled", updated_at: new Date() } }, { session });
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error("UNFRIEND ERROR:", error);
    return res.status(500).json({ message: "Server error" });
  } finally {
    await session.endSession();
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

  const myId = await mongoUserId(uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });
  const pairs = await Friendship.find({ $or: [{ user_id: myId }, { friend_user_id: myId }] }).lean();
  const friendIds = pairs.map((pair) => Number(pair.user_id) === myId ? pair.friend_user_id : pair.user_id);
  const expression = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const users = await UserProfile.find({ public_id: { $in: friendIds }, $or: [{ full_name: expression }, { email: expression }, { phone_number: expression }, { beacon_code: expression }] }).lean();
  return res.json(users.sort((a, b) => a.full_name.localeCompare(b.full_name)).map((user) => ({ id: user.public_id, full_name: user.full_name, email: user.email, phone_number: user.phone_number, beacon_code: user.beacon_code })));
});

/**
 * GET /friends
 * Lists accepted friends for the current user.
 */
router.get("/friends", requireAppAuth, async (req, res) => {
  const { uid } = req.auth;

  const myId = await mongoUserId(uid);
  if (myId == null) return res.status(404).json({ message: "User not found" });
  const pairs = await Friendship.find({ $or: [{ user_id: myId }, { friend_user_id: myId }] }).lean();
  const friendIds = pairs.map((pair) => Number(pair.user_id) === myId ? pair.friend_user_id : pair.user_id);
  const users = await UserProfile.find({ public_id: { $in: friendIds } }).lean();
  return res.json(users.sort((a, b) => a.full_name.localeCompare(b.full_name)).map((user) => ({ id: user.public_id, full_name: user.full_name, email: user.email, phone_number: user.phone_number, beacon_code: user.beacon_code })));
});

export default router;
