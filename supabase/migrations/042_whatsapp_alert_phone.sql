-- ============================================================
-- 042_whatsapp_alert_phone.sql — operational alerts to the admin's
-- own WhatsApp number
--
-- Jose asked how he's supposed to notice a pending return or an AI
-- handoff when he's away from home and not staring at the Inbox. The
-- app itself is already reachable from anywhere (it's a hosted PWA,
-- not something tied to a machine at home) — what was missing is a
-- push toward HIM instead of requiring him to pull by opening a page.
--
-- `alert_phone` is the admin's personal WhatsApp number (distinct
-- from `phone_number_id`, which is the BUSINESS number customers
-- message). When set, operational events — an AI handoff, a new
-- pending return — send a WhatsApp message to this number via the
-- same Meta credentials already stored on this row. NULL (the
-- default) means alerts are simply off; nothing changes for accounts
-- that don't configure it.
--
-- Stored as free text, not E.164-constrained at the DB layer — the
-- settings UI validates with the existing isValidE164() before
-- saving, matching how every other phone field in this codebase is
-- handled (contacts.phone, etc.).
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS alert_phone TEXT;

COMMENT ON COLUMN whatsapp_config.alert_phone IS
  'Admin''s personal WhatsApp number for operational alerts (AI handoff, pending returns). NULL = alerts off. Distinct from phone_number_id, the business-facing number.';
