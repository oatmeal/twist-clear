import { localDateToUtcBound } from './dateUtils';

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
}

export function buildWhere(opts: BuildWhereOpts): WhereClause {
  const parts: string[] = [];
  const params: Record<string, string> = {};

  if (opts.searchQuery) {
    if (opts.useFts && opts.searchQuery.length >= 3) {
      // FTS5 trigram subquery: only fetches relevant index pages
      parts.push('c.rowid IN (SELECT rowid FROM clips_fts WHERE clips_fts MATCH :search)');
      params[':search'] = opts.searchQuery;
    } else {
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

  return {
    where: parts.length ? `WHERE ${parts.join(' AND ')}` : '',
    params,
  };
}
