export function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtDuration(secs: number): string {
  const s = Math.round(secs);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtViews(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function fmtDate(iso: string, tzOffset = 0): string {
  // Shift the UTC timestamp by the selected timezone offset, then render as
  // UTC — equivalent to displaying in the target timezone.
  const shifted = new Date(new Date(iso).getTime() + tzOffset * 60000);
  return shifted.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function fmtDateTime(iso: string, locale?: string, tzOffset = 0): string {
  const shifted = new Date(new Date(iso).getTime() + tzOffset * 60000);
  return shifted.toLocaleString(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
