"use client";

import { useEffect } from "react";

/**
 * Registers public/sw.js so Chrome considers the app installable
 * (desktop "Install app" on Windows, "Add to Home screen" on
 * Android) — a manifest alone (src/app/manifest.ts) isn't enough,
 * Chrome also requires a controlling service worker.
 *
 * Renders nothing; mount once near the root. Best-effort — a
 * registration failure (unsupported browser, blocked by an
 * extension, etc.) just means no install prompt, never a broken app.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Best-effort — see component doc.
    });
  }, []);

  return null;
}
