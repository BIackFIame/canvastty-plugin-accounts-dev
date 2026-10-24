/**
 * A quota line for people: always the used share and what is left, never a bare percent. The quota view keeps the
 * percent left (`remainingPercent`); providers report the used share (Codex `usedPercent`, Claude `utilization`), so a
 * lone "9%" reads either way.
 */
export type QuotaLocale = 'ru' | 'en';

const tenths = (value: number): number => Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
const number = (locale: QuotaLocale, value: number): string => new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 1 }).format(value);

/** "9% used · 91% left (5h)" / «использовано 9% · осталось 91% (5h)» from the percent left. */
export function quotaShareText(locale: QuotaLocale, remainingPercent: number, window: string | null = null): string {
  const left = tenths(remainingPercent);
  const used = tenths(100 - left);
  const text = locale === 'ru'
    ? `использовано ${number(locale, used)}% · осталось ${number(locale, left)}%`
    : `${number(locale, used)}% used · ${number(locale, left)}% left`;
  return window ? `${text} (${window})` : text;
}
