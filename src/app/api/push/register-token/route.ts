import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/flows/admin-client'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * POST /api/push/register-token
 *
 * Called by the Android app shell (Capacitor — "Fase 2") right after
 * it obtains an FCM registration token, and again whenever FCM
 * reissues one. Any account member may register their own device —
 * this isn't a privileged write, just "notify me on my phone."
 *
 * Upserts on `token` (not `user_id`): the same physical device keeps
 * its token across a logout/login, and a single user can have
 * several devices, so neither column alone is a safe unique key.
 */
export async function POST(request: Request) {
  try {
    // getCurrentAccount() is the authorization boundary here — it
    // proves the caller is a signed-in member of SOME account. The
    // write itself goes through the service-role client rather than
    // the RLS-scoped one so that re-registering a token previously
    // owned by a DIFFERENT user (e.g. a shared device, or someone
    // else logging in on the same phone) correctly reassigns it
    // instead of silently no-op'ing against the old owner's
    // auth.uid()-scoped RLS policy.
    const { accountId, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`push-token-register:${userId}`, RATE_LIMITS.pushTokenRegister)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (!token) return bad('token is required')

    const platform = body.platform === 'ios' || body.platform === 'web' ? body.platform : 'android'

    const { error } = await supabaseAdmin().from('device_push_tokens').upsert(
      {
        account_id: accountId,
        user_id: userId,
        token,
        platform,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    )

    if (error) {
      console.error('[push/register-token] upsert failed:', error)
      return NextResponse.json({ error: 'Failed to register device' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
