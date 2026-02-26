BEGIN;

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS profile_image_url text;

COMMIT;
