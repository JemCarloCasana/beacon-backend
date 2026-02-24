-- Align admin request + notification schema with backend routes.

BEGIN;

-- notifications.recipient_admin_id must match admins.id type and FK.
ALTER TABLE public.notifications
ADD COLUMN IF NOT EXISTS recipient_admin_id bigint;

ALTER TABLE public.notifications
ALTER COLUMN recipient_admin_id TYPE bigint USING recipient_admin_id::bigint;

ALTER TABLE public.notifications
ALTER COLUMN recipient_admin_id SET NOT NULL;

ALTER TABLE public.notifications
DROP CONSTRAINT IF EXISTS notifications_recipient_user_id_fkey;

ALTER TABLE public.notifications
DROP CONSTRAINT IF EXISTS notifications_recipient_admin_fkey;

ALTER TABLE public.notifications
DROP CONSTRAINT IF EXISTS notifications_recipient_admin_id_fkey;

ALTER TABLE public.notifications
ADD CONSTRAINT notifications_recipient_admin_id_fkey
FOREIGN KEY (recipient_admin_id) REFERENCES public.admins(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_admin_created
ON public.notifications (recipient_admin_id, created_at DESC);

-- admin_requests consistency for create/accept/reject flow.
ALTER TABLE public.admin_requests
ADD COLUMN IF NOT EXISTS decision_note text;

ALTER TABLE public.admin_requests
ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.admin_requests
ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

ALTER TABLE public.admin_requests
ADD COLUMN IF NOT EXISTS reviewed_by_admin_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_requests_status_check'
  ) THEN
    ALTER TABLE public.admin_requests
      ADD CONSTRAINT admin_requests_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'admin_requests_no_self_request'
  ) THEN
    ALTER TABLE public.admin_requests
      ADD CONSTRAINT admin_requests_no_self_request
      CHECK (personnel_id <> requested_by_admin_id);
  END IF;
END $$;

ALTER TABLE public.admin_requests
DROP CONSTRAINT IF EXISTS admin_requests_personnel_fkey;
ALTER TABLE public.admin_requests
ADD CONSTRAINT admin_requests_personnel_fkey
FOREIGN KEY (personnel_id) REFERENCES public.admins(id) ON DELETE CASCADE;

ALTER TABLE public.admin_requests
DROP CONSTRAINT IF EXISTS admin_requests_requested_by_fkey;
ALTER TABLE public.admin_requests
ADD CONSTRAINT admin_requests_requested_by_fkey
FOREIGN KEY (requested_by_admin_id) REFERENCES public.admins(id) ON DELETE CASCADE;

ALTER TABLE public.admin_requests
DROP CONSTRAINT IF EXISTS admin_requests_reviewed_by_fkey;
ALTER TABLE public.admin_requests
ADD CONSTRAINT admin_requests_reviewed_by_fkey
FOREIGN KEY (reviewed_by_admin_id) REFERENCES public.admins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_admin_requests_status_created
ON public.admin_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_requests_requested_by
ON public.admin_requests (requested_by_admin_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_requests_pending_personnel
ON public.admin_requests (personnel_id)
WHERE status = 'pending';

DROP TRIGGER IF EXISTS trg_admin_requests_updated_at ON public.admin_requests;
CREATE TRIGGER trg_admin_requests_updated_at
BEFORE UPDATE ON public.admin_requests
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- Atomic accept flow used by PATCH /admin/admin-requests/:id/accept
CREATE OR REPLACE FUNCTION public.accept_admin_request(
  p_request_id bigint,
  p_decided_by_admin_id bigint,
  p_note text DEFAULT NULL
)
RETURNS TABLE (
  request_id bigint,
  personnel_id bigint,
  status varchar,
  role_id integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_personnel_id bigint;
  v_status varchar(20);
  v_admin_role_id integer;
BEGIN
  SELECT ar.personnel_id, ar.status
  INTO v_personnel_id, v_status
  FROM public.admin_requests ar
  WHERE ar.id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Admin request % not found', p_request_id;
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'Admin request % is already %', p_request_id, v_status;
  END IF;

  SELECT r.id
  INTO v_admin_role_id
  FROM public.roles r
  WHERE lower(r.name) = 'admin'
  LIMIT 1;

  IF v_admin_role_id IS NULL THEN
    RAISE EXCEPTION 'Role "admin" not found in roles table';
  END IF;

  UPDATE public.admins
  SET role_id = v_admin_role_id
  WHERE id = v_personnel_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Personnel/admin record % not found', v_personnel_id;
  END IF;

  UPDATE public.admin_requests
  SET
    status = 'approved',
    decision_note = COALESCE(p_note, decision_note),
    reviewed_at = NOW(),
    reviewed_by_admin_id = p_decided_by_admin_id
  WHERE id = p_request_id;

  RETURN QUERY
  SELECT ar.id, ar.personnel_id, ar.status, a.role_id
  FROM public.admin_requests ar
  JOIN public.admins a ON a.id = ar.personnel_id
  WHERE ar.id = p_request_id;
END;
$$;

COMMIT;
