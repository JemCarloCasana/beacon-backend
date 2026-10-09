import { ReducedUserProfile as UserProfile, FriendConnection } from "../models/Reduced.js";
import { chooseBootstrapFullName } from "../utils/userNameFallbacks.js";
import { getServiceAreaError } from "../utils/serviceArea.js";

const BEACON_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function assertProfileActive(profile) {
  if (profile?.status === "deactivated") {
    throw Object.assign(new Error("Account is deactivated"), { statusCode: 403, code: "ACCOUNT_DEACTIVATED" });
  }
}

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
    id: profile._id.toString(),
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
  const profile = await UserProfile.create({
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

export async function refreshProfileFromToken(decoded) {
  const uid = decoded.uid;
  const existing = await UserProfile.findOne({ firebase_uid: uid });
  if (!existing) return null;
  assertProfileActive(existing);
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

}

export async function bootstrapProfile({ uid, email, fullName, phoneNumber, role, latitude, longitude }) {
  const existing = await UserProfile.findOne({ firebase_uid: uid });
  if (existing) {
    assertProfileActive(existing);
    existing.email = normalizeEmail(email, uid);
    existing.full_name = fullName;
    existing.phone_number = phoneNumber ?? null;
    existing.role = role;
    existing.updated_at = new Date();
    if (!existing.beacon_code) existing.beacon_code = generateBeaconCode();
    await existing.save();
    return existing;
  }

  const locationError = getServiceAreaError(latitude, longitude);
  if (locationError) throw locationError;

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
        if (concurrent) return bootstrapProfile({ uid, email, fullName, phoneNumber, role, latitude, longitude });
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

export async function findProfileById(id) {
  return UserProfile.findById(id);
}

export async function searchProfiles({ uid, query, limit = 20 }) {
  const me = await UserProfile.findOne({ firebase_uid: uid }).lean();
  if (!me) return null;
  const tokens = query.toLowerCase().split(" ").filter(Boolean);
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const candidates = await UserProfile.find({
    _id: { $ne: me._id },
    $and: escaped.map((token) => ({ full_name: new RegExp(token, "i") })),
  }).select({ _id: 1, full_name: 1, beacon_code: 1 }).limit(limit).lean();

  const ids = candidates.map((candidate) => candidate._id);
  const [friendships, requests] = await Promise.all([
    FriendConnection.find({ record_type: "friendship", user_ids: { $all: [me._id], $in: ids } }).lean(),
    FriendConnection.find({ record_type: "request", status: "pending", user_ids: { $all: [me._id], $in: ids } }).lean(),
  ]);

  const result = candidates.map((candidate) => {
    const id = candidate._id.toString();
    const friend = friendships.some((row) => row.user_ids.some((value) => value.equals(candidate._id)));
    const incoming = requests.some((row) => row.requested_by.equals(candidate._id));
    const outgoing = requests.some((row) => row.recipient.equals(candidate._id));
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
