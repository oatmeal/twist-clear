// All functions use integer-argument Date constructors to avoid UTC/local
// timezone pitfalls that arise when parsing 'YYYY-MM-DD' strings directly.

export function daysInMonth(y: number, m: number): number {
  // new Date(y, m+1, 0) = last day of month m (0-based)
  return new Date(y, m + 1, 0).getDate();
}

export function firstDayOfMonth(y: number, m: number): number {
  return new Date(y, m, 1).getDay(); // 0=Sun
}

export function localDateStr(y: number, m: number, d: number): string {
  // m is 0-based
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addDays(dateStr: string, n: number): string {
  const parts = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(parts[0], parts[1] - 1, parts[2] + n);
  return localDateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

export function todayStr(): string {
  const t = new Date();
  return localDateStr(t.getFullYear(), t.getMonth(), t.getDate());
}

export function weekStart(dateStr: string): string {
  // Returns the Monday of the ISO week containing dateStr.
  const parts = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(parts[0], parts[1] - 1, parts[2]);
  const dow = dt.getDay(); // 0=Sun
  const diff = dow === 0 ? 6 : dow - 1; // days back to Monday
  dt.setDate(dt.getDate() - diff);
  return localDateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

export function isoWeekNumber(dateStr: string): number {
  const parts = dateStr.split('-').map(Number) as [number, number, number];
  const dt = new Date(parts[0], parts[1] - 1, parts[2]);
  // Set to nearest Thursday (ISO week rule)
  const dayNum = dt.getDay() || 7;
  dt.setDate(dt.getDate() + 4 - dayNum);
  const yearStart = new Date(dt.getFullYear(), 0, 1);
  return Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Ensures a date string carries a time component, as required by Twitch's
 * started_at parameter (RFC 3339). Date-only strings from clips_meta.max_date
 * (YYYY-MM-DD) get 'T00:00:00Z' appended; full timestamps pass through unchanged.
 */
export function ensureRfc3339(date: string): string {
  return date.includes('T') ? date : `${date}T00:00:00Z`;
}

// ── Timezone helpers ──────────────────────────────────────────────────────────
// offsetMinutes convention: positive = east of UTC (UTC+5 → +300, UTC-5 → -300).
// This is the negation of Date.prototype.getTimezoneOffset(), which uses the
// opposite sign convention.

/** Returns the browser's current UTC offset in minutes (east = positive). */
export function browserTzOffset(): number {
  return -new Date().getTimezoneOffset();
}

/**
 * Returns a SQLite strftime modifier string for the given offset, e.g.
 * '+330 minutes' (UTC+5:30) or '-300 minutes' (UTC-5).
 */
export function tzToSqlModifier(offsetMinutes: number): string {
  return (offsetMinutes >= 0 ? '+' : '') + offsetMinutes + ' minutes';
}

/**
 * Converts a YYYY-MM-DD local date to the UTC ISO timestamp of midnight in
 * the given timezone offset.
 * e.g. '2024-06-15' at UTC-5 (-300) → '2024-06-15T05:00:00.000Z'
 */
export function localDateToUtcBound(dateStr: string, offsetMinutes: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) - offsetMinutes * 60000).toISOString();
}

/**
 * Converts a UTC ISO timestamp to a local YYYY-MM-DD date string in the given
 * timezone offset.
 * e.g. '2024-06-15T02:00:00Z' at UTC-5 (-300) → '2024-06-14'
 */
export function utcTimestampToLocalDate(ts: string, offsetMinutes: number): string {
  const shifted = new Date(new Date(ts).getTime() + offsetMinutes * 60000);
  return [
    shifted.getUTCFullYear(),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** Returns today's date as YYYY-MM-DD in the given timezone offset. */
export function todayStrInOffset(offsetMinutes: number): string {
  return utcTimestampToLocalDate(new Date().toISOString(), offsetMinutes);
}
