BEGIN;

-- Core roles used by adminAuthRoutes.js
INSERT INTO public.roles (name, description)
VALUES
  ('admin', 'Admin access'),
  ('personnel', 'Personnel access')
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description;

-- Permissions used by current admin routes
INSERT INTO public.permissions (name, description)
VALUES
  ('manage_users', 'Can manage mobile users'),
  ('manage_admins', 'Can manage admin accounts')
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description;

-- Grant admin role both manage_users and manage_admins
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.name IN ('manage_users', 'manage_admins')
WHERE r.name = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
