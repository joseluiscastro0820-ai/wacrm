-- ============================================================
-- 047_catalog_categories_and_return_reason.sql
--
-- Jose asked (2026-11-19) to fix two concrete gaps on the way to a
-- "real" Catálogo and a cleaner Devoluciones queue:
--
--   1. The low-stock badge in src/app/(dashboard)/catalog/page.tsx was
--      hardcoded to "5 or fewer" — no way to raise it for a
--      fast-moving item or lower it for a slow one. low_stock_threshold
--      makes that a per-product setting instead, defaulting to 5 so
--      every existing product keeps today's exact behavior.
--   2. products.category lets the Catálogo be grouped/filtered, and
--      gives the AI's new check_product tool (src/lib/ai/tools.ts) a
--      coarser thing to search by than an exact product name.
--
-- returns.reason_category distinguishes "no me gustó / cambié de
-- opinión" from "llegó defectuoso / está en garantía" — the gap Jose
-- flagged directly: "buscando un pedido para devolución nos faltó
-- garantía". Nullable: existing rows and the interactive-list path
-- (ContactSidebar, which doesn't ask) just don't have one yet.
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5;
ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT;

ALTER TABLE returns ADD COLUMN IF NOT EXISTS reason_category TEXT
  CHECK (reason_category IN ('change_of_mind', 'warranty'));
