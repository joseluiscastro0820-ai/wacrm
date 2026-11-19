// ============================================================
// Native push notifications (FCM) to every device the Android app
// shell (Capacitor — see capacitor.config.ts) has registered for an
// account. "Fase 2" of Jose's companion-app request — this
// complements, not replaces, the WhatsApp admin alert (migration 042
// / send-admin-alert.ts): that one reaches any phone with WhatsApp,
// this one reaches the native app with a real tray notification even
// when the app isn't open.
//
// Credentials come from a single Vercel env var,
// FIREBASE_SERVICE_ACCOUNT_JSON — the full service-account JSON
// Jose downloads from the Firebase console, pasted in as one line.
// Until that's configured this is a silent no-op (same "never block
// the operational flow it's reporting on" philosophy as
// sendAdminAlert) so none of the three call sites (handoff, new
// return, deal won) need to care whether Fase 2 has been finished
// yet.
// ============================================================

import { getApps, initializeApp, cert, type App } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'
import { supabaseAdmin } from '@/lib/flows/admin-client'

let _app: App | null | undefined // undefined = not attempted yet, null = attempted and failed/unconfigured

function firebaseApp(): App | null {
  if (_app !== undefined) return _app

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!json) {
    _app = null
    return _app
  }

  try {
    const existing = getApps()
    if (existing.length > 0) {
      _app = existing[0]
      return _app
    }
    const serviceAccount = JSON.parse(json)
    _app = initializeApp({ credential: cert(serviceAccount) })
  } catch (err) {
    console.error('[push] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:', err)
    _app = null
  }
  return _app
}

export interface PushPayload {
  title: string
  body: string
  /** Relative in-app path to open when the notification is tapped,
   *  e.g. "/actions" or "/inbox?c=<conversationId>". Read by the
   *  client-side pushNotificationActionPerformed listener — see
   *  src/components/push-register.tsx. */
  path?: string
}

/**
 * Best-effort push to every device registered for an account. Never
 * throws: no Firebase credentials configured yet, no devices
 * registered, and individual send failures are all swallowed and
 * logged — identical contract to sendAdminAlert so every call site
 * can `void sendAccountPush(...)` without a try/catch of its own.
 */
export async function sendAccountPush(
  accountId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    const app = firebaseApp()
    if (!app) return // Fase 2 not configured yet on this deployment

    const { data: rows, error } = await supabaseAdmin()
      .from('device_push_tokens')
      .select('id, token')
      .eq('account_id', accountId)

    if (error || !rows || rows.length === 0) return

    const tokens = rows.map((r) => r.token as string)

    const response = await getMessaging(app).sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: payload.path ? { path: payload.path } : undefined,
      android: { priority: 'high' },
    })

    // A token FCM reports as unregistered/invalid will never succeed
    // again (uninstalled app, cleared data, token rotated without a
    // re-register yet) — prune it so future sends don't keep paying
    // for a doomed delivery attempt.
    const staleIds: string[] = []
    response.responses.forEach((r, i) => {
      if (
        !r.success &&
        (r.error?.code === 'messaging/registration-token-not-registered' ||
          r.error?.code === 'messaging/invalid-registration-token')
      ) {
        staleIds.push(rows[i].id as string)
      }
    })
    if (staleIds.length > 0) {
      await supabaseAdmin().from('device_push_tokens').delete().in('id', staleIds)
    }
  } catch (err) {
    console.error('[push] failed to send:', err)
  }
}
