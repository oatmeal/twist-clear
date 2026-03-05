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
