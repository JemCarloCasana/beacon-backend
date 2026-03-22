BEGIN;

UPDATE public.admin_report_runs
SET report_key = CASE report_key
  WHEN 'daily_incident_summary' THEN 'daily_safety_report'
  WHEN 'daily_sos_summary' THEN 'daily_safety_report'
  WHEN 'weekly_response_analysis' THEN 'weekly_safety_report'
  WHEN 'monthly_sos_safety_report' THEN 'monthly_safety_report'
  ELSE report_key
END
WHERE report_key IN (
  'daily_incident_summary',
  'daily_sos_summary',
  'weekly_response_analysis',
  'monthly_sos_safety_report'
);

ALTER TABLE public.admin_report_runs
  DROP CONSTRAINT IF EXISTS admin_report_runs_report_key_check;

ALTER TABLE public.admin_report_runs
  ADD CONSTRAINT admin_report_runs_report_key_check
  CHECK (
    report_key IN (
      'daily_safety_report',
      'weekly_safety_report',
      'monthly_safety_report'
    )
  );

COMMIT;
