export interface HashState {
  currentView: 'grid' | 'calendar';
  searchQuery: string;
  sortBy: string;
  gameFilter: string;
  currentPage: number;
  calDateFrom: string | null;
  calDateTo: string | null;
  calYear: number;
  calMonth: number | null;
  calDay: string | null;
  calWeek: string | null;
}

// Serialize app state into a URLSearchParams string. Default values are
// omitted to keep URLs short.
export function serializeHash(s: HashState): string {
  const p = new URLSearchParams();

  if (s.currentView === 'calendar') p.set('view', 'calendar');
  if (s.searchQuery) p.set('q', s.searchQuery);
  if (s.sortBy !== 'date_desc') p.set('sort', s.sortBy);
  if (s.gameFilter) p.set('game', s.gameFilter);
  if (s.currentPage > 1) p.set('page', String(s.currentPage));

  if (s.calDateFrom !== null) p.set('from', s.calDateFrom);
  if (s.calDateTo !== null) p.set('to', s.calDateTo);

  if (s.currentView === 'calendar') {
    p.set('year', String(s.calYear));
    if (s.calMonth !== null) p.set('month', String(s.calMonth));
    if (s.calDay !== null) p.set('day', s.calDay);
    if (s.calWeek !== null) p.set('week', s.calWeek);
  }

  return p.toString();
}

// Parse a hash string into a partial state. Returns only fields that were
// present in the hash; callers apply defaults for missing fields.
export function deserializeHash(hashStr: string): Partial<HashState> {
  if (!hashStr || hashStr === '#') return {};
  const p = new URLSearchParams(hashStr.replace(/^#/, ''));
  const result: Partial<HashState> = {};

  const view = p.get('view');
  if (view === 'calendar') result.currentView = 'calendar';
  else if (view === null && !p.has('view')) result.currentView = 'grid';

  const q = p.get('q');
  if (q !== null) result.searchQuery = q;

  const sort = p.get('sort');
  if (sort !== null) result.sortBy = sort;

  const game = p.get('game');
  if (game !== null) result.gameFilter = game;

  const page = p.get('page');
  if (page !== null) result.currentPage = parseInt(page, 10);

  const from = p.get('from');
  if (from !== null) result.calDateFrom = from;

  const to = p.get('to');
  if (to !== null) result.calDateTo = to;

  const year = p.get('year');
  if (year !== null) result.calYear = parseInt(year, 10);

  const month = p.get('month');
  if (month !== null) result.calMonth = parseInt(month, 10);

  const day = p.get('day');
  if (day !== null) result.calDay = day;

  const week = p.get('week');
  if (week !== null) result.calWeek = week;

  return result;
}
