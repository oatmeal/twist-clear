import { describe, it, expect } from 'vitest';
import { buildWhere } from '../lib/query';

const base = {
  searchQuery: '',
  gameFilter: '',
  calDateFrom: null,
  calDateTo: null,
  useFts: false,
  tzOffset: 0,
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
    expect(params[':search']).toBe('"pog"');
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

  it('adds date range clauses (UTC bounds at tzOffset 0)', () => {
    const { where, params } = buildWhere({
      ...base,
      calDateFrom: '2024-01-01',
      calDateTo: '2024-02-01',
    });
    expect(where).toContain(':dateFrom');
    expect(where).toContain(':dateTo');
    // localDateToUtcBound('2024-01-01', 0) = midnight UTC
    expect(params[':dateFrom']).toBe('2024-01-01T00:00:00.000Z');
    expect(params[':dateTo']).toBe('2024-02-01T00:00:00.000Z');
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
      tzOffset: 0,
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
    expect(params[':dateFrom']).toBe('2024-01-01T00:00:00.000Z');
    expect(params[':dateTo']).toBeUndefined();
  });

  it('null calDateFrom with calDateTo set: emits only the upper-bound clause', () => {
    const { where, params } = buildWhere({ ...base, calDateFrom: null, calDateTo: '2024-02-01' });
    expect(where).toContain(':dateTo');
    expect(where).not.toContain(':dateFrom');
    expect(params[':dateTo']).toBe('2024-02-01T00:00:00.000Z');
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

  it('short-term OR query uses boolean LIKE when useFts=true', () => {
    const { where, params } = buildWhere({ ...base, searchQuery: '猫 OR 犬', useFts: true });
    expect(where).toContain('LIKE');
    expect(where).not.toContain('clips_fts');
    expect(where).toContain('OR');
    expect(params[':s0']).toBe('%猫%');
    expect(params[':s1']).toBe('%犬%');
  });

  it('short-term AND query uses boolean LIKE when useFts=true', () => {
    const { where, params } = buildWhere({ ...base, searchQuery: '猫 犬', useFts: true });
    expect(where).toContain('LIKE');
    expect(where).not.toContain('clips_fts');
    expect(where).toContain('AND');
    expect(params[':s0']).toBe('%猫%');
    expect(params[':s1']).toBe('%犬%');
  });

  it('mixed short/long term OR falls back to boolean LIKE', () => {
    const { where, params } = buildWhere({ ...base, searchQuery: 'mario OR 犬', useFts: true });
    expect(where).toContain('LIKE');
    expect(where).not.toContain('clips_fts');
    expect(params[':s0']).toBe('%mario%');
    expect(params[':s1']).toBe('%犬%');
  });

  it('FTS5 + game filter + date range: all three filters combined', () => {
    const { where, params } = buildWhere({
      searchQuery: 'pog',
      gameFilter: '123',
      calDateFrom: '2024-01-01',
      calDateTo: '2024-02-01',
      useFts: true,
      tzOffset: 0,
    });
    expect(where).toContain('clips_fts');
    expect(where).toContain('game_id');
    expect(where).toContain(':dateFrom');
    expect(where).toContain(':dateTo');
    // FTS AND game AND (dateFrom AND dateTo within date clause) = ≥3 ANDs
    const andCount = (where.match(/\bAND\b/g) ?? []).length;
    expect(andCount).toBeGreaterThanOrEqual(3);
    expect(params[':search']).toBe('"pog"');
    expect(params[':game']).toBe('123');
    expect(params[':dateFrom']).toBe('2024-01-01T00:00:00.000Z');
    expect(params[':dateTo']).toBe('2024-02-01T00:00:00.000Z');
  });

  it('date range where from equals to: params are UTC ISO strings', () => {
    // At SQL level `created_at >= X AND created_at < X` matches nothing;
    // buildWhere converts both to UTC ISO bounds.
    const { params } = buildWhere({
      ...base,
      calDateFrom: '2024-06-01',
      calDateTo: '2024-06-01',
    });
    expect(params[':dateFrom']).toBe('2024-06-01T00:00:00.000Z');
    expect(params[':dateTo']).toBe('2024-06-01T00:00:00.000Z');
  });

  it('non-zero tzOffset shifts UTC bounds correctly', () => {
    // UTC-5 (-300 minutes): local midnight on Jun 15 = 2024-06-15T05:00:00Z in UTC
    const { params } = buildWhere({
      ...base,
      calDateFrom: '2024-06-15',
      calDateTo: '2024-06-16',
      tzOffset: -300,
    });
    expect(params[':dateFrom']).toBe('2024-06-15T05:00:00.000Z');
    expect(params[':dateTo']).toBe('2024-06-16T05:00:00.000Z');
  });
});

describe('buildWhere devCutoff', () => {
  it('adds created_at upper bound when devCutoff is set', () => {
    const { where, params } = buildWhere({ ...base, devCutoff: '2024-06-01T00:00:00Z' });
    expect(where).toContain('created_at <= :devCutoff');
    expect(params[':devCutoff']).toBe('2024-06-01T00:00:00Z');
  });

  it('omits the clause when devCutoff is null', () => {
    const { where, params } = buildWhere({ ...base, devCutoff: null });
    expect(where).toBe('');
    expect(params).not.toHaveProperty(':devCutoff');
  });

  it('omits the clause when devCutoff is omitted', () => {
    const { where, params } = buildWhere(base);
    expect(where).not.toContain('devCutoff');
    expect(params).not.toHaveProperty(':devCutoff');
  });

  it('combines with a game filter', () => {
    const { where, params } = buildWhere({ ...base, gameFilter: '123', devCutoff: '2024-06-01T00:00:00Z' });
    expect(where).toContain('game_id');
    expect(where).toContain('created_at <= :devCutoff');
    expect(params[':game']).toBe('123');
    expect(params[':devCutoff']).toBe('2024-06-01T00:00:00Z');
  });
});
