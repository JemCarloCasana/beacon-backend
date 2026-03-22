BEGIN;

-- Sync friendships to the canonical single-row pair model expected by current routes.
LOCK TABLE public.friendships IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.friendships
  DROP CONSTRAINT IF EXISTS chk_friendships_canonical_pair;

CREATE TEMP TABLE tmp_friendships_canonical ON COMMIT DROP AS
SELECT DISTINCT
  LEAST(user_id, friend_user_id) AS user_id,
  GREATEST(user_id, friend_user_id) AS friend_user_id
FROM public.friendships
WHERE user_id <> friend_user_id;

DELETE FROM public.friendships;

INSERT INTO public.friendships (user_id, friend_user_id)
SELECT user_id, friend_user_id
FROM tmp_friendships_canonical
ORDER BY user_id, friend_user_id
ON CONFLICT (user_id, friend_user_id) DO NOTHING;

ALTER TABLE public.friendships
  ADD CONSTRAINT chk_friendships_canonical_pair
  CHECK (user_id < friend_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair_unique
ON public.friendships (user_id, friend_user_id);

-- Sync friend request pair semantics to one pending request per canonical pair.
ALTER TABLE public.friend_requests
  DROP CONSTRAINT IF EXISTS chk_friend_requests_status;

ALTER TABLE public.friend_requests
  DROP CONSTRAINT IF EXISTS friend_requests_status_check;

ALTER TABLE public.friend_requests
  DROP CONSTRAINT IF EXISTS friend_requests_requester_user_id_addressee_user_id_key;

UPDATE public.friend_requests
SET status = 'cancelled', updated_at = NOW()
WHERE status NOT IN ('pending', 'accepted', 'rejected', 'cancelled');

WITH ranked_pending AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY LEAST(requester_user_id, addressee_user_id),
                   GREATEST(requester_user_id, addressee_user_id)
      ORDER BY created_at DESC, id DESC
    ) AS row_num
  FROM public.friend_requests
  WHERE status = 'pending'
)
UPDATE public.friend_requests fr
SET status = 'cancelled', updated_at = NOW()
FROM ranked_pending rp
WHERE fr.id = rp.id
  AND rp.row_num > 1;

ALTER TABLE public.friend_requests
  ADD CONSTRAINT chk_friend_requests_status
  CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled'));

DROP INDEX IF EXISTS public.idx_friend_requests_pending_pair_unique;

CREATE UNIQUE INDEX idx_friend_requests_pending_pair_unique
ON public.friend_requests (
  LEAST(requester_user_id, addressee_user_id),
  GREATEST(requester_user_id, addressee_user_id)
)
WHERE status = 'pending';

-- Sync broadcast severities to the values accepted by the current admin broadcast routes.
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
  ELSE lower(trim(severity))
END
WHERE severity IS NOT NULL;

ALTER TABLE public.broadcasts
  ADD CONSTRAINT chk_broadcasts_severity
  CHECK (severity IN ('announcement', 'warning', 'danger'));

-- Sync admin report run keys to the combined safety report cards used by current analytics routes.
ALTER TABLE public.admin_report_runs
  DROP CONSTRAINT IF EXISTS admin_report_runs_report_key_check;

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
  ADD CONSTRAINT admin_report_runs_report_key_check
  CHECK (
    report_key IN (
      'daily_safety_report',
      'weekly_safety_report',
      'monthly_safety_report'
    )
  );

COMMIT;
