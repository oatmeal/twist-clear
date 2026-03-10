import type { LiveClip } from '../twitch';
import { localDateToUtcBound } from './dateUtils';

export interface LiveFilterOpts {
  clips: LiveClip[];
  dbCutoffDate: string | null;
  calDateTo: string | null;
  calDateFrom: string | null;
  gameFilter: string;
  searchQuery: string;
  tzOffset: number;
}

/**
 * Filter an array of live clips against the current UI filter state.
 *
 * Pure function — all inputs are explicit parameters; no module-level state is
 * read. This makes it fully unit-testable without DOM or DB.
 */
export function filterLiveClips(opts: LiveFilterOpts): LiveClip[] {
  let { clips } = opts;

  // Date filter: hide live clips entirely when the range ends at or before the
  // DB cutoff (the user is looking at archived history, not recent clips).
  // calDateTo is a local YYYY-MM-DD date; convert to UTC before comparing with
  // the ISO dbCutoffDate.
  const calDateToUtc = opts.calDateTo !== null
    ? localDateToUtcBound(opts.calDateTo, opts.tzOffset)
    : null;
  if (opts.dbCutoffDate && calDateToUtc !== null && calDateToUtc <= opts.dbCutoffDate) {
    return [];
  }

  // Strip clips already present in the DB. The Twitch started_at parameter is
  // inclusive, so fetchNewClips() returns the clip at exactly dbCutoffDate
  // (MAX(created_at)) even though it is already archived. Strict > excludes it.
  if (opts.dbCutoffDate) {
    clips = clips.filter(c => c.created_at > opts.dbCutoffDate!);
  }

  // Apply lower date bound (calDateFrom is a local YYYY-MM-DD date).
  if (opts.calDateFrom !== null) {
    const from = localDateToUtcBound(opts.calDateFrom, opts.tzOffset);
    clips = clips.filter(c => c.created_at >= from);
  }

  // Apply upper date bound.
  if (calDateToUtc !== null) {
    clips = clips.filter(c => c.created_at < calDateToUtc);
  }

  // Apply game filter.
  if (opts.gameFilter) {
    const g = opts.gameFilter;
    clips = clips.filter(c => c.game_id === g);
  }

  // Apply search filter (case-insensitive substring).
  if (opts.searchQuery) {
    const sq = opts.searchQuery.toLowerCase();
    clips = clips.filter(c => c.title.toLowerCase().includes(sq));
  }

  return clips;
}
