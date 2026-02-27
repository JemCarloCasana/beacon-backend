BEGIN;

ALTER TABLE public.sos_events
  ADD COLUMN IF NOT EXISTS sos_id bigint,
  ADD COLUMN IF NOT EXISTS actor_type varchar(20) NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS actor_admin_id bigint;

UPDATE public.sos_events
SET sos_id = id
WHERE sos_id IS NULL;

UPDATE public.sos_events
SET actor_type = 'user'
WHERE actor_type IS NULL OR actor_type = '';

CREATE INDEX IF NOT EXISTS idx_sos_thread_created
  ON public.sos_events (sos_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_sos_status_created
  ON public.sos_events (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sos_thread_status
  ON public.sos_events (sos_id, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sos_events_sos_id_fkey'
  ) THEN
    ALTER TABLE public.sos_events
      ADD CONSTRAINT sos_events_sos_id_fkey
      FOREIGN KEY (sos_id) REFERENCES public.sos_events(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sos_events_actor_admin_id_fkey'
  ) THEN
    ALTER TABLE public.sos_events
      ADD CONSTRAINT sos_events_actor_admin_id_fkey
      FOREIGN KEY (actor_admin_id) REFERENCES public.admins(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
