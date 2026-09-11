"use client";

import { useState } from "react";
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
import { KeyRound } from "lucide-react";
import {
  PASSWORD_MIN_LENGTH,
  hasDigit,
  hasUppercase,
} from "@/lib/auth/password-policy";

// Reached only via /auth/callback?next=/reset-password, after that
// route has exchanged the email link's code for a session. That
// session is what makes `updateUser({ password })` below work — a
// direct visit here with no such session fails gracefully into
// `errorNoSession` instead of silently doing nothing.
export default function ResetPasswordPage() {
  const t = useTranslations("ResetPasswordPage");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t("errorMismatch"));
      return;
    }

    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(t("errorTooShort", { min: PASSWORD_MIN_LENGTH }));
      return;
    }

    if (!hasUppercase(password) || !hasDigit(password)) {
      setError(t("errorTooWeak"));
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(t("errorNoSession"));
      setLoading(false);
      return;
    }

    // Full-page navigation so the dashboard's middleware sees the
    // refreshed session cookies — same reasoning as the login page's
    // post-signin redirect.
    window.location.href = "/dashboard";
  };

  return (
    // No bg-background here — the parent (auth) layout already paints
    // that plus the ambient-glow wash; an opaque background on this
    // child would sit in front of it in paint order and hide it.
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">
            {t("title")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("desc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                {t("newPasswordLabel")}
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
              {loading ? t("updating") : t("updatePassword")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
