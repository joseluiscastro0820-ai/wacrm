'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { NextIntlClientProvider } from 'next-intl';

// Locales offered through the visible language switcher. Kept separate
// from whatever locale the deployment defaults to (NEXT_PUBLIC_APP_LOCALE,
// read server-side in src/i18n/request.ts) — a locale can exist under
// messages/ (e.g. `ko`) without being reachable from this picker yet.
export const SWITCHABLE_LOCALES = ['es', 'en'] as const;
export type SwitchableLocale = (typeof SWITCHABLE_LOCALES)[number];

const STORAGE_KEY = 'wacrm-locale';

interface LocaleContextValue {
  locale: string;
  switching: boolean;
  setLocale: (next: SwitchableLocale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function useLocaleSwitcher(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error('useLocaleSwitcher must be used within LocaleProvider');
  }
  return ctx;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadMessages(locale: string): Promise<any> {
  try {
    return (await import(`../../messages/${locale}.json`)).default;
  } catch {
    return (await import(`../../messages/en.json`)).default;
  }
}

/**
 * Wraps NextIntlClientProvider with a locale the visitor can change at
 * runtime, entirely client-side — no page reload, no server round trip.
 *
 * Why client-side rather than a cookie the server reads: this app's
 * pages (including the auth funnel) are statically prerendered per
 * next.config.ts's caching strategy. Making the *server* locale depend
 * on a per-request cookie would force every route using next-intl to
 * render dynamically, losing that caching app-wide for the sake of a
 * language toggle. Swapping `messages` in client state avoids that
 * entirely: the server still renders `defaultLocale` (from
 * NEXT_PUBLIC_APP_LOCALE) for the first paint and for visitors who never
 * touch the switcher, and a saved choice is applied right after mount.
 */
export function LocaleProvider({
  defaultLocale,
  defaultMessages,
  children,
}: {
  defaultLocale: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultMessages: any;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState(defaultLocale);
  const [messages, setMessages] = useState(defaultMessages);
  const [switching, setSwitching] = useState(false);

  const applyLocale = useCallback(
    (next: string, persist: boolean) => {
      setLocaleState((current) => {
        if (current === next) return current;
        setSwitching(true);
        loadMessages(next)
          .then((nextMessages) => {
            setMessages(nextMessages);
            setLocaleState(next);
            if (persist) {
              try {
                localStorage.setItem(STORAGE_KEY, next);
              } catch {
                // Private browsing / storage disabled — the pick just
                // won't survive a reload. Not worth surfacing to the user.
              }
            }
          })
          .finally(() => setSwitching(false));
        return current;
      });
    },
    [],
  );

  // Pick up a previously-saved choice once, on mount. If the visitor
  // never used the switcher, `defaultLocale` from the server stands.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && (SWITCHABLE_LOCALES as readonly string[]).includes(saved)) {
        applyLocale(saved, false);
      }
    } catch {
      // Storage unavailable — stay on the server default.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback(
    (next: SwitchableLocale) => applyLocale(next, true),
    [applyLocale],
  );

  // Keep <html lang> in sync so screen readers and browser features
  // (spellcheck, translate prompts) reflect the chosen language, not
  // just the server's original default.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(
    () => ({ locale, switching, setLocale }),
    [locale, switching, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>
      <NextIntlClientProvider messages={messages} locale={locale}>
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}
