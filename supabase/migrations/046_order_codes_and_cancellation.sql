-- ============================================================
-- 046_order_codes_and_cancellation.sql
--
-- Jose asked for less hand-holding on two specific customer requests
-- that today always escalate to a human: cancelling a pending order,
-- and starting a return from free-text chat. The evaluator-optimizer
-- guardrail (src/lib/ai/evaluate.ts) already in place is what makes
-- trusting the model with these previously-flagged-as-risky actions
-- acceptable now (see src/lib/ai/tools.ts's header note on why they
-- were deliberately left out of the first pass).
--
-- order_code is a short, customer-facing receipt code ("AF-0001"),
-- assigned once per deal the first time it's marked "won" (see
-- /api/push/notify-deal-won) and sent to the customer over WhatsApp
-- there. It is the ONLY thing the AI's order tools accept from a
-- customer to identify an order — never a bare product name or "my
-- last order" — so a stranger can't fish for someone else's order by
-- guessing, and the AI never confuses two orders from the same
-- contact (Jose's own concern: 2026-11-19).
--
-- Global sequence, not per-account: this CRM's real usage today is a
-- single account (Jose's own business). A future multi-tenant
-- deployment wanting per-account numbering would need this revisited.
--
-- No DROP POLICY IF EXISTS lines and no new RLS policies — these are
-- nullable columns on tables whose existing policies already cover
-- them.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS deal_order_code_seq;

ALTER TABLE deals ADD COLUMN IF NOT EXISTS order_code TEXT UNIQUE;
-- Set only when the AI's cancel_order tool cancels an order — lets
-- Acciones/Pipelines distinguish that from Jose/an agent manually
-- marking a deal "lost" for any other reason.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS cancelled_by TEXT CHECK (cancelled_by IN ('ai', 'agent'));
ALTER TABLE deals ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- Why the customer wants to return it, gathered by the AI's
-- request_return tool — shown to whoever reviews the return in
-- Acciones/Devoluciones. Null for returns filed the old way (the
-- interactive list an agent sends from ContactSidebar, which doesn't
-- ask for a reason).
ALTER TABLE returns ADD COLUMN IF NOT EXISTS customer_note TEXT;

-- Atomic, idempotent order-code assignment: a second call for the
-- same deal just returns the existing code rather than burning
-- another sequence value. SECURITY DEFINER so the RLS-scoped
-- dashboard client (not just the service-role client) can call it too
-- without needing UPDATE rights on deals.order_code directly.
CREATE OR REPLACE FUNCTION assign_order_code(p_deal_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT order_code INTO v_code FROM deals WHERE id = p_deal_id;
  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  UPDATE deals
  SET order_code = 'AF-' || lpad(nextval('deal_order_code_seq')::text, 4, '0')
  WHERE id = p_deal_id AND order_code IS NULL
  RETURNING order_code INTO v_code;

  RETURN v_code;
END;
$$;

GRANT EXECUTE ON FUNCTION assign_order_code(UUID) TO authenticated, service_role;
