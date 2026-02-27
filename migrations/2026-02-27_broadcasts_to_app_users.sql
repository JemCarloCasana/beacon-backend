BEGIN;

-- Move broadcast recipient model from admin-only deliveries to app-user deliveries.
-- This keeps existing tables intact and adds app-user delivery tracking.

CREATE TABLE IF NOT EXISTS public.broadcast_user_deliveries (
  broadcast_id bigint NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz NULL,
  PRIMARY KEY (broadcast_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_user_deliveries_user
  ON public.broadcast_user_deliveries (user_id, delivered_at DESC);

-- Optional historical backfill:
-- 1) sent broadcasts with audience_type='all' -> all app users
INSERT INTO public.broadcast_user_deliveries (broadcast_id, user_id)
SELECT b.id, u.id
FROM public.broadcasts b
CROSS JOIN public.users u
WHERE b.sent_at IS NOT NULL
  AND b.audience_type = 'all'
ON CONFLICT (broadcast_id, user_id) DO NOTHING;

-- 2) sent broadcasts with audience_type='role' -> users.role matched to role names from audience_role_ids
INSERT INTO public.broadcast_user_deliveries (broadcast_id, user_id)
SELECT DISTINCT b.id, u.id
FROM public.broadcasts b
JOIN public.users u
  ON b.sent_at IS NOT NULL
 AND b.audience_type = 'role'
WHERE EXISTS (
  SELECT 1
  FROM unnest(COALESCE(b.audience_role_ids, ARRAY[]::integer[])) AS rid(role_id)
  JOIN public.roles r ON r.id = rid.role_id
  WHERE lower(r.name) = lower(u.role)
)
ON CONFLICT (broadcast_id, user_id) DO NOTHING;

COMMIT;

