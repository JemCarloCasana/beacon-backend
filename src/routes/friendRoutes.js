import express from "express";
import { requireAppAuth } from "../middleware/requireAppAuth.js";
import { mongoose } from "../mongo.js";
import { FriendConnection, ReducedUserProfile as UserProfile } from "../models/Reduced.js";
import { findProfileByUid } from "../services/userProfiles.js";
import { parseObjectId } from "../utils/objectId.js";

const router = express.Router();
const FRIEND_PAIR_STATE = { NONE: "NONE", PENDING: "PENDING", FRIENDS: "FRIENDS" };
const byId = (a, b) => a.toString().localeCompare(b.toString());

async function mongoUserId(uid) {
  return (await findProfileByUid(uid))?._id ?? null;
}

async function mongoPairState(userAId, userBId, session) {
  const [low, high] = [userAId, userBId].sort(byId);
  const options = session ? { session } : {};
  const friendship = await FriendConnection.findOne({ record_type: "friendship", user_ids: { $all: [low, high] } }, null, options).lean();
  if (friendship) return { state: FRIEND_PAIR_STATE.FRIENDS, friendship, pendingRequest: null, lowUserId: low, highUserId: high };
  const pendingRequest = await FriendConnection.findOne({ record_type: "request", status: "pending", user_ids: { $all: [low, high] } }, null, options).sort({ created_at: -1, _id: -1 }).lean();
  return { state: pendingRequest ? FRIEND_PAIR_STATE.PENDING : FRIEND_PAIR_STATE.NONE, friendship: null, pendingRequest, lowUserId: low, highUserId: high };
}

async function createMongoFriendRequest(res, currentUserId, targetId) {
  if (currentUserId.equals(targetId)) return res.status(400).json({ message: "Cannot add yourself" });
  const pairState = await mongoPairState(currentUserId, targetId);
  if (pairState.state === FRIEND_PAIR_STATE.FRIENDS) return res.status(409).json({ message: "Already friends", code: "ALREADY_FRIENDS" });
  if (pairState.state === FRIEND_PAIR_STATE.PENDING) return res.status(409).json({ message: "Open friend request already exists", code: "FRIEND_REQUEST_PENDING" });
  try {
    const request = await FriendConnection.create({
      record_type: "request", user_ids: [pairState.lowUserId, pairState.highUserId],
      requested_by: currentUserId, recipient: targetId, status: "pending",
    });
    return res.status(201).json({ id: request._id.toString(), requester_user_id: currentUserId.toString(), addressee_user_id: targetId.toString(), status: request.status, created_at: request.created_at });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ message: "Open friend request already exists", code: "FRIEND_REQUEST_PENDING" });
    throw error;
  }
}

const normalizeBeaconCode = (code) => String(code).trim().toUpperCase();

router.post("/friends/request", requireAppAuth, async (req, res) => {
  if (!req.body?.beacon_code || typeof req.body.beacon_code !== "string") return res.status(400).json({ message: "Invalid beacon_code" });
  const myId = await mongoUserId(req.auth.uid);
  if (!myId) return res.status(404).json({ message: "User not found" });
  const target = await UserProfile.findOne({ beacon_code: normalizeBeaconCode(req.body.beacon_code) }).select({ _id: 1 }).lean();
  if (!target) return res.status(404).json({ message: "User not found" });
  return createMongoFriendRequest(res, myId, target._id);
});

router.post("/friends/request/by-user", requireAppAuth, async (req, res) => {
  const targetId = parseObjectId(req.body?.user_id);
  if (!targetId) return res.status(400).json({ message: "Invalid user_id" });
  const myId = await mongoUserId(req.auth.uid);
  if (!myId) return res.status(404).json({ message: "User not found" });
  const target = await UserProfile.findById(targetId).select({ _id: 1 }).lean();
  if (!target) return res.status(404).json({ message: "User not found" });
  return createMongoFriendRequest(res, myId, targetId);
});

router.get("/friends/requests/incoming", requireAppAuth, async (req, res) => {
  const myId = await mongoUserId(req.auth.uid);
  if (!myId) return res.status(404).json({ message: "User not found" });
  const requests = await FriendConnection.find({ record_type: "request", recipient: myId, status: "pending" }).sort({ created_at: -1 }).lean();
  const requesterIds = requests.map((request) => request.requested_by);
  const users = await UserProfile.find({ _id: { $in: requesterIds } }).select({ _id: 1, full_name: 1, beacon_code: 1 }).lean();
  const byUserId = new Map(users.map((user) => [user._id.toString(), user]));
  return res.json(requests.map((request) => ({
    id: request._id.toString(), requester_user_id: request.requested_by.toString(), addressee_user_id: request.recipient.toString(),
    requester_name: byUserId.get(request.requested_by.toString())?.full_name ?? null,
    requester_beacon_code: byUserId.get(request.requested_by.toString())?.beacon_code ?? null,
    status: request.status, created_at: request.created_at,
  })));
});

