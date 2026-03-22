CREATE TABLE IF NOT EXISTS public.user_notifications (
  id bigserial PRIMARY KEY,
  recipient_user_id bigint NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE public.user_notifications
  DROP CONSTRAINT IF EXISTS user_notifications_recipient_user_id_fkey;

ALTER TABLE public.user_notifications
  ADD CONSTRAINT user_notifications_recipient_user_id_fkey
  FOREIGN KEY (recipient_user_id)
  REFERENCES public.users(id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_user_notifications_recipient_created
ON public.user_notifications (recipient_user_id, created_at DESC);
