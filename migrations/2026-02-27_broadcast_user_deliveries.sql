BEGIN;

-- Broadcast catalog (created by admin side, consumed by app users)
CREATE TABLE IF NOT EXISTS public.broadcasts (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'medium', 'high', 'critical')),
  audience_type text NOT NULL DEFAULT 'all' CHECK (audience_type IN ('all', 'role')),
  audience_role_ids integer[] NULL,
  created_by_admin_id bigint NOT NULL REFERENCES public.admins(id) ON DELETE RESTRICT,
  sent_at timestamptz NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- App-user inbox deliveries (one row per user recipient)
CREATE TABLE IF NOT EXISTS public.broadcast_user_deliveries (
  broadcast_id bigint NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz NULL,
  PRIMARY KEY (broadcast_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_user_deliveries_user
  ON public.broadcast_user_deliveries (user_id, delivered_at DESC);

CREATE INDEX IF NOT EXISTS idx_broadcasts_sent_at
  ON public.broadcasts (sent_at DESC);

COMMIT;
