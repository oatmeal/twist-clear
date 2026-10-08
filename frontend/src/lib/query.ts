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
  /**
   * How the search matches titles: 'fts' through the FTS5 index
   * (`c.rowid IN (… MATCH :search)`), 'like' with LIKE patterns on c.title
   * (terms under 3 characters, or a DB without clips_fts); null without one.
   */
  search: 'fts' | 'like' | null;
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
   * The DB has HINT_INDEXES, the indexes the plan helpers below name in
   * `INDEXED BY`. Built by prepare_web_db.py, but older prepared DBs may have
   * clips_fts without them.
   */
  indexHints?: boolean;
}

export function buildWhere(opts: BuildWhereOpts): WhereClause {
  const parts: string[] = [];
  const params: Record<string, string> = {};
  let search: WhereClause['search'] = null;

  if (opts.searchQuery) {
    let handled = false;

    if (opts.useFts && opts.searchQuery.length >= 3) {
      const ftsQuery = parseSearchQuery(opts.searchQuery);
      if (ftsQuery !== null) {
        // FTS5 trigram subquery: only fetches relevant index pages
        parts.push('c.rowid IN (SELECT rowid FROM clips_fts WHERE clips_fts MATCH :search)');
        params[':search'] = ftsQuery;
        handled = true;
        search = 'fts';
      } else {
        // Short terms or pure negation — try boolean LIKE before simple fallback
        const likeQuery = parseLikeSearchQuery(opts.searchQuery);
        if (likeQuery !== null) {
          parts.push(likeQuery.clause);
          Object.assign(params, likeQuery.params);
          handled = true;
          search = 'like';
        }
      }
    }

    if (!handled) {
      parts.push('c.title LIKE :search');
      params[':search'] = `%${opts.searchQuery}%`;
      search = 'like';
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
    search,
  };
}

// ── Query plans ───────────────────────────────────────────────────────────
// SQLite's own plans for a search read the clips table: for FTS,
// `c.rowid IN (SELECT rowid FROM clips_fts …)` looks up every matching row to
// read created_at or view_count, or to sort; for LIKE it scans every title.
// For a common term (or any LIKE search) that is thousands of pages, and
// sql.js-httpvfs's read-ahead turns them into ~13 MB of HTTP range requests.
// These helpers pick an `INDEXED BY` hint per query shape instead:
//   - FTS: walk an index in created_at or view_count order and probe the
//     match list, so only the rows actually returned are read.
//   - LIKE: scan clips_title (title, created_at, game_id), a quarter of the
//     table's size. It covers every aggregate, so one scan serves the count,
//     timeline, heat-map and preview strip; with few matches, the list too.
//   - Every date aggregate reads clips_created_at_game, so the timeline's
//     scan at startup leaves it cached for the calendar and preview strip.
//   - Lists with many matches walk their sort order and stop once the page
//     is full; with few, the matches are collected and sorted.
// '' leaves the choice to SQLite. Measurements are in "Query plans" in
// frontend/docs/search.md.

/**
 * Indexes the hints name, built by prepare_web_db.py. `INDEXED BY` a missing
 * index is an error, so app.ts turns hints on (indexHints) only when the DB
 * has all of them.
 */
export const HINT_INDEXES = [
  'clips_created_at_game', 'clips_view_count', 'clips_game', 'clips_game_created',
  'clips_game_views', 'clips_title',
];

/** Result counts above which walking a sort index beats collecting every match. */
export const MANY_MATCHES = 300;

function hasDateRange(opts: BuildWhereOpts): boolean {
  return opts.calDateFrom !== null || opts.calDateTo !== null;
}

/**
 * `INDEXED BY` for a COUNT or GROUP BY over the clips matching w: the result
 * count, the timeline and calendar heat-map (per day), the preview strip (per
 * game).
 */
export function aggregateHint(w: WhereClause, opts: BuildWhereOpts): string {
  if (opts.indexHints !== true) return '';
  // Covers title, created_at and game_id: no row lookups.
  if (w.search === 'like') return 'INDEXED BY clips_title';
  // With a game filter, SQLite's own plans are cheaper: a count seeks each FTS
  // match in clips_game (game_id, rowid); per day walks the game's part of
  // clips_game_created.
  if (opts.gameFilter) return '';
  // Covers created_at and game_id. Without a hint SQLite would pick the
  // smallest index holding created_at (clips_view_count), so the calendar's
  // queries would read a second index.
  return 'INDEXED BY clips_created_at_game';
}

/** `SELECT COUNT(*) AS cnt …` for the clips matching w. */
export function countSql(w: WhereClause, opts: BuildWhereOpts): string {
  if (opts.indexHints === true && w.search === 'fts'
      && !opts.gameFilter && !hasDateRange(opts) && !opts.devCutoff) {
    // Search only: count from the FTS index alone (a few pages). Its rows are
    // the clips table's (content=clips, rebuilt by prepare_web_db.py).
    return 'SELECT COUNT(*) AS cnt FROM clips_fts WHERE clips_fts MATCH :search';
  }
  return `SELECT COUNT(*) AS cnt FROM clips c ${aggregateHint(w, opts)} ${w.where}`;
}

/**
 * `INDEXED BY` for the clip list (and its page-boundary probes) in `sort`
 * order, given `matches` — the result count, which is known by then.
 */
export function listHint(w: WhereClause, opts: BuildWhereOpts, sort: SortKey, matches: number): string {
  if (opts.indexHints !== true) return '';
  const byDate = sort === 'date_desc' || sort === 'date_asc';
  const game = opts.gameFilter !== '';
  const range = hasDateRange(opts);
  if (matches > MANY_MATCHES || (w.search === null && !range)) {
    // Many matches (or all of a game's clips): walk the sort order — within
    // the game, if filtered — and stop once the page is full. A date range is
    // checked on the index (each one holds created_at).
    if (game) return byDate ? 'INDEXED BY clips_game_created' : 'INDEXED BY clips_game_views';
    return byDate ? 'INDEXED BY clips_created_at_game' : 'INDEXED BY clips_view_count';
  }
  // Few matches: collect them all, then sort.
  //   LIKE: from clips_title, which the count just read.
  //   FTS + game: seek each match in clips_game (game_id, rowid).
  //   Game + date range: that range of the game's clips.
  //   Date range: walk it in clips_created_at_game (probing FTS matches).
  //   FTS alone: SQLite's plan, a row lookup per match.
  if (w.search === 'like') return 'INDEXED BY clips_title';
  if (game) return w.search === 'fts' ? 'INDEXED BY clips_game' : 'INDEXED BY clips_game_created';
  return range ? 'INDEXED BY clips_created_at_game' : '';
}
