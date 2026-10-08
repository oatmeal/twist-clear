import { describe, it, expect } from 'vitest';
import { aggregateHint, buildWhere, countSql, listHint, MANY_MATCHES, type BuildWhereOpts } from '../lib/query';

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

describe('query plans', () => {
  // A DB with the hinted indexes: no search, an FTS search, a LIKE search.
  const hints: BuildWhereOpts = { ...base, useFts: true, indexHints: true };
  const fts: BuildWhereOpts = { ...hints, searchQuery: 'pog' };
  const like: BuildWhereOpts = { ...hints, searchQuery: 'po' };
  const game = { gameFilter: '1' };
  const range = { calDateFrom: '2024-01-01', calDateTo: null };
  const plan = (opts: BuildWhereOpts) => ({ w: buildWhere(opts), opts });

  it('buildWhere reports how the search matches titles', () => {
    expect(buildWhere(fts).search).toBe('fts');
    expect(buildWhere(like).search).toBe('like'); // under 3 characters
    expect(buildWhere({ ...base, searchQuery: 'pog' }).search).toBe('like'); // no FTS table
    expect(buildWhere(base).search).toBe(null);
  });

  it('gives no hints without the indexes', () => {
    for (const opts of [{ ...fts, indexHints: false }, { ...like, indexHints: false }, { ...base, ...range }]) {
      const { w } = plan(opts);
      expect(aggregateHint(w, opts)).toBe('');
      expect(listHint(w, opts, 'date_desc', 10_000)).toBe('');
      expect(listHint(w, opts, 'view_count_desc', 10)).toBe('');
      expect(countSql(w, opts)).toMatch(/^SELECT COUNT\(\*\) AS cnt FROM clips c\s+WHERE/);
    }
  });

  describe('aggregateHint', () => {
    it('reads every date aggregate from clips_created_at_game, with or without an FTS search', () => {
      for (const opts of [hints, fts, { ...hints, ...range }, { ...fts, ...range }]) {
        const { w } = plan(opts);
        expect(aggregateHint(w, opts)).toBe('INDEXED BY clips_created_at_game');
      }
    });

    it('scans clips_title for a LIKE search, whatever the other filters', () => {
      for (const opts of [like, { ...like, ...game }, { ...like, ...range }]) {
        const { w } = plan(opts);
        expect(aggregateHint(w, opts)).toBe('INDEXED BY clips_title');
      }
    });

    it("leaves a game filter to SQLite's plans", () => {
      for (const opts of [{ ...hints, ...game }, { ...fts, ...game }]) {
        const { w } = plan(opts);
        expect(aggregateHint(w, opts)).toBe('');
      }
    });
  });

  describe('countSql', () => {
    it('counts a search-only FTS filter from the FTS index alone', () => {
      const { w, opts } = plan(fts);
      expect(countSql(w, opts)).toBe('SELECT COUNT(*) AS cnt FROM clips_fts WHERE clips_fts MATCH :search');
      expect(Object.keys(w.params)).toEqual([':search']);
    });

    it('counts anything else through clips, hinted like the other aggregates', () => {
      const d = plan({ ...fts, calDateFrom: '2024-01-01', calDateTo: '2024-02-01' });
      expect(countSql(d.w, d.opts)).toBe(`SELECT COUNT(*) AS cnt FROM clips c INDEXED BY clips_created_at_game ${d.w.where}`);
      const c = plan({ ...fts, devCutoff: '2024-06-01T00:00:00Z' });
      expect(countSql(c.w, c.opts)).toContain('FROM clips c INDEXED BY clips_created_at_game');
      const g = plan({ ...fts, ...game });
      expect(countSql(g.w, g.opts)).toMatch(/^SELECT COUNT\(\*\) AS cnt FROM clips c\s+WHERE/);
      const l = plan(like);
      expect(countSql(l.w, l.opts)).toBe(`SELECT COUNT(*) AS cnt FROM clips c INDEXED BY clips_title ${l.w.where}`);
    });
  });

  describe('listHint', () => {
    const many = MANY_MATCHES + 1;
    const few = MANY_MATCHES;

    it('walks the sort index when matches are many', () => {
      for (const opts of [fts, like, { ...fts, ...range }, { ...hints, ...range }]) {
        const { w } = plan(opts);
        expect(listHint(w, opts, 'date_desc', many)).toBe('INDEXED BY clips_created_at_game');
        expect(listHint(w, opts, 'date_asc', many)).toBe('INDEXED BY clips_created_at_game');
        expect(listHint(w, opts, 'view_count_desc', many)).toBe('INDEXED BY clips_view_count');
        expect(listHint(w, opts, 'view_count_asc', many)).toBe('INDEXED BY clips_view_count');
      }
    });

    it("walks the game's part of the sort index for many matches, or a game alone", () => {
      for (const [opts, n] of [[{ ...fts, ...game }, many], [{ ...like, ...game }, many], [{ ...hints, ...game }, few]] as const) {
        const { w } = plan(opts);
        expect(listHint(w, opts, 'date_desc', n)).toBe('INDEXED BY clips_game_created');
        expect(listHint(w, opts, 'view_count_desc', n)).toBe('INDEXED BY clips_game_views');
      }
    });

    it('collects few LIKE matches from clips_title', () => {
      for (const opts of [like, { ...like, ...game }, { ...like, ...range }]) {
        const { w } = plan(opts);
        expect(listHint(w, opts, 'date_desc', few)).toBe('INDEXED BY clips_title');
        expect(listHint(w, opts, 'view_count_desc', few)).toBe('INDEXED BY clips_title');
      }
    });

    it('seeks few FTS matches within a game in clips_game', () => {
      const { w, opts } = plan({ ...fts, ...game });
      expect(listHint(w, opts, 'date_desc', few)).toBe('INDEXED BY clips_game');
      expect(listHint(w, opts, 'view_count_desc', few)).toBe('INDEXED BY clips_game');
    });

    it('collects few matches in a date range from that range', () => {
      for (const opts of [{ ...fts, ...range }, { ...hints, ...range }]) {
        const { w } = plan(opts);
        expect(listHint(w, opts, 'date_desc', few)).toBe('INDEXED BY clips_created_at_game');
        expect(listHint(w, opts, 'view_count_desc', few)).toBe('INDEXED BY clips_created_at_game');
      }
      const g = plan({ ...hints, ...game, ...range });
      expect(listHint(g.w, g.opts, 'view_count_desc', few)).toBe('INDEXED BY clips_game_created');
    });

    it('leaves few FTS matches without other filters to SQLite', () => {
      const { w, opts } = plan(fts);
      expect(listHint(w, opts, 'date_desc', few)).toBe('');
      expect(listHint(w, opts, 'view_count_desc', few)).toBe('');
    });
  });
});
