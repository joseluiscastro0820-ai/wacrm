import type { SupabaseClient } from "@supabase/supabase-js";

// Hardcoded Spanish, same reasoning as the return-confirmation text in
// the WhatsApp webhook route: this speaks to the CUSTOMER, not the
// app UI (which goes through next-intl), and there's no per-account
// customer locale anywhere in this codebase to key off of yet.
const DISPATCH_TERMS_TEXT =
  "📦 Tu pedido fue confirmado. Te contamos nuestra política de envíos: una vez el pedido salga despachado, si decides cancelarlo, el costo del domicilio corre por tu cuenta. ¡Gracias por tu compra!";

/**
 * Fires once per deal — the moment it's moved INTO a pipeline stage
 * flagged `send_dispatch_terms` (today, "Confirmado" on Jose's
 * "Ventas" pipeline) — sending the customer a WhatsApp note on the
 * delivery-cancellation policy: cancelling after the pedido is
 * despachado means the domicilio cost is on them (same policy
 * Rappi/Domicilios.com-style platforms disclose up front).
 *
 * Called from both places a deal's stage_id can change — the kanban
 * board's drag-and-drop (PipelinesPage.handleDealMoved) and the deal
 * form's save (DealForm.handleSave) — so it fires regardless of which
 * UI moved the card. Idempotent via `deals.dispatch_terms_sent_at`:
 * a deal that re-enters the flagged stage, or was saved twice, is
 * never messaged a second time.
 *
 * Best-effort and silent on any failure (missing stage flag, no
 * contact, send API error) — a WhatsApp hiccup must never block or
 * roll back the stage move itself, which already succeeded by the
 * time this is called.
 */
export async function maybeSendDispatchTerms(
  supabase: SupabaseClient,
  dealId: string,
  newStageId: string,
): Promise<void> {
  try {
    const [{ data: deal }, { data: stage }] = await Promise.all([
      supabase
        .from("deals")
        .select("id, contact_id, dispatch_terms_sent_at")
        .eq("id", dealId)
        .maybeSingle(),
      supabase
        .from("pipeline_stages")
        .select("send_dispatch_terms")
        .eq("id", newStageId)
        .maybeSingle(),
    ]);

    if (!deal || !stage) return;
    if (!stage.send_dispatch_terms) return;
    if (deal.dispatch_terms_sent_at) return; // already sent once for this deal
    if (!deal.contact_id) return; // no contact — nowhere to send it

    const res = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_id: deal.contact_id,
        message_type: "text",
        content_text: DISPATCH_TERMS_TEXT,
      }),
    });
    if (!res.ok) return;

    await supabase
      .from("deals")
      .update({ dispatch_terms_sent_at: new Date().toISOString() })
      .eq("id", dealId);
  } catch {
    // Best-effort — see function doc.
  }
}
