BEGIN;

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS audience_roles text[] NULL;

UPDATE public.broadcasts
SET audience_roles = ARRAY(
  SELECT DISTINCT lower(trim(r.name))
  FROM unnest(COALESCE(public.broadcasts.audience_role_ids, ARRAY[]::integer[])) AS rid(role_id)
  JOIN public.roles r ON r.id = rid.role_id
  WHERE lower(trim(r.name)) IN ('citizen', 'student')
)
WHERE audience_roles IS NULL
  AND audience_role_ids IS NOT NULL;

UPDATE public.broadcasts
SET audience_roles = NULL
WHERE audience_roles = ARRAY[]::text[];

UPDATE public.broadcasts
SET audience_roles = ARRAY(
  SELECT DISTINCT lower(trim(role_name))
  FROM unnest(COALESCE(public.broadcasts.audience_roles, ARRAY[]::text[])) AS role_name
  WHERE lower(trim(role_name)) IN ('citizen', 'student')
)
WHERE audience_roles IS NOT NULL;

ALTER TABLE public.broadcasts
  DROP CONSTRAINT IF EXISTS chk_broadcasts_audience_roles;

ALTER TABLE public.broadcasts
  ADD CONSTRAINT chk_broadcasts_audience_roles
  CHECK (
    audience_roles IS NULL
    OR (
      COALESCE(array_length(audience_roles, 1), 0) > 0
      AND audience_roles <@ ARRAY['citizen', 'student']::text[]
    )
  );

COMMIT;
