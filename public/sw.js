// Minimal service worker — exists only to satisfy Chrome's PWA
// installability requirement (a registered SW with a fetch handler).
// Deliberately does NOT cache anything: this app is inherently
// online-dependent (live WhatsApp/Supabase data), so an offline
// cache would risk showing stale conversations/pedidos. Every
// request just passes straight through to the network.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // No-op: let the browser handle the request normally.
});
