-- ============================================================
-- 044_deal_fulfillment_status.sql
--
-- "Fase 1" of Jose's Acciones request: quick order-fulfillment
-- status marking ("marca pedido en proceso y despachado") separate
-- from the sales-pipeline stage/won-lost status, which tracks where
-- a deal sits in the SALES process, not whether the physical order
-- has been prepared/shipped.
--
-- Two nullable timestamps, mirroring the existing
-- `deals.dispatch_terms_sent_at` pattern (migration
-- add_delivery_fee_and_dispatch_terms): null = hasn't happened yet,
-- a timestamp = when it did. Lets the UI derive a simple 3-step
-- status (pending -> en proceso -> despachado) without a separate
-- enum, and keeps "mark as X" a trivial single-column UPDATE.
--
-- No RLS changes needed — these are just new columns on `deals`,
-- already covered by the existing deals_update policy (agent+,
-- migration 017_account_sharing).
-- ============================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS in_process_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

COMMENT ON COLUMN deals.in_process_at IS
  'When an agent marked this pedido "en proceso" (being prepared). Null = not yet. Set via the Acciones page quick action.';
COMMENT ON COLUMN deals.dispatched_at IS
  'When an agent marked this pedido "despachado" (shipped/handed off for delivery). Null = not yet. Set via the Acciones page quick action.';
