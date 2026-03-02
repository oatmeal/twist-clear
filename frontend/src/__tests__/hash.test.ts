import { describe, it, expect } from 'vitest';
import { serializeHash, deserializeHash } from '../lib/hash';
import type { HashState } from '../lib/hash';

const defaultState: HashState = {
  currentView: 'grid',
  searchQuery: '',
  sortBy: 'view_count_desc',
  gameFilter: '',
  currentPage: 1,
  calDateFrom: null,
  calDateTo: null,
  calYear: 2024,
  calMonth: null,
  calDay: null,
  calWeek: null,
};

describe('serializeHash', () => {
  it('returns empty string for fully-default state', () => {
    expect(serializeHash(defaultState)).toBe('');
  });

  it('includes non-default search query', () => {
    const hash = serializeHash({ ...defaultState, searchQuery: 'pogchamp' });
    expect(hash).toContain('q=pogchamp');
  });

  it('includes non-default page', () => {
    const hash = serializeHash({ ...defaultState, currentPage: 3 });
    expect(hash).toContain('page=3');
  });

  it('omits default sort', () => {
    expect(serializeHash(defaultState)).not.toContain('sort=');
  });

  it('includes non-default sort', () => {
    const hash = serializeHash({ ...defaultState, sortBy: 'date_asc' });
    expect(hash).toContain('sort=date_asc');
  });

  it('includes game filter', () => {
    const hash = serializeHash({ ...defaultState, gameFilter: '509658' });
    expect(hash).toContain('game=509658');
  });

  it('includes calendar view with year and month', () => {
    const hash = serializeHash({ ...defaultState, currentView: 'calendar', calYear: 2023, calMonth: 5 });
    expect(hash).toContain('view=calendar');
    expect(hash).toContain('year=2023');
    expect(hash).toContain('month=5');
  });

  it('omits calendar year/month when not in calendar view', () => {
    const hash = serializeHash({ ...defaultState, currentView: 'grid', calYear: 2023, calMonth: 5 });
    expect(hash).not.toContain('year=');
    expect(hash).not.toContain('month=');
  });

  it('includes date range filters in grid view', () => {
    const hash = serializeHash({ ...defaultState, calDateFrom: '2024-01-01', calDateTo: '2024-02-01' });
    expect(hash).toContain('from=2024-01-01');
    expect(hash).toContain('to=2024-02-01');
  });
});

describe('deserializeHash', () => {
  it('returns empty object for empty string', () => {
    expect(deserializeHash('')).toEqual({});
  });

  it('returns empty object for bare #', () => {
    expect(deserializeHash('#')).toEqual({});
  });

  it('parses search query', () => {
    const result = deserializeHash('#q=hello');
    expect(result.searchQuery).toBe('hello');
  });

  it('parses page number', () => {
    const result = deserializeHash('#page=5');
    expect(result.currentPage).toBe(5);
  });

  it('parses calendar view', () => {
    const result = deserializeHash('#view=calendar&year=2023&month=3');
    expect(result.currentView).toBe('calendar');
    expect(result.calYear).toBe(2023);
    expect(result.calMonth).toBe(3);
  });

  it('round-trips non-default state', () => {
    const original: HashState = {
      ...defaultState,
      searchQuery: 'lol',
      currentPage: 2,
      sortBy: 'date_desc',
      gameFilter: '42',
    };
    const hash = serializeHash(original);
    const parsed = deserializeHash('#' + hash);
    expect(parsed.searchQuery).toBe('lol');
    expect(parsed.currentPage).toBe(2);
    expect(parsed.sortBy).toBe('date_desc');
    expect(parsed.gameFilter).toBe('42');
  });

  it('round-trips calendar state', () => {
    const original: HashState = {
      ...defaultState,
      currentView: 'calendar',
      calYear: 2022,
      calMonth: 11,
      calDay: '2022-12-25',
    };
    const hash = serializeHash(original);
    const parsed = deserializeHash('#' + hash);
    expect(parsed.currentView).toBe('calendar');
    expect(parsed.calYear).toBe(2022);
    expect(parsed.calMonth).toBe(11);
    expect(parsed.calDay).toBe('2022-12-25');
  });
});
