import { describe, it, expect } from 'vitest';
import { serializeHash, deserializeHash } from '../lib/hash';
import type { HashState } from '../lib/hash';

const defaultState: HashState = {
  currentView: 'grid',
  clipLayout: 'grid',
  searchQuery: '',
  sortBy: 'date_desc',
  gameFilter: '',
  currentPage: 1,
  calDateFrom: null,
  calDateTo: null,
  calYear: 2024,
  calMonth: null,
  calDay: null,
  calWeek: null,
  tzOffset: 0,
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

  it('calDateFrom without calDateTo: only from= is emitted', () => {
    const hash = serializeHash({ ...defaultState, calDateFrom: '2024-03-01', calDateTo: null });
    expect(hash).toContain('from=2024-03-01');
    expect(hash).not.toContain('to=');
  });

  it('includes calWeek in calendar view', () => {
    const hash = serializeHash({ ...defaultState, currentView: 'calendar', calYear: 2024, calWeek: '2024-W05' });
    expect(hash).toContain('week=2024-W05');
  });

  it('omits calWeek when not in calendar view', () => {
    const hash = serializeHash({ ...defaultState, calWeek: '2024-W05' });
    expect(hash).not.toContain('week=');
  });

  it('URL-encodes special chars in search query and decodes round-trip', () => {
    // URLSearchParams handles encoding; check the raw string contains 'q=' and
    // that a parse recovers the original value.
    const query = 'hello & world=yes%20no';
    const hash = serializeHash({ ...defaultState, searchQuery: query });
    expect(hash).toContain('q=');
    const recovered = new URLSearchParams(hash).get('q');
    expect(recovered).toBe(query);
  });

  it('omits layout=grid (default)', () => {
    expect(serializeHash(defaultState)).not.toContain('layout=');
  });

  it('includes layout=list for list layout', () => {
    const hash = serializeHash({ ...defaultState, clipLayout: 'list' });
    expect(hash).toContain('layout=list');
  });

  it('calDateTo stores the exclusive upper bound verbatim', () => {
    // The UI shows Jan 31 as the end date but the stored value is Feb 1
    // (exclusive). serializeHash emits what it's given.
    const hash = serializeHash({ ...defaultState, calDateFrom: '2024-01-01', calDateTo: '2024-02-01' });
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
      sortBy: 'view_count_asc',
      gameFilter: '42',
    };
    const hash = serializeHash(original);
    const parsed = deserializeHash('#' + hash);
    expect(parsed.searchQuery).toBe('lol');
    expect(parsed.currentPage).toBe(2);
    expect(parsed.sortBy).toBe('view_count_asc');
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

  it('round-trips calWeek in calendar view', () => {
    const original: HashState = {
      ...defaultState,
      currentView: 'calendar',
      calYear: 2024,
      calWeek: '2024-W10',
    };
    const hash = serializeHash(original);
    const parsed = deserializeHash('#' + hash);
    expect(parsed.calWeek).toBe('2024-W10');
    expect(parsed.calYear).toBe(2024);
  });

  it('round-trips URL-encoded search query', () => {
    const query = 'hello & world=yes%20no';
    const hash = serializeHash({ ...defaultState, searchQuery: query });
    const parsed = deserializeHash('#' + hash);
    expect(parsed.searchQuery).toBe(query);
  });

  it('ignores unknown hash params', () => {
    const result = deserializeHash('#q=test&unknown=blah&extra=123');
    expect(result.searchQuery).toBe('test');
    expect(Object.keys(result)).not.toContain('unknown');
    expect(Object.keys(result)).not.toContain('extra');
  });

  it('invalid page number parses to NaN', () => {
    // parseInt('notanumber', 10) returns NaN; callers should guard against this.
    const result = deserializeHash('#page=notanumber');
    expect(result.currentPage).toBeNaN();
  });

  it('calDay and calWeek both present: both fields are deserialized', () => {
    const result = deserializeHash('#view=calendar&year=2024&day=2024-01-15&week=2024-W03');
    expect(result.calDay).toBe('2024-01-15');
    expect(result.calWeek).toBe('2024-W03');
  });

  it('view=grid explicitly in hash: currentView not set (caller applies default)', () => {
    // deserializeHash only recognizes 'calendar' as a named view; 'grid' and
    // other values leave currentView absent so the caller can apply its default.
    const result = deserializeHash('#view=grid');
    expect(result.currentView).toBeUndefined();
  });
});
