-- DANGER: destructive maintenance script.
-- Intended for staging/dev or explicitly approved production cleanup only.
-- This script removes SOS and incident operational data plus related
-- SOS/incident notification rows. It does NOT touch users, admins, roles,
-- permissions, friendships, or auth/reference data.
--
-- Affected tables:
--   - public.incident_report_images
--   - public.incident_reports
--   - public.sos_events
--   - public.sos_threads
--   - public.user_notifications (SOS/incident rows only)
--   - public.notifications (SOS/incident rows only)
--
-- Optional cleanup is included below for:
--   - public.broadcast_user_deliveries
--   - public.broadcasts
--
-- Suggested verification before running:
-- SELECT COUNT(*) AS incident_report_images_count FROM public.incident_report_images;
-- SELECT COUNT(*) AS incident_reports_count FROM public.incident_reports;
-- SELECT COUNT(*) AS sos_events_count FROM public.sos_events;
-- SELECT COUNT(*) AS sos_threads_count FROM public.sos_threads;
-- SELECT COUNT(*) AS user_notifications_count
-- FROM public.user_notifications
-- WHERE type IN ('sos_update', 'incident_update');
-- SELECT COUNT(*) AS admin_notifications_count
-- FROM public.notifications
-- WHERE type IN ('sos', 'incident');

BEGIN;

DELETE FROM public.incident_report_images;

DELETE FROM public.user_notifications
WHERE type IN ('sos_update', 'incident_update');

DELETE FROM public.notifications
WHERE type IN ('sos', 'incident');

DELETE FROM public.sos_events;

DELETE FROM public.sos_threads;

DELETE FROM public.incident_reports;

-- Optional: remove test/manual broadcast data too.
-- Uncomment both statements below only if you also want broadcasts wiped.
-- DELETE FROM public.broadcast_user_deliveries;
-- DELETE FROM public.broadcasts;

ALTER SEQUENCE public.incident_report_images_id_seq RESTART WITH 1;
ALTER SEQUENCE public.incident_reports_id_seq RESTART WITH 1;
ALTER SEQUENCE public.sos_events_id_seq RESTART WITH 1;
ALTER SEQUENCE public.sos_threads_id_seq RESTART WITH 1;
ALTER SEQUENCE public.user_notifications_id_seq RESTART WITH 1;
ALTER SEQUENCE public.notifications_id_seq RESTART WITH 1;

COMMIT;

-- Suggested verification after running:
-- SELECT COUNT(*) AS incident_reports_count FROM public.incident_reports;
-- SELECT COUNT(*) AS sos_threads_count FROM public.sos_threads;
-- SELECT COUNT(*) AS sos_events_count FROM public.sos_events;
-- SELECT COUNT(*) AS user_notifications_count
-- FROM public.user_notifications
-- WHERE type IN ('sos_update', 'incident_update');
-- SELECT COUNT(*) AS admin_notifications_count
-- FROM public.notifications
-- WHERE type IN ('sos', 'incident');
