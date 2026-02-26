BEGIN;

DO $$
BEGIN
  IF to_regclass('public.incident_reports') IS NOT NULL THEN
    EXECUTE '
      CREATE TABLE IF NOT EXISTS public.incident_report_images (
        id bigserial PRIMARY KEY,
        incident_report_id bigint NOT NULL
          REFERENCES public.incident_reports(id) ON DELETE CASCADE,
        image_data bytea NOT NULL,
        content_type varchar(100) NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )';
  ELSIF to_regclass('public.incidents') IS NOT NULL THEN
    EXECUTE '
      CREATE TABLE IF NOT EXISTS public.incident_report_images (
        id bigserial PRIMARY KEY,
        incident_report_id bigint NOT NULL
          REFERENCES public.incidents(id) ON DELETE CASCADE,
        image_data bytea NOT NULL,
        content_type varchar(100) NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )';
  ELSE
    RAISE EXCEPTION 'Neither public.incident_reports nor public.incidents table exists';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_incident_report_images_report_sort
  ON public.incident_report_images (incident_report_id, sort_order);

COMMIT;
