BEGIN;

WITH active_friendship_pairs AS (
  SELECT user_id AS low_user_id, friend_user_id AS high_user_id
  FROM public.friendships
),
accepted_request_pairs AS (
  SELECT DISTINCT
    LEAST(requester_user_id, addressee_user_id) AS low_user_id,
    GREATEST(requester_user_id, addressee_user_id) AS high_user_id
  FROM public.friend_requests
  WHERE status = 'accepted'
)
UPDATE public.friend_requests fr
SET status = 'cancelled',
    updated_at = NOW()
WHERE fr.status = 'pending'
  AND (
    EXISTS (
      SELECT 1
      FROM active_friendship_pairs afp
      WHERE afp.low_user_id = LEAST(fr.requester_user_id, fr.addressee_user_id)
        AND afp.high_user_id = GREATEST(fr.requester_user_id, fr.addressee_user_id)
    )
    OR EXISTS (
      SELECT 1
      FROM accepted_request_pairs arp
      WHERE arp.low_user_id = LEAST(fr.requester_user_id, fr.addressee_user_id)
        AND arp.high_user_id = GREATEST(fr.requester_user_id, fr.addressee_user_id)
        AND NOT EXISTS (
          SELECT 1
          FROM active_friendship_pairs afp
          WHERE afp.low_user_id = arp.low_user_id
            AND afp.high_user_id = arp.high_user_id
        )
    )
  );

COMMIT;
