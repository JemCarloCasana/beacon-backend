BEGIN;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel
      ON rel.oid = con.conrelid
    JOIN pg_namespace nsp
      ON nsp.oid = rel.relnamespace
    WHERE con.contype = 'c'
      AND nsp.nspname = 'public'
      AND rel.relname = 'sos_events'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
      AND pg_get_constraintdef(con.oid) ILIKE '%active%'
      AND pg_get_constraintdef(con.oid) ILIKE '%resolved%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.sos_events DROP CONSTRAINT IF EXISTS %I',
      constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE public.sos_events
  ADD CONSTRAINT chk_sos_events_status
  CHECK (
    status IN ('active', 'resolved', 'acknowledged', 'cancelled', 'safe')
  );

COMMIT;
