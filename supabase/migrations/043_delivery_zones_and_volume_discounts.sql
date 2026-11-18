-- ============================================================
-- 043_delivery_zones_and_volume_discounts.sql
--
-- "Fase 0" of Jose's request to reduce how often a human needs to
-- step in: the two cases he named — domicilio a una ciudad/pueblo
-- cercano, y descuentos por venta al por mayor — were previously
-- always a judgment call (the account only had ONE flat
-- accounts.default_delivery_fee, no discount concept at all), so
-- the AI could never answer them on its own and always had to hand
-- off. These two tables let an admin configure the answers once;
-- the AI then quotes them directly (see buildPricingKnowledge in
-- src/lib/ai/knowledge.ts) instead of escalating every time, and the
-- human-facing deal form (Pipelines) gets quick-pick/auto-apply UI
-- for the same data.
--
-- delivery_zones: per-city/zone delivery fee, an override on top of
-- accounts.default_delivery_fee (which stays as the fallback when a
-- customer's city isn't one of these).
--
-- volume_discounts: a simple quantity-threshold -> % off ladder,
-- account-wide (not per-product) for a first pass — Jose's own
-- example was "venta al por mayor" in general, not a specific SKU.
--
-- Both follow the same RLS shape as `products` (migration
-- add_products_catalog): any account member can read, only admin+
-- can write — pricing policy is a business decision, matching how
-- accounts.default_delivery_fee is already gated in deals-settings.tsx.
-- ============================================================

CREATE TABLE IF NOT EXISTS delivery_zones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  fee NUMERIC NOT NULL DEFAULT 0 CHECK (fee >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, label)
);

CREATE INDEX IF NOT EXISTS idx_delivery_zones_account ON delivery_zones(account_id);

ALTER TABLE delivery_zones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delivery_zones_select ON delivery_zones;
DROP POLICY IF EXISTS delivery_zones_insert ON delivery_zones;
DROP POLICY IF EXISTS delivery_zones_update ON delivery_zones;
DROP POLICY IF EXISTS delivery_zones_delete ON delivery_zones;
CREATE POLICY delivery_zones_select ON delivery_zones FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY delivery_zones_insert ON delivery_zones FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY delivery_zones_update ON delivery_zones FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY delivery_zones_delete ON delivery_zones FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS volume_discounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  min_quantity INTEGER NOT NULL CHECK (min_quantity >= 2),
  discount_percent NUMERIC NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, min_quantity)
);

CREATE INDEX IF NOT EXISTS idx_volume_discounts_account ON volume_discounts(account_id);

ALTER TABLE volume_discounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS volume_discounts_select ON volume_discounts;
DROP POLICY IF EXISTS volume_discounts_insert ON volume_discounts;
DROP POLICY IF EXISTS volume_discounts_update ON volume_discounts;
DROP POLICY IF EXISTS volume_discounts_delete ON volume_discounts;
CREATE POLICY volume_discounts_select ON volume_discounts FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY volume_discounts_insert ON volume_discounts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY volume_discounts_update ON volume_discounts FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY volume_discounts_delete ON volume_discounts FOR DELETE
  USING (is_account_member(account_id, 'admin'));
