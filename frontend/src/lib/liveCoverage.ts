import type { LiveClip } from '../twitch';

/** Default minimum bisection window: 10 minutes in milliseconds. */
export const DEFAULT_MIN_WINDOW_MS = 10 * 60_000;

/**
 * Callback type for fetching clips in a single time window.
 * Returns the clips found and whether there are more (>100) in the window.
 */
export type FetchWindow = (
  startedAt: string,
  endedAt: string,
) => Promise<{ clips: LiveClip[]; hasMore: boolean }>;

/** Round a Date down to the nearest 10-minute boundary (UTC). */
export function align10min(date: Date): Date {
  const d = new Date(date.getTime());
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10, 0, 0);
  return d;
}

/**
 * Recursively bisect [from, to) to achieve 0-clip coverage.
 *
 * At each level we query the API. If the response is empty (0 clips),
 * the range is proven clear and we stop. Otherwise we collect unique clips
 * and — if the window is wider than minWindowMs — bisect into two halves
 * and recurse.
 *
 * Pure function: the actual API call is injected via `fetchWindow`.
 */
export async function bisectCoverage(
  fetchWindow: FetchWindow,
  from:        Date,
  to:          Date,
  minWindowMs: number,
  results:     LiveClip[],
  seen:        Set<string>,
): Promise<void> {
  if (from >= to) return;

  const { clips, hasMore } = await fetchWindow(from.toISOString(), to.toISOString());

  if (clips.length === 0 && !hasMore) return;

  for (const c of clips) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      results.push(c);
    }
  }

  const windowMs = to.getTime() - from.getTime();
  if (windowMs <= minWindowMs) return;

  // Bisect at an aligned 10-minute boundary.
  let mid = align10min(new Date(from.getTime() + windowMs / 2));
  if (mid <= from) mid = new Date(from.getTime() + minWindowMs);
  if (mid >= to) return;

  await bisectCoverage(fetchWindow, from, mid, minWindowMs, results, seen);
  await bisectCoverage(fetchWindow, mid, to, minWindowMs, results, seen);
}

/**
 * Fetch all clips in [sinceDate, now) using 0-clip coverage bisection.
 *
 * Uses the same strategy as the Python scraper's `backfill` command:
 * recursively bisects time ranges until every sub-range is covered by a
 * query returning 0 clips, catching clips hidden by Twitch's bucket
 * quantization and same-video suppression.
 */
export async function fetchWithCoverage(
  fetchWindow:      FetchWindow,
  sinceDate:        string,
  minWindowMinutes: number = 10,
): Promise<LiveClip[]> {
  const from = new Date(sinceDate);
  const to   = new Date();
  const results: LiveClip[] = [];
  const seen = new Set<string>();

  await bisectCoverage(fetchWindow, from, to, minWindowMinutes * 60_000, results, seen);

  return results;
}
