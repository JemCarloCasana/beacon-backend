BEGIN;

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
