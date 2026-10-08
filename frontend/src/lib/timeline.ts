// Pure geometry for the timeline overview (src/timeline.ts): binning per-day
// clip counts into weeks or months, mapping dates to pixels and back, and
// turning pointer drags into snapped [from, to) selections. No DOM, no state.

import { addDays } from './dateUtils';
import { addMonths, daysBetween, shiftRange, startOfMonth, startOfWeek } from './dateRange';

export type BinUnit = 'week' | 'month';

export interface Bin {
  start: string;  // YYYY-MM-DD, inclusive
  end: string;    // YYYY-MM-DD, exclusive
  count: number;
}

/** Narrowest week bar worth drawing; below this the overview bins by month. */
export const MIN_WEEK_PX = 3;

export function binStart(d: string, unit: BinUnit): string {
  return unit === 'week' ? startOfWeek(d) : startOfMonth(d);
}

export function nextBinStart(d: string, unit: BinUnit): string {
  return unit === 'week' ? addDays(startOfWeek(d), 7) : addMonths(d, 1);
}

/** Bin boundary nearest to d (ties round up). */
export function nearestBinBoundary(d: string, unit: BinUnit): string {
  const lo = binStart(d, unit);
  const hi = nextBinStart(d, unit);
  return daysBetween(lo, d) < daysBetween(d, hi) ? lo : hi;
}

/** Week bins when they'd be at least MIN_WEEK_PX wide, else month bins. */
export function chooseBinUnit(widthPx: number, minDate: string, maxDate: string): BinUnit {
  const weeks = Math.max(1, daysBetween(startOfWeek(minDate), maxDate) / 7);
  return widthPx / weeks >= MIN_WEEK_PX ? 'week' : 'month';
}

/** Bins covering [minDate, maxDate] (inclusive), aligned to unit boundaries. */
export function buildBins(
  minDate: string, maxDate: string, unit: BinUnit, dayCounts: ReadonlyMap<string, number>,
): Bin[] {
  const bins: Bin[] = [];
  for (let s = binStart(minDate, unit); s <= maxDate; s = nextBinStart(s, unit)) {
    bins.push({ start: s, end: nextBinStart(s, unit), count: 0 });
  }
  if (bins.length === 0) return bins;
  const first = bins[0]!.start;
  for (const [day, cnt] of dayCounts) {
    if (day < first) continue;
    // Bins are contiguous, so a binary search on start finds the bin.
    let lo = 0, hi = bins.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bins[mid]!.start <= day) lo = mid; else hi = mid - 1;
    }
    const bin = bins[lo]!;
    if (day < bin.end) bin.count += cnt;
  }
  return bins;
}

/** Linear day ↔ pixel scale over [start, end). */
export interface Scale {
  start: string;
  end: string;
  width: number;
}

export function dateToX(s: Scale, d: string): number {
  const total = daysBetween(s.start, s.end);
  return total > 0 ? (daysBetween(s.start, d) / total) * s.width : 0;
}

/** The day under pixel x, clamped to [start, end − 1 day]. */
export function xToDate(s: Scale, x: number): string {
  const total = daysBetween(s.start, s.end);
  const day = Math.floor((Math.min(Math.max(x, 0), s.width) / s.width) * total);
  return addDays(s.start, Math.min(day, total - 1));
}

/**
 * Selection made by dragging from anchor to current: both ends snap outward to
 * bin boundaries, so even a short drag selects at least one whole bin.
 */
export function rangeFromDrag(
  anchor: string, current: string, unit: BinUnit,
): { from: string; to: string } {
  const [a, b] = anchor <= current ? [anchor, current] : [current, anchor];
  return { from: binStart(a, unit), to: nextBinStart(b, unit) };
}

/**
 * Move one edge of [from, to) to the bin boundary nearest d, never letting the
 * range collapse: the moved edge stays at least one bin (or, for ranges whose
 * other edge is off-boundary, one day) away from the fixed one.
 */
export function resizeRange(
  from: string, to: string, edge: 'from' | 'to', d: string, unit: BinUnit,
): { from: string; to: string } {
  const snapped = nearestBinBoundary(d, unit);
  if (edge === 'from') {
    const limit = binStart(addDays(to, -1), unit);
    return { from: snapped <= limit ? snapped : limit, to };
  }
  const limit = nextBinStart(from, unit);
  return { from, to: snapped >= limit ? snapped : limit };
}

/**
 * Shift [from, to) by however many steps of its own kind (see shiftRange) are
 * closest to deltaDays, without moving it entirely outside [lo, hi).
 */
export function dragShift(
  from: string, to: string, deltaDays: number, lo: string, hi: string,
): { from: string; to: string } {
  const unitDays = Math.max(1, daysBetween(from, shiftRange(from, to, 1)!.from));
  let steps = Math.round(deltaDays / unitDays);
  while (steps !== 0) {
    const r = shiftRange(from, to, steps)!;
    if (r.to > lo && r.from < hi) return r;
    steps -= Math.sign(steps);
  }
  return { from, to };
}
