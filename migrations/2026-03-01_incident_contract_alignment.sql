BEGIN;

ALTER TABLE public.incident_reports
  ADD COLUMN IF NOT EXISTS priority varchar(20) NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS assigned_admin_id bigint NULL,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS resolution_notes text NULL;

ALTER TABLE public.incident_reports
  DROP CONSTRAINT IF EXISTS incident_reports_status_check;

ALTER TABLE public.incident_reports
  ADD CONSTRAINT incident_reports_status_check
  CHECK (status IN ('pending', 'dispatched', 'in_progress', 'resolved'));

ALTER TABLE public.incident_reports
  DROP CONSTRAINT IF EXISTS incident_reports_priority_check;

ALTER TABLE public.incident_reports
  ADD CONSTRAINT incident_reports_priority_check
  CHECK (priority IN ('critical', 'high', 'medium', 'low'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'incident_reports_assigned_admin_id_fkey'
  ) THEN
    ALTER TABLE public.incident_reports
      ADD CONSTRAINT incident_reports_assigned_admin_id_fkey
      FOREIGN KEY (assigned_admin_id) REFERENCES public.admins(id) ON DELETE SET NULL;
  END IF;
END $$;

UPDATE public.incident_reports
SET priority = 'medium'
WHERE priority IS NULL;

UPDATE public.incident_reports
SET updated_at = created_at
WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_incident_reports_status_created
  ON public.incident_reports (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_reports_priority_created
  ON public.incident_reports (priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_reports_assigned_status
  ON public.incident_reports (assigned_admin_id, status);

INSERT INTO public.permissions (name, description)
SELECT 'view_incidents', 'Can view incidents'
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions WHERE name = 'view_incidents'
);

INSERT INTO public.permissions (name, description)
SELECT 'manage_incidents', 'Can manage incidents'
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions WHERE name = 'manage_incidents'
);

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.name IN ('view_incidents', 'manage_incidents')
WHERE lower(r.name) = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
