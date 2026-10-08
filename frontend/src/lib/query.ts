import { localDateToUtcBound } from './dateUtils';
import { parseSearchQuery, parseLikeSearchQuery } from './searchParser';

export type SortKey = 'view_count_desc' | 'view_count_asc' | 'date_desc' | 'date_asc';

export const ORDER: Record<SortKey, string> = {
  view_count_desc: 'c.view_count DESC, c.created_at DESC',
  view_count_asc: 'c.view_count ASC, c.created_at ASC',
  date_desc: 'c.created_at DESC',
  date_asc: 'c.created_at ASC',
};

export interface WhereClause {
  where: string;
  params: Record<string, string>;
  /** The search uses the FTS5 index (`c.rowid IN (… MATCH :search)`). */
  fts: boolean;
}

export interface BuildWhereOpts {
  searchQuery: string;
  gameFilter: string;
  calDateFrom: string | null;
  calDateTo: string | null;
  useFts: boolean;
  tzOffset: number;
  devCutoff?: string | null;
  /**
   * The DB has the indexes the plan helpers below name in `INDEXED BY`
   * (clips_created_at, clips_created_at_game, clips_view_count). Built by
   * prepare_web_db.py, but older prepared DBs may have clips_fts without them.
   */
  indexHints?: boolean;
}

export function buildWhere(opts: BuildWhereOpts): WhereClause {
  const parts: string[] = [];
  const params: Record<string, string> = {};
  let fts = false;

  if (opts.searchQuery) {
    let handled = false;

    if (opts.useFts && opts.searchQuery.length >= 3) {
      const ftsQuery = parseSearchQuery(opts.searchQuery);
      if (ftsQuery !== null) {
        // FTS5 trigram subquery: only fetches relevant index pages
        parts.push('c.rowid IN (SELECT rowid FROM clips_fts WHERE clips_fts MATCH :search)');
        params[':search'] = ftsQuery;
        handled = true;
        fts = true;
      } else {
        // Short terms or pure negation — try boolean LIKE before simple fallback
        const likeQuery = parseLikeSearchQuery(opts.searchQuery);
        if (likeQuery !== null) {
          parts.push(likeQuery.clause);
          Object.assign(params, likeQuery.params);
          handled = true;
        }
      }
    }

    if (!handled) {
      parts.push('c.title LIKE :search');
      params[':search'] = `%${opts.searchQuery}%`;
    }
  }

  if (opts.gameFilter) {
    parts.push('c.game_id = :game');
    params[':game'] = opts.gameFilter;
  }

  if (opts.calDateFrom !== null && opts.calDateTo !== null) {
    parts.push('c.created_at >= :dateFrom AND c.created_at < :dateTo');
    params[':dateFrom'] = localDateToUtcBound(opts.calDateFrom, opts.tzOffset);
    params[':dateTo']   = localDateToUtcBound(opts.calDateTo,   opts.tzOffset);
  } else if (opts.calDateFrom !== null) {
    parts.push('c.created_at >= :dateFrom');
    params[':dateFrom'] = localDateToUtcBound(opts.calDateFrom, opts.tzOffset);
  } else if (opts.calDateTo !== null) {
    parts.push('c.created_at < :dateTo');
    params[':dateTo']   = localDateToUtcBound(opts.calDateTo, opts.tzOffset);
  }

  if (opts.devCutoff) {
    parts.push('c.created_at <= :devCutoff');
    params[':devCutoff'] = opts.devCutoff;
  }

  return {
    where: parts.length ? `WHERE ${parts.join(' AND ')}` : '',
    params,
    fts,
  };
}

// ── Query plans for FTS searches ──────────────────────────────────────────
// SQLite's own plan for `c.rowid IN (SELECT rowid FROM clips_fts …)` looks up
// every matching row in the clips table. For a common term that is thousands
// of scattered pages, and sql.js-httpvfs's read-ahead turns them into ~13 MB
// of HTTP range requests (for りりまる, ~3,100 matches). Walking an index in
// created_at or view_count order and probing the match list instead reads the
// index plus the rows actually returned. These helpers pick an `INDEXED BY`
// hint per query shape; '' leaves the choice to SQLite, which is right without
// a search, and for rare terms (a handful of row lookups beats walking a whole
// index). Page counts measured with the sqlite3 CLI's `.stats` are in
// frontend/docs/search.md.

/** Result counts above which walking a sort index beats looking up every match. */
export const MANY_MATCHES = 300;

function hintsApply(w: WhereClause, opts: BuildWhereOpts): boolean {
  return w.fts && opts.indexHints === true;
}

function hasDateRange(opts: BuildWhereOpts): boolean {
  return opts.calDateFrom !== null || opts.calDateTo !== null;
}

/** `INDEXED BY` for a per-day GROUP BY (timeline, calendar heat-map). */
export function byDayHint(w: WhereClause, opts: BuildWhereOpts): string {
  // With a game filter, SQLite's own plan (clips_game_created) is cheaper.
  return hintsApply(w, opts) && !opts.gameFilter ? 'INDEXED BY clips_created_at' : '';
}

/** `INDEXED BY` for a per-game GROUP BY over a date range (calendar preview strip). */
export function byGameHint(w: WhereClause, opts: BuildWhereOpts): string {
  // Covering: the probe needs only rowid, created_at and game_id.
  return hintsApply(w, opts) && !opts.gameFilter ? 'INDEXED BY clips_created_at_game' : '';
}

/** `SELECT COUNT(*) AS cnt …` for the clips matching w. */
export function countSql(w: WhereClause, opts: BuildWhereOpts): string {
  if (hintsApply(w, opts) && !opts.gameFilter && !hasDateRange(opts) && !opts.devCutoff) {
    // Search only: count from the FTS index alone (a few pages). Its rows are
    // the clips table's (content=clips, rebuilt by prepare_web_db.py).
    return 'SELECT COUNT(*) AS cnt FROM clips_fts WHERE clips_fts MATCH :search';
  }
  return `SELECT COUNT(*) AS cnt FROM clips c ${byDayHint(w, opts)} ${w.where}`;
}

/**
 * `INDEXED BY` for the clip list (and its page-boundary probes) in `sort`
 * order, given `matches` — the result count, which is known by then.
 */
export function listHint(w: WhereClause, opts: BuildWhereOpts, sort: SortKey, matches: number): string {
  if (!hintsApply(w, opts)) return '';
  const byDate = sort === 'date_desc' || sort === 'date_asc';
  const many = matches > MANY_MATCHES;
  if (opts.gameFilter) {
    // clips_game_created already walks one game's clips in date order, or
    // just a date range of them; only a view sort over many matches does
    // better by walking views.
    return !byDate && many && !hasDateRange(opts) ? 'INDEXED BY clips_view_count' : '';
  }
  // Walk dates in order and stop once the page is full; a date range bounds
  // the walk even when matches are rare.
  if (byDate) return many || hasDateRange(opts) ? 'INDEXED BY clips_created_at' : '';
  // View sorts: walk views when matches are dense enough to fill a page
  // quickly (the index covers created_at for a date range), else collect the
  // range's matches from the date index and sort those.
  if (many) return 'INDEXED BY clips_view_count';
  return hasDateRange(opts) ? 'INDEXED BY clips_created_at' : '';
}
