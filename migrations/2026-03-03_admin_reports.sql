CREATE TABLE IF NOT EXISTS public.admin_report_runs (
  id bigserial PRIMARY KEY,
  report_key varchar(64) NOT NULL CHECK (
    report_key IN (
      'daily_incident_summary',
      'weekly_response_analysis',
      'monthly_safety_report'
    )
  ),
  range_key varchar(8) NOT NULL CHECK (range_key IN ('24h', '7d', '30d')),
  timezone varchar(64) NOT NULL DEFAULT 'Asia/Manila',
  generated_by_admin_id bigint NULL,
  generated_at timestamptz NOT NULL DEFAULT NOW(),
  payload_hash varchar(64) NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_report_runs_lookup
  ON public.admin_report_runs (report_key, range_key, timezone, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_report_runs_generated_at
  ON public.admin_report_runs (generated_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sos_threads'
      AND column_name = 'latest_event_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_sos_threads_status_latest_event
      ON public.sos_threads (latest_status, latest_event_at DESC)';
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sos_threads'
      AND column_name = 'root_event_id'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_sos_threads_status_root_event
      ON public.sos_threads (latest_status, root_event_id DESC)';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_sos_threads_latest_status
      ON public.sos_threads (latest_status)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sos_threads'
      AND column_name = 'opened_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_sos_threads_opened_at
      ON public.sos_threads (opened_at DESC)';
  END IF;
END $$;
