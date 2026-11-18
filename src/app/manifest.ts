import type { MetadataRoute } from "next";
import { getLocale, getTranslations } from "next-intl/server";

/**
 * Makes the app installable (Chrome's "Install app" prompt on
 * Windows/desktop and "Add to Home screen" on Android) — see
 * src/components/pwa-register.tsx for the service worker that's
 * also required for installability, registered from the root layout.
 *
 * Dynamic (uses next-intl's request-time getLocale/getTranslations),
 * so Next serves this per-request rather than caching one static
 * manifest for every locale — fine at this app's scale.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: "Manifest" });

  return {
    name: t("name"),
    short_name: t("shortName"),
    description: t("description"),
    start_url: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
