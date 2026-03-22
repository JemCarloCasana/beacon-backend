BEGIN;

ALTER TABLE public.friendships
  DROP CONSTRAINT IF EXISTS chk_friendships_canonical_pair;

LOCK TABLE public.friendships IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE tmp_friendships_canonical AS
SELECT DISTINCT
  LEAST(user_id, friend_user_id) AS user_id,
  GREATEST(user_id, friend_user_id) AS friend_user_id
FROM public.friendships
WHERE user_id <> friend_user_id;

DELETE FROM public.friendships;

INSERT INTO public.friendships (user_id, friend_user_id)
SELECT user_id, friend_user_id
FROM tmp_friendships_canonical
ORDER BY user_id, friend_user_id
ON CONFLICT (user_id, friend_user_id) DO NOTHING;

ALTER TABLE public.friendships
  ADD CONSTRAINT chk_friendships_canonical_pair
  CHECK (user_id < friend_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair_unique
ON public.friendships (user_id, friend_user_id);

COMMIT;
