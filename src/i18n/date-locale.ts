"use client";

import { enUS, es, ko } from "date-fns/locale";
import type { Locale } from "date-fns";
import { useLocaleSwitcher } from "./locale-provider";

// Maps the app's own locale codes (next-intl / SWITCHABLE_LOCALES, plus
// 'ko' which exists under messages/ but isn't switchable from the UI
// yet) to the matching date-fns locale object. Used everywhere we call
// date-fns' `format`/`formatDistanceToNow` with a token that spells out
// a month or weekday name (MMM, MMMM, PP, …) — without this those always
// rendered in English regardless of the selected app language, because
// date-fns defaults to its own `enUS` locale when none is passed.
const DATE_FNS_LOCALES: Record<string, Locale> = {
  en: enUS,
  es,
  ko,
};

/** The date-fns Locale matching the currently selected app language. */
export function useDateFnsLocale(): Locale {
  const { locale } = useLocaleSwitcher();
  return DATE_FNS_LOCALES[locale] ?? enUS;
}