router.post("/friends/requests/:id/accept", requireAppAuth, async (req, res) => {
  const requestId = parseObjectId(req.params.id);
  if (!requestId) return res.status(400).json({ message: "Invalid request id" });
  const myId = await mongoUserId(req.auth.uid);
  if (!myId) return res.status(404).json({ message: "User not found" });
  const request = await FriendConnection.findOne({ _id: requestId, record_type: "request" }).lean();
  if (!request) return res.status(404).json({ message: "Request not found" });
  if (!request.recipient.equals(myId)) return res.status(403).json({ message: "Forbidden" });
  if (request.status !== "pending") return res.status(409).json({ message: "Friend request is no longer pending", code: "STALE_FRIEND_REQUEST", status: request.status });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await FriendConnection.findOne({ _id: requestId, record_type: "request", status: "pending" }).session(session).lean();
      if (!current) throw Object.assign(new Error("Stale friend request"), { code: "STALE_FRIEND_REQUEST" });
      const pairState = await mongoPairState(current.requested_by, current.recipient, session);
      if (pairState.state !== FRIEND_PAIR_STATE.PENDING || !pairState.pendingRequest._id.equals(requestId)) throw Object.assign(new Error("Stale friend request"), { code: "STALE_FRIEND_REQUEST" });
      const now = new Date();
      await FriendConnection.updateOne({ _id: requestId, status: "pending" }, { $set: { status: "accepted", accepted_at: now, updated_at: now } }, { session });
      await FriendConnection.create([{ record_type: "friendship", user_ids: [pairState.lowUserId, pairState.highUserId], created_at: now }], { session });
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

router.post("/friends/requests/:id/reject", requireAppAuth, async (req, res) => {
  const requestId = parseObjectId(req.params.id);
  if (!requestId) return res.status(400).json({ message: "Invalid request id" });
  const myId = await mongoUserId(req.auth.uid);
  if (!myId) return res.status(404).json({ message: "User not found" });
  const request = await FriendConnection.findOneAndUpdate(
    { _id: requestId, record_type: "request", recipient: myId, status: "pending" },
    { $set: { status: "declined", updated_at: new Date() } }, { returnDocument: "after" }
  ).lean();
  if (!request) return res.status(404).json({ message: "Request not found or not pending" });
  return res.json({ ok: true });
});

router.delete("/friends/:id", requireAppAuth, async (req, res) => {
  const friendId = parseObjectId(req.params.id);
  if (!friendId) return res.status(400).json({ message: "Invalid friend id" });
  const myId = await mongoUserId(req.auth.uid);
  if (!myId) return res.status(404).json({ message: "User not found" });
  if (myId.equals(friendId)) return res.status(400).json({ message: "Cannot remove yourself" });
  const userIds = [myId, friendId].sort(byId);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await FriendConnection.deleteOne({ record_type: "friendship", user_ids: { $all: userIds } }, { session });
      await FriendConnection.updateMany({ record_type: "request", status: "pending", user_ids: { $all: userIds } }, { $set: { status: "cancelled", updated_at: new Date() } }, { session });
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error("UNFRIEND ERROR:", error);
    return res.status(500).json({ message: "Server error" });
  } finally {
    await session.endSession();
  }
});

async function friendUsers(myId, filter) {
  const pairs = await FriendConnection.find({ record_type: "friendship", user_ids: myId }).lean();
  const friendIds = pairs.flatMap((pair) => pair.user_ids.filter((id) => !id.equals(myId)));
  if (!friendIds.length) return [];
  return UserProfile.find({ _id: { $in: friendIds }, ...filter }).lean();
}

const userDto = (user) => ({ id: user._id.toString(), full_name: user.full_name, email: user.email, phone_number: user.phone_number, beacon_code: user.beacon_code });

router.get("/friends/search", requireAppAuth, async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  if (!query) return res.status(400).json({ message: "Missing search query" });
  const myId = await mongoUserId(req.auth.uid);
  if (!myId) return res.status(404).json({ message: "User not found" });
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const users = await friendUsers(myId, { $or: [{ full_name: expression }, { email: expression }, { phone_number: expression }, { beacon_code: expression }] });
  return res.json(users.sort((a, b) => a.full_name.localeCompare(b.full_name)).map(userDto));
});

router.get("/friends", requireAppAuth, async (req, res) => {
  const myId = await mongoUserId(req.auth.uid);
  if (!myId) return res.status(404).json({ message: "User not found" });
  const users = await friendUsers(myId, {});
  return res.json(users.sort((a, b) => a.full_name.localeCompare(b.full_name)).map(userDto));
});

export default router;
