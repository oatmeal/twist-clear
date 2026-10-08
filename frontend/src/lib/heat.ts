// ── Calendar heat-map shades ───────────────────────────────────────────────

/** A heat-map shade: 0 (no clips) to 4 (busiest), drawn as var(--cal-N). */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** Fixed thresholds without a filter: 1–5, 6–15, 16–30, 31+ clips. */
const FIXED: [number, number, number] = [5, 15, 30];

/** Days with clips averaging more than this make fixed thresholds saturate. */
const BUSY_AVERAGE = 15;

/**
 * Quartiles of the days with clips, each at least one clip above the last:
 * a filter that leaves a clip or two a day would otherwise get thresholds
 * like [1, 1, 1], shading 1 clip lightest and 2 darkest.
 */
function relativeThresholds(nonZero: number[]): [number, number, number] {
  const sorted = [...nonZero].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? 1;
  const t1 = Math.max(1, at(0.25));
  const t2 = Math.max(t1 + 1, at(0.5));
  const t3 = Math.max(t2 + 1, at(0.75));
  return [t1, t2, t3];
}

/**
 * The shade for each day's clip count, given the counts of the days on screen.
 *
 * Without a filter the thresholds are fixed, so a busy day looks busy in any
 * month or year — unless the days with clips average more than 15, when most
 * would be the darkest shade. Then, and whenever a search or game filter is
 * active (it leaves a few clips a day, which fixed thresholds would shade all
 * alike), the thresholds are relative to the days on screen.
 */
export function heatScale(counts: number[], filtered: boolean): (cnt: number) => HeatLevel {
  const nonZero = counts.filter(c => c > 0);
  const average = nonZero.reduce((a, b) => a + b, 0) / (nonZero.length || 1);
  const [t1, t2, t3] = filtered || average > BUSY_AVERAGE ? relativeThresholds(nonZero) : FIXED;
  return cnt => (cnt <= 0 ? 0 : cnt <= t1 ? 1 : cnt <= t2 ? 2 : cnt <= t3 ? 3 : 4);
}
