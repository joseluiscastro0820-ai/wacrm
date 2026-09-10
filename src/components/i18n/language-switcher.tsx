'use client';

import {
  SWITCHABLE_LOCALES,
  useLocaleSwitcher,
  type SwitchableLocale,
} from '@/i18n/locale-provider';
import { cn } from '@/lib/utils';

const OPTIONS: Record<SwitchableLocale, { flag: string; label: string }> = {
  es: { flag: '🇪🇸', label: 'ES' },
  en: { flag: '🇺🇸', label: 'EN' },
};

/**
 * Flag-pill language toggle. Two options only (see SWITCHABLE_LOCALES in
 * src/i18n/locale-provider.tsx) — switching is instant and client-side,
 * no page reload.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { locale, setLocale, switching } = useLocaleSwitcher();

  return (
    <div
      role="group"
      aria-label="Language / Idioma"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-border bg-muted p-1',
        className,
      )}
    >
      {SWITCHABLE_LOCALES.map((code) => {
        const active = locale === code;
        const { flag, label } = OPTIONS[code];
        return (
          <button
            key={code}
            type="button"
            disabled={switching}
            aria-pressed={active}
            onClick={() => setLocale(code)}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span aria-hidden="true">{flag}</span>
            {label}
          </button>
        );
      })}
    </div>
  );
}
