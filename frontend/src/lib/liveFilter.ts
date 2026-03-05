import type { LiveClip } from '../twitch';

export interface LiveFilterOpts {
  clips: LiveClip[];
  dbCutoffDate: string | null;
  calDateTo: string | null;
  calDateFrom: string | null;
  gameFilter: string;
  searchQuery: string;
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
  if (opts.dbCutoffDate && opts.calDateTo !== null && opts.calDateTo <= opts.dbCutoffDate) {
    return [];
  }

  // Apply lower date bound.
  if (opts.calDateFrom !== null) {
    const from = opts.calDateFrom;
    clips = clips.filter(c => c.created_at >= from);
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
