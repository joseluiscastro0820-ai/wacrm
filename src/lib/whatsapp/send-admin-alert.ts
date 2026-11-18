// ============================================================
// Operational alerts to the account admin's own WhatsApp number —
// migration 042. Jose (solo operator) asked how he's supposed to
// notice a pending return or an AI handoff when he's away from his
// desk. This pushes a WhatsApp message to HIM instead of requiring
// him to pull by opening the app.
//
// Meta requires an approved message template for any
// business-initiated message outside the recipient's 24h session
// window — and the admin's own number essentially never has an open
// window with the business number (they don't message their own
// bot on a schedule). So this always sends as a template, never a
// free-form text. The template itself (ALERT_TEMPLATE_NAME) has to
// exist as an APPROVED row in message_templates first — submit it
// from Settings > Templates once and Meta's review has to clear
// before any alert actually reaches a phone.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'

/** Must match the template name/language seeded as a Draft row in
 *  message_templates (`operational_alert` / `es`) — submit it from
 *  Settings > Templates to send it to Meta for approval. A single
 *  body variable carries the alert text. */
export const ALERT_TEMPLATE_NAME = 'operational_alert'
export const ALERT_TEMPLATE_LANGUAGE = 'es'

/**
 * Best-effort WhatsApp ping to the account's configured alert_phone.
 * Never throws — every failure mode (alerts not configured, config
 * row missing, Meta rejects the send because the template isn't
 * approved yet) is swallowed and logged, because a notification
 * going out is never allowed to block the operational flow it's
 * reporting on (a handoff, a return request). Callers fire this
 * without awaiting the result mattering to their own response.
 */
export async function sendAdminAlert(
  accountId: string,
  text: string
): Promise<void> {
  try {
    const { data: config, error } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('phone_number_id, access_token, alert_phone')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error || !config?.alert_phone || !config.phone_number_id || !config.access_token) {
      return
    }

    const to = sanitizePhoneForMeta(config.alert_phone)
    if (!to) return

    const accessToken = decrypt(config.access_token)

    await sendTemplateMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to,
      templateName: ALERT_TEMPLATE_NAME,
      language: ALERT_TEMPLATE_LANGUAGE,
      params: [text],
    })
  } catch (err) {
    // Most likely cause early on: the template hasn't been submitted
    // / approved by Meta yet. Logged, not surfaced — see module doc.
    console.error('[admin-alert] failed to send:', err)
  }
}
