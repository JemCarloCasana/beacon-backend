BEGIN;

ALTER TABLE public.incident_reports
  ADD COLUMN IF NOT EXISTS assigned_department varchar(64) NULL;

ALTER TABLE public.incident_reports
  DROP CONSTRAINT IF EXISTS incident_reports_assigned_department_check;

ALTER TABLE public.incident_reports
  ADD CONSTRAINT incident_reports_assigned_department_check
  CHECK (
    assigned_department IS NULL OR
    assigned_department IN (
      'Emergency Medical Unit',
      'Fire Station Unit',
      'Police Personnel',
      'Traffic Enforcement Unit'
    )
  );

ALTER TABLE public.incident_reports
  DROP CONSTRAINT IF EXISTS incident_reports_assigned_admin_id_fkey;

DROP INDEX IF EXISTS idx_incident_reports_assigned_status;

ALTER TABLE public.incident_reports
  DROP COLUMN IF EXISTS assigned_admin_id;

CREATE INDEX IF NOT EXISTS idx_incident_reports_department_status_created
  ON public.incident_reports (assigned_department, status, created_at DESC);

COMMIT;
