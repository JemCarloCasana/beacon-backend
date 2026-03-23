ALTER TABLE public.broadcast_user_deliveries
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
