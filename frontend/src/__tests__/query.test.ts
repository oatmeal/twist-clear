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

describe('buildWhere filter interactions', () => {
  it('calDateFrom with null calDateTo: emits only the lower-bound clause', () => {
    const { where, params } = buildWhere({ ...base, calDateFrom: '2024-01-01', calDateTo: null });
    expect(where).toContain(':dateFrom');
    expect(where).not.toContain(':dateTo');
    expect(params[':dateFrom']).toBe('2024-01-01');
    expect(params[':dateTo']).toBeUndefined();
  });

  it('null calDateFrom with calDateTo set: emits only the upper-bound clause', () => {
    const { where, params } = buildWhere({ ...base, calDateFrom: null, calDateTo: '2024-02-01' });
    expect(where).toContain(':dateTo');
    expect(where).not.toContain(':dateFrom');
    expect(params[':dateTo']).toBe('2024-02-01');
    expect(params[':dateFrom']).toBeUndefined();
  });

  it('LIKE search: % in query is not escaped and acts as a SQL wildcard', () => {
    // User types "100%" → :search becomes "%100%%" → SQL LIKE "%100%%" matches
    // anything containing "100" followed by zero or more chars. The inner % is
    // not treated as a literal percent sign.
    const { params } = buildWhere({ ...base, searchQuery: '100%' });
    expect(params[':search']).toBe('%100%%');
  });

  it('LIKE search: _ in query is not escaped and acts as a single-char wildcard', () => {
    // User types "h_llo" → SQL LIKE "%h_llo%" matches "hello", "hallo", etc.,
    // not only the literal string containing underscore.
    const { params } = buildWhere({ ...base, searchQuery: 'h_llo' });
    expect(params[':search']).toBe('%h_llo%');
  });

  it('gameFilter "0" is a truthy string and generates a WHERE clause', () => {
    // Game IDs are strings; "0" is falsy in some languages but truthy in JS/TS.
    const { where, params } = buildWhere({ ...base, gameFilter: '0' });
    expect(where).toContain('game_id');
    expect(params[':game']).toBe('0');
  });

  it('FTS5 + game filter + date range: all three filters combined', () => {
    const { where, params } = buildWhere({
      searchQuery: 'pog',
      gameFilter: '123',
      calDateFrom: '2024-01-01',
      calDateTo: '2024-02-01',
      useFts: true,
    });
    expect(where).toContain('clips_fts');
    expect(where).toContain('game_id');
    expect(where).toContain(':dateFrom');
    expect(where).toContain(':dateTo');
    // FTS AND game AND (dateFrom AND dateTo within date clause) = ≥3 ANDs
    const andCount = (where.match(/\bAND\b/g) ?? []).length;
    expect(andCount).toBeGreaterThanOrEqual(3);
    expect(params[':search']).toBe('pog');
    expect(params[':game']).toBe('123');
    expect(params[':dateFrom']).toBe('2024-01-01');
    expect(params[':dateTo']).toBe('2024-02-01');
  });

  it('date range where from equals to: params are set as provided', () => {
    // At SQL level `created_at >= X AND created_at < X` matches nothing;
    // buildWhere passes the values through unchanged.
    const { params } = buildWhere({
      ...base,
      calDateFrom: '2024-06-01',
      calDateTo: '2024-06-01',
    });
    expect(params[':dateFrom']).toBe('2024-06-01');
    expect(params[':dateTo']).toBe('2024-06-01');
  });
});
