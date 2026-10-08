// Date-filter selection semantics, shared by the calendar and the timeline
// overview. A selection is a [from, to) pair of YYYY-MM-DD local dates with an
// exclusive end (calDateFrom / calDateTo in state.ts); either end may be null.
//
// The selection's "kind" (day, week, month, …) is derived from the dates rather
// than stored, so a range typed into the date inputs behaves exactly like the
// same range clicked in the calendar.

import { addDays } from './dateUtils';
import type { Lang } from './i18n';

export type RangeKind = 'none' | 'open' | 'day' | 'week' | 'month' | 'year' | 'custom';

function parts(d: string): [number, number, number] {
  return d.split('-').map(Number) as [number, number, number];
}

function ymd(y: number, m: number, d: number): string {
  // m is 1-based here; normalise overflow via Date.UTC.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** Whole days from a to b (b − a); both YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** Day of week, 0 = Sunday. */
export function dayOfWeek(d: string): number {
  const [y, m, dd] = parts(d);
  return new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
}

/** The Sunday on or before d (calendar rows and week selections start on Sunday). */
export function startOfWeek(d: string): string {
  return addDays(d, -dayOfWeek(d));
}

export function startOfMonth(d: string): string {
  return d.slice(0, 8) + '01';
}

/** First day of the month n months after the month containing d. */
export function addMonths(d: string, n: number): string {
  const [y, m] = parts(d);
  return ymd(y, m + n, 1);
}

export function rangeKind(from: string | null, to: string | null): RangeKind {
  if (from === null && to === null) return 'none';
  if (from === null || to === null) return 'open';
  if (to === addDays(from, 1)) return 'day';
  if (dayOfWeek(from) === 0 && to === addDays(from, 7)) return 'week';
  if (from.endsWith('-01-01') && to === addMonths(from, 12)) return 'year';
  if (from.endsWith('-01') && to === addMonths(from, 1)) return 'month';
  return 'custom';
}

/**
 * Shift a closed selection by `steps` of its own kind: days for a day, weeks
 * for a week, calendar months / years for months / years, and the range's own
 * length for a custom range ("previous period"). Returns null for open or
 * empty selections, which have no length to step by.
 */
export function shiftRange(
  from: string | null, to: string | null, steps: number,
): { from: string; to: string } | null {
  if (from === null || to === null) return null;
  switch (rangeKind(from, to)) {
    case 'month': return { from: addMonths(from, steps), to: addMonths(to, steps) };
    case 'year':  return { from: addMonths(from, 12 * steps), to: addMonths(to, 12 * steps) };
    default: {
      const len = daysBetween(from, to);
      return { from: addDays(from, steps * len), to: addDays(to, steps * len) };
    }
  }
}

/** True when [from, to) overlaps [lo, hi) — open ends extend to infinity. */
export function rangesOverlap(
  from: string | null, to: string | null, lo: string, hi: string,
): boolean {
  return (from === null || from < hi) && (to === null || to > lo);
}

// ── Labels ────────────────────────────────────────────────────────────────

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const EN_MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];

function dayLabel(d: string, lang: Lang): string {
  const [y, m, dd] = parts(d);
  return lang === 'ja' ? `${y}年${m}月${dd}日` : `${EN_MONTHS[m - 1]} ${dd}, ${y}`;
}

/** Inclusive day range, collapsing the shared year / month. */
function dayRangeLabel(a: string, b: string, lang: Lang): string {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  if (lang === 'ja') {
    if (ay !== by) return `${dayLabel(a, lang)}～${dayLabel(b, lang)}`;
    if (am !== bm) return `${ay}年${am}月${ad}日～${bm}月${bd}日`;
    return `${ay}年${am}月${ad}日～${bd}日`;
  }
  if (ay !== by) return `${dayLabel(a, lang)} – ${dayLabel(b, lang)}`;
  if (am !== bm) return `${EN_MONTHS[am - 1]} ${ad} – ${EN_MONTHS[bm - 1]} ${bd}, ${ay}`;
  return `${EN_MONTHS[am - 1]} ${ad} – ${bd}, ${ay}`;
}

export function monthLabel(y: number, m0: number, lang: Lang): string {
  return lang === 'ja' ? `${y}年${m0 + 1}月` : `${EN_MONTHS_LONG[m0]} ${y}`;
}

export function yearLabel(y: number, lang: Lang): string {
  return lang === 'ja' ? `${y}年` : String(y);
}

/**
 * Human label for a [from, to) selection: "Jun 3, 2024", "June 2024", "2024",
 * "Jun 2 – 8, 2024"; open ends render as "Jun 3, 2024 –" / "– Jun 3, 2024".
 */
export function periodLabel(from: string | null, to: string | null, lang: Lang): string {
  const sep = lang === 'ja' ? '～' : ' – ';
  switch (rangeKind(from, to)) {
    case 'none':  return '';
    case 'open':  return from !== null
      ? `${dayLabel(from, lang)}${sep}`.trimEnd()
      : `${sep}${dayLabel(addDays(to!, -1), lang)}`.trimStart();
    case 'day':   return dayLabel(from!, lang);
    case 'month': { const [y, m] = parts(from!); return monthLabel(y, m - 1, lang); }
    case 'year':  return yearLabel(parts(from!)[0], lang);
    default:      return dayRangeLabel(from!, addDays(to!, -1), lang);
  }
}
