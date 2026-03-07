BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_admins_email_lower
ON public.admins (lower(email));

COMMIT;
