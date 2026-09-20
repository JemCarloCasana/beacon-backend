BEGIN;

INSERT INTO public.permissions (name, description)
VALUES
  ('manage_reports', 'Can view and generate safety reports'),
  ('manage_sos', 'Can monitor and manage SOS operations')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.name IN ('manage_reports', 'manage_sos')
WHERE lower(r.name) IN ('admin', 'super_admin')
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
