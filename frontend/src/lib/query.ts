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
}

export interface BuildWhereOpts {
  searchQuery: string;
  gameFilter: string;
  calDateFrom: string | null;
  calDateTo: string | null;
  useFts: boolean;
  tzOffset: number;
  devCutoff?: string | null;
}

export function buildWhere(opts: BuildWhereOpts): WhereClause {
  const parts: string[] = [];
  const params: Record<string, string> = {};

  if (opts.searchQuery) {
    let handled = false;

    if (opts.useFts && opts.searchQuery.length >= 3) {
      const ftsQuery = parseSearchQuery(opts.searchQuery);
      if (ftsQuery !== null) {
        // FTS5 trigram subquery: only fetches relevant index pages
        parts.push('c.rowid IN (SELECT rowid FROM clips_fts WHERE clips_fts MATCH :search)');
        params[':search'] = ftsQuery;
        handled = true;
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
  };
}
