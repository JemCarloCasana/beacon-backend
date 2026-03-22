BEGIN;

DO $$
DECLARE
  record_item record;
BEGIN
  FOR record_item IN
    SELECT con.conname AS object_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'friend_requests'
      AND con.contype = 'u'
      AND pg_get_constraintdef(con.oid) ILIKE '%(requester_user_id, addressee_user_id)%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.friend_requests DROP CONSTRAINT IF EXISTS %I',
      record_item.object_name
    );
  END LOOP;

  FOR record_item IN
    SELECT idx.indexname AS object_name
    FROM pg_indexes idx
    WHERE idx.schemaname = 'public'
      AND idx.tablename = 'friend_requests'
      AND idx.indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND idx.indexdef ILIKE '%(requester_user_id, addressee_user_id)%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', record_item.object_name);
  END LOOP;
END $$;

ALTER TABLE public.friend_requests
  DROP CONSTRAINT IF EXISTS chk_friend_requests_status;

ALTER TABLE public.friend_requests
  DROP CONSTRAINT IF EXISTS friend_requests_status_check;

ALTER TABLE public.friend_requests
  ADD CONSTRAINT chk_friend_requests_status
  CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled'));

DROP INDEX IF EXISTS public.idx_friend_requests_pending_pair_unique;

CREATE UNIQUE INDEX idx_friend_requests_pending_pair_unique
ON public.friend_requests (
  LEAST(requester_user_id, addressee_user_id),
  GREATEST(requester_user_id, addressee_user_id)
)
WHERE status = 'pending';

COMMIT;
