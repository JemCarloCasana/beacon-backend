BEGIN;

ALTER TABLE public.broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_severity_check;

ALTER TABLE public.broadcasts
  DROP CONSTRAINT IF EXISTS chk_broadcasts_severity;

UPDATE public.broadcasts
SET severity = CASE lower(trim(severity))
  WHEN 'info' THEN 'announcement'
  WHEN 'medium' THEN 'warning'
  WHEN 'high' THEN 'danger'
  WHEN 'critical' THEN 'danger'
  ELSE severity
END
WHERE severity IS NOT NULL;

ALTER TABLE public.broadcasts
  ADD CONSTRAINT chk_broadcasts_severity
  CHECK (severity IN ('announcement', 'warning', 'danger'));

COMMIT;
