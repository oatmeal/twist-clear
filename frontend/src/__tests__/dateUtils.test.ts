import { describe, it, expect } from 'vitest';
import {
  daysInMonth,
  firstDayOfMonth,
  localDateStr,
  addDays,
  weekStart,
  isoWeekNumber,
  ensureRfc3339,
} from '../lib/dateUtils';

describe('daysInMonth', () => {
  it('returns 31 for January', () => expect(daysInMonth(2024, 0)).toBe(31));
  it('returns 28 for Feb in non-leap year', () => expect(daysInMonth(2023, 1)).toBe(28));
  it('returns 29 for Feb in leap year', () => expect(daysInMonth(2024, 1)).toBe(29));
  it('returns 30 for April', () => expect(daysInMonth(2024, 3)).toBe(30));
  it('returns 31 for December', () => expect(daysInMonth(2024, 11)).toBe(31));
});

describe('firstDayOfMonth', () => {
  it('returns 1 (Monday) for 2024-01-01', () => expect(firstDayOfMonth(2024, 0)).toBe(1));
  it('returns 4 (Thursday) for 2024-02-01', () => expect(firstDayOfMonth(2024, 1)).toBe(4));
});

describe('localDateStr', () => {
  it('formats with zero-padded month and day', () => expect(localDateStr(2024, 0, 5)).toBe('2024-01-05'));
  it('formats December correctly (m=11)', () => expect(localDateStr(2024, 11, 31)).toBe('2024-12-31'));
  it('formats two-digit day without padding', () => expect(localDateStr(2024, 2, 15)).toBe('2024-03-15'));
});

describe('addDays', () => {
  it('adds days forward', () => expect(addDays('2024-01-30', 3)).toBe('2024-02-02'));
  it('subtracts days backward', () => expect(addDays('2024-03-01', -1)).toBe('2024-02-29'));
  it('handles year boundary forward', () => expect(addDays('2023-12-31', 1)).toBe('2024-01-01'));
  it('handles year boundary backward', () => expect(addDays('2024-01-01', -1)).toBe('2023-12-31'));
  it('adding zero returns same date', () => expect(addDays('2024-06-15', 0)).toBe('2024-06-15'));
});

describe('weekStart', () => {
  it('returns Monday for a Wednesday', () => expect(weekStart('2024-01-10')).toBe('2024-01-08'));
  it('returns same Monday for a Monday', () => expect(weekStart('2024-01-08')).toBe('2024-01-08'));
  it('returns previous Monday for a Sunday', () => expect(weekStart('2024-01-07')).toBe('2024-01-01'));
  it('returns previous Monday for a Tuesday', () => expect(weekStart('2024-01-09')).toBe('2024-01-08'));
  it('handles month boundary', () => expect(weekStart('2024-02-01')).toBe('2024-01-29'));
});

describe('isoWeekNumber', () => {
  // ISO week 1 is the week containing the first Thursday of the year
  it('returns 1 for 2024-01-01 (Monday)', () => expect(isoWeekNumber('2024-01-01')).toBe(1));
  it('returns 1 for 2024-01-07 (Sunday)', () => expect(isoWeekNumber('2024-01-07')).toBe(1));
  it('returns 2 for 2024-01-08 (Monday)', () => expect(isoWeekNumber('2024-01-08')).toBe(2));
  it('returns 52 for 2023-12-31', () => expect(isoWeekNumber('2023-12-31')).toBe(52));
  it('returns 53 for 2015-12-31 (year with 53 weeks)', () => expect(isoWeekNumber('2015-12-31')).toBe(53));
});

describe('ensureRfc3339', () => {
  it('appends T00:00:00Z to a date-only string', () => {
    expect(ensureRfc3339('2024-06-15')).toBe('2024-06-15T00:00:00Z');
  });

  it('passes a full ISO timestamp through unchanged', () => {
    expect(ensureRfc3339('2024-06-15T12:30:45Z')).toBe('2024-06-15T12:30:45Z');
  });

  it('passes a midnight UTC timestamp through unchanged', () => {
    expect(ensureRfc3339('2024-06-15T00:00:00Z')).toBe('2024-06-15T00:00:00Z');
  });

  it('passes a timestamp with non-zero offset through unchanged', () => {
    expect(ensureRfc3339('2024-06-15T08:00:00+09:00')).toBe('2024-06-15T08:00:00+09:00');
  });
});
