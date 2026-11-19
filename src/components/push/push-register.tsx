"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import type { PluginListenerHandle } from "@capacitor/core";

/**
 * Registers this device for FCM push notifications when the app is
 * running inside the Capacitor Android shell ("Fase 2" — see
 * capacitor.config.ts). A no-op everywhere else, including the
 * installed browser PWA: `Capacitor.isNativePlatform()` is only ever
 * true inside the native shell, and that shell loads this exact same
 * Next.js app (server.url), so this component ships to every surface
 * but only acts on the one that can actually receive FCM pushes.
 *
 * Mounted once in dashboard-shell.tsx, after auth resolves — token
 * registration calls an authenticated API route
 * (/api/push/register-token), so it needs a signed-in user. Renders
 * nothing.
 */
export function PushRegister() {
  const router = useRouter();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let handles: PluginListenerHandle[] = [];
    let cancelled = false;

    (async () => {
      const current = await PushNotifications.checkPermissions();
      let status = current.receive;
      if (status === "prompt" || status === "prompt-with-rationale") {
        const requested = await PushNotifications.requestPermissions();
        status = requested.receive;
      }
      if (cancelled || status !== "granted") return;

      const registrationHandle = await PushNotifications.addListener(
        "registration",
        (token) => {
          fetch("/api/push/register-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: token.value, platform: "android" }),
          }).catch(() => {
            // Best-effort — a missed registration just means this
            // device won't get pushes until the next app start or
            // token refresh re-fires this listener.
          });
        },
      );

      const errorHandle = await PushNotifications.addListener(
        "registrationError",
        (err) => {
          console.error("[push] registration failed:", err);
        },
      );

      // Tapping a notification — deep-link into whatever path the
      // server attached as `data.path` (see src/lib/push/send-push.ts),
      // e.g. "/actions" or "/inbox?c=<conversationId>".
      const actionHandle = await PushNotifications.addListener(
        "pushNotificationActionPerformed",
        (action) => {
          const path = action.notification.data?.path;
          if (typeof path === "string" && path) router.push(path);
        },
      );

      if (cancelled) {
        registrationHandle.remove();
        errorHandle.remove();
        actionHandle.remove();
        return;
      }
      handles = [registrationHandle, errorHandle, actionHandle];

      await PushNotifications.register();
    })();

    return () => {
      cancelled = true;
      handles.forEach((h) => h.remove());
    };
  }, [router]);

  return null;
}
