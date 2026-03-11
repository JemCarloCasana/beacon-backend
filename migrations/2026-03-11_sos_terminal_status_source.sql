BEGIN;

ALTER TABLE public.sos_threads
  ADD COLUMN IF NOT EXISTS terminal_status text NULL,
  ADD COLUMN IF NOT EXISTS resolved_source text NULL;

ALTER TABLE public.sos_threads
  DROP CONSTRAINT IF EXISTS chk_sos_threads_terminal_status;

ALTER TABLE public.sos_threads
  ADD CONSTRAINT chk_sos_threads_terminal_status
  CHECK (
    terminal_status IS NULL
    OR terminal_status IN ('cancelled', 'safe')
  );

ALTER TABLE public.sos_threads
  DROP CONSTRAINT IF EXISTS chk_sos_threads_resolved_source;

ALTER TABLE public.sos_threads
  ADD CONSTRAINT chk_sos_threads_resolved_source
  CHECK (
    resolved_source IS NULL
    OR resolved_source IN ('android')
  );

COMMIT;
