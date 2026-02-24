-- Ensure recipient_admin_id exists
ALTER TABLE public.notifications
ADD COLUMN IF NOT EXISTS recipient_admin_id bigint;

-- Drop old wrong FK if present
ALTER TABLE public.notifications
DROP CONSTRAINT IF EXISTS notifications_recipient_user_id_fkey;

-- Drop any previous admin FK with wrong name (safe)
ALTER TABLE public.notifications
DROP CONSTRAINT IF EXISTS notifications_recipient_admin_fkey;
ALTER TABLE public.notifications
DROP CONSTRAINT IF EXISTS notifications_recipient_admin_id_fkey;

-- Add correct FK to admins(id)
ALTER TABLE public.notifications
ADD CONSTRAINT notifications_recipient_admin_id_fkey
FOREIGN KEY (recipient_admin_id)
REFERENCES public.admins(id)
ON DELETE CASCADE;

-- Helpful index
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_admin_created
ON public.notifications (recipient_admin_id, created_at DESC);
