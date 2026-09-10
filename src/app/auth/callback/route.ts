import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Supabase Auth's email links (signup confirmation, password
// recovery, invite acceptance) use the PKCE flow: the link itself
// verifies the token server-side at Supabase, then redirects the
// browser here with a one-time `code` in the query string. That code
// has to be exchanged for a real session — without this route, the
// email confirms/authorizes correctly on Supabase's side, but the
// visitor lands on `next` with no session at all. That's a cosmetic
// gap for signup (they can still just log in normally afterward), but
// it's fatal for password recovery: setting a new password requires
// an authenticated recovery session, which only exists once this
// exchange happens.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Missing, expired, or already-used code. Route the message to
  // wherever it's actually actionable: a broken recovery link sends
  // them straight back to "forgot password" to request a new one; any
  // other broken link (signup confirmation, invite) sends them to
  // login with a flag it can explain.
  if (next.startsWith("/reset-password")) {
    return NextResponse.redirect(`${origin}/forgot-password?expired=1`);
  }
  return NextResponse.redirect(`${origin}/login?auth_error=link_expired`);
}
