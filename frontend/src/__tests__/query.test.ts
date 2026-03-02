import { describe, it, expect } from 'vitest';
import { buildWhere } from '../lib/query';

const base = {
  searchQuery: '',
  gameFilter: '',
  calDateFrom: null,
  calDateTo: null,
  useFts: false,
};

describe('buildWhere', () => {
  it('returns empty WHERE and params when no filters', () => {
    const { where, params } = buildWhere(base);
    expect(where).toBe('');
    expect(params).toEqual({});
  });

  it('adds LIKE clause for a search query', () => {
    const { where, params } = buildWhere({ ...base, searchQuery: 'pog' });
    expect(where).toContain('LIKE');
    expect(where).toContain('WHERE');
    expect(params[':search']).toBe('%pog%');
  });

  it('uses LIKE for <3-char query even when useFts=true', () => {
    const { where, params } = buildWhere({ ...base, searchQuery: 'hi', useFts: true });
    expect(where).toContain('LIKE');
    expect(where).not.toContain('clips_fts');
    expect(params[':search']).toBe('%hi%');
  });

  it('uses LIKE for 1-char query even when useFts=true', () => {
    const { where } = buildWhere({ ...base, searchQuery: 'a', useFts: true });
    expect(where).toContain('LIKE');
    expect(where).not.toContain('clips_fts');
  });

  it('uses FTS5 subquery for >=3-char query when useFts=true', () => {
    const { where, params } = buildWhere({ ...base, searchQuery: 'pog', useFts: true });
    expect(where).toContain('clips_fts');
    expect(where).toContain('MATCH');
    expect(where).not.toContain('LIKE');
    expect(params[':search']).toBe('pog');
  });

  it('uses FTS5 for exactly 3 chars', () => {
    const { where } = buildWhere({ ...base, searchQuery: 'abc', useFts: true });
    expect(where).toContain('clips_fts');
  });

  it('adds game_id filter', () => {
    const { where, params } = buildWhere({ ...base, gameFilter: '123' });
    expect(where).toContain('game_id');
    expect(params[':game']).toBe('123');
  });

  it('adds date range clauses', () => {
    const { where, params } = buildWhere({
      ...base,
      calDateFrom: '2024-01-01',
      calDateTo: '2024-02-01',
    });
    expect(where).toContain(':dateFrom');
    expect(where).toContain(':dateTo');
    expect(params[':dateFrom']).toBe('2024-01-01');
    expect(params[':dateTo']).toBe('2024-02-01');
  });

  it('combines search and game filter with AND', () => {
    const { where } = buildWhere({ ...base, searchQuery: 'test', gameFilter: '999' });
    expect(where).toContain('AND');
    expect(where).toContain('LIKE');
    expect(where).toContain('game_id');
  });

  it('combines search, game, and date filters', () => {
    const { where } = buildWhere({
      searchQuery: 'clip',
      gameFilter: '1',
      calDateFrom: '2024-01-01',
      calDateTo: '2024-02-01',
      useFts: false,
    });
    // Should have WHERE and two AND connectors
    const andCount = (where.match(/\bAND\b/g) ?? []).length;
    expect(andCount).toBeGreaterThanOrEqual(2);
  });
});
