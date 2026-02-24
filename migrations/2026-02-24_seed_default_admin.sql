BEGIN;

-- Seed one default admin account (idempotent by email).
INSERT INTO public.admins (email, password_hash, full_name, role_id)
SELECT
  'admin@beacon.com',
  '$2b$12$RTrM5V9NmZIU.r4mhzGN.u9xSXfhifiKuooTOxcFPzfj.P18jKG.2',
  'Default Admin',
  r.id
FROM public.roles r
WHERE lower(r.name) = 'admin'
  AND NOT EXISTS (
    SELECT 1 FROM public.admins a WHERE lower(a.email) = lower('admin@beacon.com')
  )
LIMIT 1;

COMMIT;
