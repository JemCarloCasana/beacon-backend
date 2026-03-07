BEGIN;

ALTER TABLE public.sos_threads
  ADD COLUMN IF NOT EXISTS assigned_unit text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_sos_threads_assigned_unit'
  ) THEN
    ALTER TABLE public.sos_threads
      ADD CONSTRAINT chk_sos_threads_assigned_unit
      CHECK (
        assigned_unit IS NULL OR assigned_unit IN (
          'Emergency Medical Unit',
          'Fire Station Unit',
          'Police Personnel',
          'Traffic Enforcement Unit'
        )
      );
  END IF;
END $$;

COMMIT;
