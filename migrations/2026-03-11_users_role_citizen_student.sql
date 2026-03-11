BEGIN;

UPDATE public.users
SET role = lower(trim(role))
WHERE role IS NOT NULL;

UPDATE public.users
SET role = 'citizen'
WHERE role IS NULL
   OR role NOT IN ('citizen', 'student');

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS chk_users_role;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
  ALTER COLUMN role SET DEFAULT 'citizen';

ALTER TABLE public.users
  ALTER COLUMN role SET NOT NULL;

ALTER TABLE public.users
  ADD CONSTRAINT chk_users_role
  CHECK (role IN ('citizen', 'student'));

COMMIT;
