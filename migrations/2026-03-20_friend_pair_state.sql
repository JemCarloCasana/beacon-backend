BEGIN;

UPDATE public.friendships
SET
  user_id = LEAST(user_id, friend_user_id),
  friend_user_id = GREATEST(user_id, friend_user_id)
WHERE user_id > friend_user_id;

DELETE FROM public.friendships
WHERE user_id = friend_user_id;

DELETE FROM public.friendships f
USING public.friendships dupe
WHERE f.ctid < dupe.ctid
  AND f.user_id = dupe.user_id
  AND f.friend_user_id = dupe.friend_user_id;

ALTER TABLE public.friendships
  DROP CONSTRAINT IF EXISTS chk_friendships_canonical_pair;

ALTER TABLE public.friendships
  ADD CONSTRAINT chk_friendships_canonical_pair
  CHECK (user_id < friend_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair_unique
ON public.friendships (user_id, friend_user_id);

ALTER TABLE public.friend_requests
  DROP CONSTRAINT IF EXISTS chk_friend_requests_status;

ALTER TABLE public.friend_requests
  DROP CONSTRAINT IF EXISTS friend_requests_status_check;

UPDATE public.friend_requests
SET status = 'cancelled', updated_at = NOW()
WHERE status NOT IN ('pending', 'accepted', 'rejected', 'cancelled');

WITH ranked_pending AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY LEAST(requester_user_id, addressee_user_id),
                        GREATEST(requester_user_id, addressee_user_id)
           ORDER BY created_at DESC, id DESC
         ) AS row_num
  FROM public.friend_requests
  WHERE status = 'pending'
)
UPDATE public.friend_requests fr
SET status = 'cancelled', updated_at = NOW()
FROM ranked_pending rp
WHERE fr.id = rp.id
  AND rp.row_num > 1;

ALTER TABLE public.friend_requests
  ADD CONSTRAINT chk_friend_requests_status
  CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pending_pair_unique
ON public.friend_requests (
  LEAST(requester_user_id, addressee_user_id),
  GREATEST(requester_user_id, addressee_user_id)
)
WHERE status = 'pending';

COMMIT;
