export const FRIEND_PAIR_STATE = Object.freeze({
  NONE: "NONE",
  PENDING: "PENDING",
  FRIENDS: "FRIENDS",
});

export function normalizeFriendPair(userAId, userBId) {
  const a = Number(userAId);
  const b = Number(userBId);
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new Error("Friend pair IDs must be integers");
  }
  return a < b ? [a, b] : [b, a];
}

export async function lockFriendPair(client, userAId, userBId) {
  const [lowUserId, highUserId] = normalizeFriendPair(userAId, userBId);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))",
    [lowUserId, highUserId]
  );
  return { lowUserId, highUserId };
}

export async function getFriendPairState(client, userAId, userBId) {
  const [lowUserId, highUserId] = normalizeFriendPair(userAId, userBId);

  const friendshipRes = await client.query(
    `SELECT user_id, friend_user_id
     FROM public.friendships
     WHERE user_id = $1 AND friend_user_id = $2
     LIMIT 1`,
    [lowUserId, highUserId]
  );
  if (friendshipRes.rowCount > 0) {
    return {
      state: FRIEND_PAIR_STATE.FRIENDS,
      friendship: friendshipRes.rows[0],
      pendingRequest: null,
      lowUserId,
      highUserId,
    };
  }

  const pendingRes = await client.query(
    `SELECT id,
            requester_user_id,
            addressee_user_id,
            status,
            created_at,
            updated_at
     FROM public.friend_requests
     WHERE LEAST(requester_user_id, addressee_user_id) = $1
       AND GREATEST(requester_user_id, addressee_user_id) = $2
       AND status = 'pending'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [lowUserId, highUserId]
  );
  if (pendingRes.rowCount > 0) {
    return {
      state: FRIEND_PAIR_STATE.PENDING,
      friendship: null,
      pendingRequest: pendingRes.rows[0],
      lowUserId,
      highUserId,
    };
  }

  return {
    state: FRIEND_PAIR_STATE.NONE,
    friendship: null,
    pendingRequest: null,
    lowUserId,
    highUserId,
  };
}

export async function findUserIdByFirebaseUid(db, firebaseUid) {
  const userRes = await db.query("SELECT id FROM users WHERE firebase_uid = $1", [firebaseUid]);
  if (userRes.rowCount === 0) {
    return null;
  }
  return Number(userRes.rows[0].id);
}
