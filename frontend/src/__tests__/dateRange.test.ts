import { describe, it, expect } from 'vitest';
import {
  addMonths,
  daysBetween,
  periodLabel,
  rangeKind,
  rangesOverlap,
  shiftRange,
  startOfWeek,
} from '../lib/dateRange';

describe('daysBetween', () => {
  it('counts across a month end', () => expect(daysBetween('2024-01-30', '2024-02-02')).toBe(3));
  it('is negative when b is earlier', () => expect(daysBetween('2024-03-01', '2024-02-28')).toBe(-2));
  it('counts a leap year', () => expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366));
});

describe('startOfWeek / addMonths', () => {
  it('returns the Sunday on or before', () => {
    expect(startOfWeek('2024-06-05')).toBe('2024-06-02');
    expect(startOfWeek('2024-06-02')).toBe('2024-06-02');
  });
  it('crosses a year boundary', () => expect(startOfWeek('2025-01-01')).toBe('2024-12-29'));
  it('adds months, normalising to the 1st', () => {
    expect(addMonths('2024-11-15', 2)).toBe('2025-01-01');
    expect(addMonths('2024-01-01', -1)).toBe('2023-12-01');
  });
});

describe('rangeKind', () => {
  it('none / open', () => {
    expect(rangeKind(null, null)).toBe('none');
    expect(rangeKind('2024-06-01', null)).toBe('open');
    expect(rangeKind(null, '2024-06-01')).toBe('open');
  });
  it('day', () => expect(rangeKind('2024-02-29', '2024-03-01')).toBe('day'));
  it('week only when it starts on Sunday', () => {
    expect(rangeKind('2024-06-02', '2024-06-09')).toBe('week');
    expect(rangeKind('2024-06-03', '2024-06-10')).toBe('custom');
  });
  it('month', () => {
    expect(rangeKind('2024-02-01', '2024-03-01')).toBe('month');
    expect(rangeKind('2024-12-01', '2025-01-01')).toBe('month');
    expect(rangeKind('2024-01-01', '2024-02-01')).toBe('month');
  });
  it('year', () => expect(rangeKind('2024-01-01', '2025-01-01')).toBe('year'));
  it('custom', () => expect(rangeKind('2024-06-03', '2024-06-22')).toBe('custom'));
});

describe('shiftRange', () => {
  it('steps a day', () => expect(shiftRange('2024-02-29', '2024-03-01', 1))
    .toEqual({ from: '2024-03-01', to: '2024-03-02' }));
  it('steps a week back', () => expect(shiftRange('2024-06-02', '2024-06-09', -1))
    .toEqual({ from: '2024-05-26', to: '2024-06-02' }));
  it('steps calendar months, not 30 days', () => expect(shiftRange('2024-01-01', '2024-02-01', 1))
    .toEqual({ from: '2024-02-01', to: '2024-03-01' }));
  it('steps years', () => expect(shiftRange('2023-01-01', '2024-01-01', 2))
    .toEqual({ from: '2025-01-01', to: '2026-01-01' }));
  it('shifts a custom range by its own length', () => expect(shiftRange('2024-06-03', '2024-06-22', -1))
    .toEqual({ from: '2024-05-15', to: '2024-06-03' }));
  it('returns null for open or empty ranges', () => {
    expect(shiftRange('2024-06-03', null, 1)).toBeNull();
    expect(shiftRange(null, null, 1)).toBeNull();
  });
});

describe('rangesOverlap', () => {
  it('half-open bounds do not touch', () => {
    expect(rangesOverlap('2024-06-01', '2024-07-01', '2024-07-01', '2024-08-01')).toBe(false);
    expect(rangesOverlap('2024-06-01', '2024-07-02', '2024-07-01', '2024-08-01')).toBe(true);
  });
  it('open ends extend forever', () => {
    expect(rangesOverlap(null, '2020-01-01', '2019-01-01', '2019-02-01')).toBe(true);
    expect(rangesOverlap('2025-01-01', null, '2019-01-01', '2019-02-01')).toBe(false);
  });
});

describe('periodLabel', () => {
  it('labels each kind in English', () => {
    expect(periodLabel('2024-06-03', '2024-06-04', 'en')).toBe('Jun 3, 2024');
    expect(periodLabel('2024-06-01', '2024-07-01', 'en')).toBe('June 2024');
    expect(periodLabel('2024-01-01', '2025-01-01', 'en')).toBe('2024');
    expect(periodLabel('2024-06-02', '2024-06-09', 'en')).toBe('Jun 2 – 8, 2024');
    expect(periodLabel('2024-06-03', '2024-08-09', 'en')).toBe('Jun 3 – Aug 8, 2024');
    expect(periodLabel('2024-12-30', '2025-01-03', 'en')).toBe('Dec 30, 2024 – Jan 2, 2025');
    expect(periodLabel(null, null, 'en')).toBe('');
  });
  it('labels each kind in Japanese', () => {
    expect(periodLabel('2024-06-03', '2024-06-04', 'ja')).toBe('2024年6月3日');
    expect(periodLabel('2024-06-01', '2024-07-01', 'ja')).toBe('2024年6月');
    expect(periodLabel('2024-01-01', '2025-01-01', 'ja')).toBe('2024年');
    expect(periodLabel('2024-06-02', '2024-06-09', 'ja')).toBe('2024年6月2日～8日');
    expect(periodLabel('2024-06-03', '2024-08-09', 'ja')).toBe('2024年6月3日～8月8日');
  });
  it('labels open ranges with the inclusive end', () => {
    expect(periodLabel('2024-06-03', null, 'en')).toBe('Jun 3, 2024 –');
    expect(periodLabel(null, '2024-06-04', 'en')).toBe('– Jun 3, 2024');
  });
});
