"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MessageSquare, CheckCircle, UsersRound } from "lucide-react";
import {
  PASSWORD_MIN_LENGTH,
  hasDigit,
  hasUppercase,
} from "@/lib/auth/password-policy";

// Small wordmark shown above the auth card so the app's identity is
// visible before a person signs in or creates an account, not just
// after (it previously only appeared as small secondary text).
function AppBrand({ appName }: { appName: string }) {
  return (
    <div className="mb-6 flex items-center gap-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
        <MessageSquare className="h-5 w-5 text-primary" />
      </span>
      <span className="text-lg font-semibold tracking-tight text-foreground">
        {appName}
      </span>
    </div>
  );
}

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const t = useTranslations("SignupPage");
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` we carry the
  // invite token in the query so it survives the signup → email
  // verification → redirect round-trip. `emailRedirectTo` below
  // points back at /join/<token> so the user lands on the redeem
  // step after verifying instead of being dropped on /dashboard.
  const inviteToken = searchParams.get("invite");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("errorPasswordMismatch"));
      return;
    }

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(t("errorPasswordTooShort", { min: PASSWORD_MIN_LENGTH }));
      return;
    }

    if (!hasUppercase(password) || !hasDigit(password)) {
      setError(t("errorPasswordTooWeak"));
      return;
    }

    setLoading(true);

    // If we have an invite token, point Supabase's verification email
    // back at the join page so the user can accept after verifying.
    // Otherwise route it through /auth/callback so the confirmation
    // link's PKCE code actually gets exchanged for a session — without
    // that, confirming still works server-side, but the visitor lands
    // logged out and has to sign in manually. Explicit here rather
    // than left undefined (Supabase's own default-redirect behaviour)
    // for the same reason the webhook URL bug taught us: don't depend
    // on dashboard config we can't see from the code.
    const emailRedirectTo = inviteToken
      ? `${window.location.origin}/join/${encodeURIComponent(inviteToken)}`
      : `${window.location.origin}/auth/callback?next=/dashboard`;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
        emailRedirectTo,
      },
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    // Supabase Auth deliberately doesn't return an error when the
    // email is already registered and confirmed — it returns a
    // "successful" signup with no error, to avoid letting an
    // attacker probe which emails have accounts. The documented way
    // to tell the two cases apart is the returned user's `identities`
    // array: it comes back empty when no new identity was actually
    // created. Without this check, someone re-submitting their own
    // email sees the same "check your email" screen as a real new
    // signup, which looks like (but isn't) a second account being
    // created.
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      setError(t("errorEmailTaken"));
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
    return (
      // No bg-background — see the note on the main return below.
      <div className="flex min-h-screen flex-col items-center justify-center px-4">
        <AppBrand appName={t("appName")} />
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              {t("successTitle")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t.rich("successDesc", {
                em: (chunks) => (
                  <span className="text-foreground">{chunks}</span>
                ),
                email,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
            >
              <Button
                variant="outline"
                className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t("backToSignIn")}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    // No bg-background here — the parent (auth) layout already paints
    // that plus the ambient-glow wash; an opaque background on this
    // child would sit in front of it in paint order and hide it.
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <AppBrand appName={t("appName")} />
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {inviteToken ? (
              <UsersRound className="h-6 w-6 text-primary" />
            ) : (
              <MessageSquare className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {inviteToken ? t("titleCreateJoin") : t("titleCreate")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {inviteToken
              ? t("descCreateJoin")
              : t("descCreate", { appName: t("appName") })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-muted-foreground">
                {t("fullNameLabel")}
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder={t("fullNamePlaceholder")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                {t("emailLabel")}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t("passwordLabel")}
              </Label>
              <Input
                id="password"
                type="password"
                placeholder={t("passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-muted-foreground">
                {t("confirmPasswordLabel")}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder={t("confirmPasswordPlaceholder")}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? t("creatingAccount") : t("createAccount")}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t("alreadyHaveAccount")}{" "}
            <Link
              href={
                inviteToken
                  ? `/login?invite=${encodeURIComponent(inviteToken)}`
                  : "/login"
              }
              className="text-primary hover:text-primary/80"
            >
              {t("signIn")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
