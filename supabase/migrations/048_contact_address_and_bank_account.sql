-- ============================================================
-- 048_contact_address_and_bank_account.sql
--
-- Jose asked for two fields the Contacts screen couldn't capture at
-- all: a customer's delivery address (needed to actually fulfil a
-- WhatsApp order) and their bank account (needed when a devolución
-- gets approved and the money has to go back to the customer).
--
-- Both are plain nullable columns on `contacts`, covered by the
-- existing contacts RLS policies — no new policies needed, same as
-- migrations 046/047.
--
-- `address` is also offered to the AI's `update_contact_field` tool
-- (src/lib/ai/tools.ts) so it can save a delivery address the
-- customer states in chat, same as name/email/company already are.
-- `bank_account` is deliberately NOT offered to the AI — there's no
-- legitimate reason a customer would need to state their own bank
-- account over chat, so this stays a human-entered-only field (set
-- from the Contacts screen when processing a refund).
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS bank_account TEXT;
