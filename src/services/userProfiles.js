import { Counter } from "../models/Counter.js";
import { UserProfile, Friendship, FriendRequest } from "../models/Remaining.js";
import { chooseBootstrapFullName } from "../utils/userNameFallbacks.js";

const BEACON_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateBeaconCode() {
  let code = "BCN-";
  for (let index = 0; index < 6; index += 1) {
    code += BEACON_CHARS[Math.floor(Math.random() * BEACON_CHARS.length)];
  }
  return code;
}

function profileToDto(profile) {
  if (!profile) return null;
  return {
    id: Number(profile.public_id),
    firebase_uid: profile.firebase_uid,
    email: profile.email,
    full_name: profile.full_name,
    phone_number: profile.phone_number ?? null,
    role: profile.role,
    profile_image_url: profile.profile_image_url ?? null,
  };
}

function normalizeEmail(email, uid) {
  const value = typeof email === "string" ? email.trim().toLowerCase() : "";
  return value.slice(0, 320) || `${uid}@firebase.local`;
}

async function insertProfile(fields) {
  const publicId = await Counter.nextPublicId("users");
  const profile = await UserProfile.create({
    public_id: publicId,
    firebase_uid: fields.firebase_uid,
    email: fields.email,
    full_name: fields.full_name,
    phone_number: fields.phone_number ?? null,
    role: fields.role ?? "citizen",
    status: fields.status ?? "active",
    beacon_code: fields.beacon_code ?? generateBeaconCode(),
    profile_image_url: fields.profile_image_url ?? null,
    created_at: fields.created_at ?? new Date(),
    updated_at: fields.updated_at ?? new Date(),
  });
  return profile;
}

export async function upsertProfileFromToken(decoded) {
  const uid = decoded.uid;
  const existing = await UserProfile.findOne({ firebase_uid: uid });
  const fullName = chooseBootstrapFullName({
    tokenName: decoded.name,
    existingName: existing?.full_name ?? null,
    email: decoded.email,
  });
  const email = normalizeEmail(decoded.email, uid);

  if (existing) {
    existing.email = email;
    if (!existing.full_name || /^User\s+\d+$/.test(existing.full_name)) {
      existing.full_name = fullName;
    }
    if (!existing.beacon_code) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        existing.beacon_code = generateBeaconCode();
        try {
          await existing.save();
          return existing;
        } catch (error) {
          if (error?.code !== 11000) throw error;
        }
      }
      throw new Error("Unable to generate unique beacon code after retries");
    }
    await existing.save();
    return existing;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await insertProfile({
        firebase_uid: uid,
        email,
        full_name: fullName,
      });
    } catch (error) {
      if (error?.code === 11000) {
        const concurrent = await UserProfile.findOne({ firebase_uid: uid });
        if (concurrent) return concurrent;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unable to generate unique beacon code after retries");
}

export async function bootstrapProfile({ uid, email, fullName, phoneNumber, role }) {
  const existing = await UserProfile.findOne({ firebase_uid: uid });
  if (existing) {
    existing.email = normalizeEmail(email, uid);
    existing.full_name = fullName;
    existing.phone_number = phoneNumber ?? null;
    existing.role = role;
    existing.updated_at = new Date();
    if (!existing.beacon_code) existing.beacon_code = generateBeaconCode();
    await existing.save();
    return existing;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await insertProfile({
        firebase_uid: uid,
        email: normalizeEmail(email, uid),
        full_name: fullName,
        phone_number: phoneNumber,
        role,
      });
    } catch (error) {
      if (error?.code === 11000) {
        const concurrent = await UserProfile.findOne({ firebase_uid: uid });
        if (concurrent) return bootstrapProfile({ uid, email, fullName, phoneNumber, role });
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unable to generate unique beacon code after retries");
}

export async function findProfileByUid(uid) {
  return UserProfile.findOne({ firebase_uid: uid });
}

export async function findProfileByPublicId(publicId) {
  return UserProfile.findOne({ public_id: publicId });
}

export async function searchProfiles({ uid, query, limit = 20 }) {
  const me = await UserProfile.findOne({ firebase_uid: uid }).lean();
  if (!me) return null;
  const tokens = query.toLowerCase().split(" ").filter(Boolean);
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const candidates = await UserProfile.find({
    public_id: { $ne: me.public_id },
    $and: escaped.map((token) => ({ full_name: new RegExp(token, "i") })),
  }).select({ public_id: 1, full_name: 1, beacon_code: 1 }).limit(limit).lean();

  const ids = candidates.map((candidate) => Number(candidate.public_id));
  const [friendships, requests] = await Promise.all([
    Friendship.find({ $or: [{ user_id: me.public_id, friend_user_id: { $in: ids } }, { friend_user_id: me.public_id, user_id: { $in: ids } }] }).lean(),
    FriendRequest.find({ status: "pending", $or: [{ requester_user_id: me.public_id, addressee_user_id: { $in: ids } }, { addressee_user_id: me.public_id, requester_user_id: { $in: ids } }] }).lean(),
  ]);

  const result = candidates.map((candidate) => {
    const id = Number(candidate.public_id);
    const friend = friendships.some((row) => Number(row.user_id) === id || Number(row.friend_user_id) === id);
    const incoming = requests.some((row) => Number(row.requester_user_id) === id);
    const outgoing = requests.some((row) => Number(row.addressee_user_id) === id);
    return {
      id,
      full_name: candidate.full_name,
      beacon_code: candidate.beacon_code,
      friendship_status: friend ? "already_friends" : incoming ? "incoming_pending" : outgoing ? "outgoing_pending" : "none",
    };
  });
  return result.sort((left, right) => left.full_name.localeCompare(right.full_name)).slice(0, limit);
}

export { profileToDto };
