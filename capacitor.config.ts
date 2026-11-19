import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Agent Free's Android shell — "Fase 2" of Jose's companion-app
 * request. This app is a full dynamic Next.js app (SSR dashboard
 * routes, API routes for the WhatsApp webhook/cron/AI endpoints,
 * `output: "standalone"` in next.config.ts) — not a static SPA — so
 * it can't be bundled into the APK the way a typical Capacitor app
 * is. Instead Capacitor just gives the already-deployed, already-
 * working PWA (agent-free.vercel.app) a native Android shell: a real
 * installable app, a home-screen icon, and — the actual point of
 * this phase — access to native FCM push notifications, which no
 * browser PWA on Android can receive reliably in the background.
 *
 * Everything else (auth, realtime via Supabase, the Inbox, Acciones,
 * etc.) keeps working exactly as it does in the browser, because the
 * WebView is just loading the live site.
 */
const config: CapacitorConfig = {
  appId: "com.innovaappstudio.agentfree",
  appName: "Agent Free",
  // webDir is required by the Capacitor schema even in remote-url
  // mode; it's never actually used since nothing is bundled locally
  // (server.url below takes over at runtime). Points at an empty dir
  // placeholder so `npx cap sync` doesn't complain about a missing
  // folder.
  webDir: "capacitor-www",
  server: {
    // Load the live production site directly instead of bundling a
    // local copy — this app's server-rendered routes, API routes and
    // Supabase realtime subscriptions all need the real backend, and
    // there's nothing meaningful to statically export.
    url: "https://agent-free.vercel.app",
    androidScheme: "https",
  },
  android: {
    backgroundColor: "#020617", // matches the manifest's theme_color
  },
};

export default config;
