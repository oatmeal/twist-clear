import { describe, it, expect } from 'vitest';
import {
  buildBins,
  chooseBinUnit,
  dateToX,
  dragShift,
  nearestBinBoundary,
  rangeFromDrag,
  resizeRange,
  xToDate,
} from '../lib/timeline';

describe('buildBins', () => {
  const counts = new Map([
    ['2024-06-01', 2],  // Saturday → week of May 26
    ['2024-06-02', 3],  // Sunday   → week of Jun 2
    ['2024-06-08', 4],  // Saturday → week of Jun 2
    ['2024-07-01', 5],
  ]);

  it('aligns week bins to Sundays and sums days into them', () => {
    const bins = buildBins('2024-06-01', '2024-06-10', 'week', counts);
    expect(bins.map(b => [b.start, b.count])).toEqual([
      ['2024-05-26', 2],
      ['2024-06-02', 7],
      ['2024-06-09', 0],
    ]);
    expect(bins[2]!.end).toBe('2024-06-16');
  });

  it('builds month bins through the month containing maxDate', () => {
    const bins = buildBins('2024-05-20', '2024-07-03', 'month', counts);
    expect(bins.map(b => [b.start, b.count])).toEqual([
      ['2024-05-01', 0],
      ['2024-06-01', 9],
      ['2024-07-01', 5],
    ]);
  });

  it('ignores days outside the bins', () => {
    const bins = buildBins('2024-06-02', '2024-06-08', 'week', new Map([['2024-05-01', 9], ['2024-06-20', 9]]));
    expect(bins).toHaveLength(1);
    expect(bins[0]!.count).toBe(0);
  });
});

describe('chooseBinUnit', () => {
  it('uses weeks when bars would be wide enough', () => {
    expect(chooseBinUnit(1360, '2019-10-08', '2026-05-03')).toBe('week');
  });
  it('falls back to months on a phone', () => {
    expect(chooseBinUnit(358, '2019-10-08', '2026-05-03')).toBe('month');
  });
});

describe('scale', () => {
  const s = { start: '2024-01-01', end: '2024-01-11', width: 100 };
  it('maps dates to x linearly', () => {
    expect(dateToX(s, '2024-01-01')).toBe(0);
    expect(dateToX(s, '2024-01-06')).toBe(50);
    expect(dateToX(s, '2024-01-11')).toBe(100);
  });
  it('maps x back to the day under it, clamped', () => {
    expect(xToDate(s, 55)).toBe('2024-01-06');
    expect(xToDate(s, -10)).toBe('2024-01-01');
    expect(xToDate(s, 100)).toBe('2024-01-10');
  });
});

describe('snapping', () => {
  it('rounds to the nearest week boundary', () => {
    expect(nearestBinBoundary('2024-06-04', 'week')).toBe('2024-06-02');
    expect(nearestBinBoundary('2024-06-06', 'week')).toBe('2024-06-09');
  });

  it('drag selects whole bins in either direction', () => {
    expect(rangeFromDrag('2024-06-12', '2024-06-04', 'week'))
      .toEqual({ from: '2024-06-02', to: '2024-06-16' });
    expect(rangeFromDrag('2024-06-12', '2024-06-12', 'month'))
      .toEqual({ from: '2024-06-01', to: '2024-07-01' });
  });

  it('resizes an edge to a boundary without collapsing the range', () => {
    expect(resizeRange('2024-06-02', '2024-06-16', 'to', '2024-06-28', 'week'))
      .toEqual({ from: '2024-06-02', to: '2024-06-30' });
    expect(resizeRange('2024-06-02', '2024-06-16', 'to', '2024-05-01', 'week'))
      .toEqual({ from: '2024-06-02', to: '2024-06-09' });
    expect(resizeRange('2024-06-02', '2024-06-16', 'from', '2024-07-01', 'week'))
      .toEqual({ from: '2024-06-09', to: '2024-06-16' });
  });
});

describe('dragShift', () => {
  const lo = '2019-10-01';
  const hi = '2026-06-01';
  it('moves a month by calendar months', () => {
    expect(dragShift('2024-06-01', '2024-07-01', 62, lo, hi))
      .toEqual({ from: '2024-08-01', to: '2024-09-01' });
  });
  it('moves a day by days', () => {
    expect(dragShift('2024-06-03', '2024-06-04', -3, lo, hi))
      .toEqual({ from: '2024-05-31', to: '2024-06-01' });
  });
  it('stops before leaving the archive entirely', () => {
    expect(dragShift('2026-01-01', '2027-01-01', 800, lo, hi))
      .toEqual({ from: '2026-01-01', to: '2027-01-01' });
  });
});
