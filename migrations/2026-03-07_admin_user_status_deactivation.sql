BEGIN;

ALTER TABLE public.admins
  ADD COLUMN IF NOT EXISTS status text;

UPDATE public.admins
SET status = 'active'
WHERE status IS NULL;

ALTER TABLE public.admins
  ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE public.admins
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_admins_status'
  ) THEN
    ALTER TABLE public.admins
      ADD CONSTRAINT chk_admins_status
      CHECK (status IN ('active', 'deactivated'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_admins_status
  ON public.admins (status);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS status text;

UPDATE public.users
SET status = 'active'
WHERE status IS NULL;

ALTER TABLE public.users
  ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE public.users
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_users_status'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT chk_users_status
      CHECK (status IN ('active', 'deactivated'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_status
  ON public.users (status);

COMMIT;
