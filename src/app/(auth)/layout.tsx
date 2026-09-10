import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";

// Shared metadata for auth pages (login / signup / forgot-password).
// None of these should be indexed — they'd compete with the marketing
// landing in SERPs and offer nothing to a searcher who hasn't already
// signed up. Each page still gets its own <title> via its own
// metadata.title override below the route group layout.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    // ambient-glow here (not per-page) so every auth screen — login,
    // signup, forgot-password, reset-password, and anything added
    // later — automatically gets the same dark-mode background glow
    // as the dashboard shell, from this one shared layout.
    <div className="ambient-glow min-h-screen bg-background">
      <div className="fixed right-4 top-4 z-50">
        <LanguageSwitcher />
      </div>
      {children}
    </div>
  );
}
