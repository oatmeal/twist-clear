import * as state from './state';
import { q } from './db';
import {
  daysInMonth,
  firstDayOfMonth,
  localDateStr,
  addDays,
  isoWeekNumber,
  todayStrInOffset,
  tzToSqlModifier,
  localDateToUtcBound,
  utcTimestampToLocalDate,
} from './lib/dateUtils';
import { monthLabel, periodLabel, rangeKind, rangesOverlap, yearLabel } from './lib/dateRange';
import { t, lang } from './lib/i18n';

// ── Raw timestamp storage ─────────────────────────────────────────────────
// Stored at init time so that recomputeDateBounds() can re-derive calMinDate /
// calMaxDate for the selected timezone without another round-trip to the DB.

let _rawMinTimestamp: string | null = null;
let _rawMaxTimestamp: string | null = null;

// ── Render callback ───────────────────────────────────────────────────────
// Injected by app.ts via initCalendar() to avoid a circular import.

let _onRender: (() => Promise<void>) | null = null;

function callRender(): void {
  // Fire and forget — the AbortController in render() handles deduplication
  // when multiple rapid interactions trigger overlapping renders.
  void _onRender?.();
}

// ── Game preview strip ────────────────────────────────────────────────────

// True when the device supports hover (i.e. not a touch-only device).
// Evaluated once at module load — hover capability doesn't change mid-session.
const _supportsHover = window.matchMedia('(hover: hover)').matches;

interface GamePreviewEntry { id: string; name: string; name_ja: string; cnt: number; }
interface PeriodGames { games: GamePreviewEntry[]; totalGames: number; }

// Cache keyed by `"${utcFrom}|${utcTo}"` — avoids re-querying the same period.
const _previewCache = new Map<string, PeriodGames>();

// The default preview to revert to on mouseleave (current selection or nav position).
let _defaultPreview: { label: string; data: PeriodGames } | null = null;

// Sequence counter for hover previews — incremented on hover start and mouseleave.
// Lets async handlers detect when they've been superseded and bail out.
let _hoverSeq = 0;

// Sequence counter for the default prefetch — incremented on each renderCalendar.
// Lets a stale prefetchDefault skip its final display if a newer one has started.
let _defaultSeq = 0;

// True while a hover preview is active. Prevents prefetchDefault from overwriting
// an in-progress hover preview when the fetch completes after the hover started.
let _hovering = false;

/**
 * Called by app.ts after every game count update. Sets the default preview
 * shown in the strip when nothing is hovered and no specific day/week selection
 * overrides it. Immediately updates the strip unless a hover is in progress.
 */
export function setDefaultPreviewGames(
  games: GamePreviewEntry[],
  label: string,
): void {
  const data: PeriodGames = { games, totalGames: games.length };
  _defaultPreview = { label, data };
  if (!_hovering) displayPreview(label, data);
}

/** Seed the preview cache from game-filter results already computed by app.ts. */
export function primePreviewCache(
  utcFrom: string,
  utcTo: string,
  rows: { id: string; name: string; name_ja: string; cnt: number }[],
): void {
  const cacheKey = `${utcFrom}|${utcTo}`;
  if (_previewCache.has(cacheKey)) return; // already populated; don't overwrite
  _previewCache.set(cacheKey, {
    games: rows.map(r => ({ id: r.id, name: r.name, name_ja: r.name_ja, cnt: r.cnt })),
    totalGames: rows.length,
  });
}

/** Format a YYYY-MM-DD date string for display in the preview label. */
function formatPreviewDate(dateStr: string): string {
  const parts = dateStr.split('-');
  const d = new Date(Number(parts[0]!), Number(parts[1]!) - 1, Number(parts[2]!));
  return lang === 'ja'
    ? d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ── Bound helpers (local dates → UTC strings for preview queries) ──────────

function yearUtcBounds(y: number): [string, string] {
  return [
    localDateToUtcBound(`${y}-01-01`, state.tzOffset),
    localDateToUtcBound(`${y + 1}-01-01`, state.tzOffset),
  ];
}

function monthUtcBounds(y: number, m: number): [string, string] {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    localDateToUtcBound(`${y}-${pad(m + 1)}-01`, state.tzOffset),
    localDateToUtcBound(
      m === 11 ? `${y + 1}-01-01` : `${y}-${pad(m + 2)}-01`,
      state.tzOffset,
    ),
  ];
}

function weekUtcBounds(sundayStr: string): [string, string] {
  return [
    localDateToUtcBound(sundayStr, state.tzOffset),
    localDateToUtcBound(addDays(sundayStr, 7), state.tzOffset),
  ];
}

function dayUtcBounds(dateStr: string): [string, string] {
  return [
    localDateToUtcBound(dateStr, state.tzOffset),
    localDateToUtcBound(addDays(dateStr, 1), state.tzOffset),
  ];
}

// ── Preview DOM helpers ───────────────────────────────────────────────────

function displayPreview(label: string, data: PeriodGames): void {
  const strip = document.getElementById('cal-game-preview');
  if (!strip) return;
  strip.style.display = 'block';
  document.getElementById('cal-preview-label')!.textContent = label;

  const gamesEl = document.getElementById('cal-preview-games')!;
  gamesEl.innerHTML = '';

  const top5 = data.games.slice(0, 5);
  const maxCnt = top5[0]?.cnt ?? 1; // top5 is sorted by cnt desc

  for (const g of top5) {
    const gameName = lang === 'ja' && g.name_ja ? g.name_ja : g.name;
    const pct = Math.round((g.cnt / maxCnt) * 100);

    const row = document.createElement('div');
    row.className = 'cal-preview-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'cal-preview-name';
    nameSpan.textContent = gameName;

    const barWrap = document.createElement('span');
    barWrap.className = 'cal-preview-bar-wrap';
    const bar = document.createElement('span');
    bar.className = 'cal-preview-bar';
    bar.style.width = `${pct}%`;
    barWrap.appendChild(bar);

    const countSpan = document.createElement('span');
    countSpan.className = 'cal-preview-count';
    countSpan.textContent = g.cnt.toLocaleString();

    row.appendChild(nameSpan);
    row.appendChild(barWrap);
    row.appendChild(countSpan);
    gamesEl.appendChild(row);
  }

  if (data.totalGames > 5) {
    const more = document.createElement('div');
    more.className = 'cal-preview-more';
    more.textContent = t().calPreviewMore(data.totalGames - 5);
    gamesEl.appendChild(more);
  }
}

// ── Preview data fetching ─────────────────────────────────────────────────

async function fetchPreviewData(utcFrom: string, utcTo: string): Promise<PeriodGames> {
  const cacheKey = `${utcFrom}|${utcTo}`;
  const cached = _previewCache.get(cacheKey);
  if (cached) return cached;

  const rows = await q(
    `SELECT c.game_id, g.name, g.name_ja, COUNT(*) AS cnt
     FROM clips c
     JOIN games g ON g.id = c.game_id
     WHERE c.created_at >= :from AND c.created_at < :to
     GROUP BY c.game_id
     ORDER BY cnt DESC`,
    { ':from': utcFrom, ':to': utcTo },
  ) as { game_id: unknown; name: unknown; name_ja: unknown; cnt: unknown }[];

  const games: GamePreviewEntry[] = rows.map(r => ({
    id:      String(r.game_id ?? ''),
    name:    String(r.name ?? ''),
    name_ja: String(r.name_ja ?? ''),
    cnt:     Number(r.cnt),
  }));
  const data: PeriodGames = { games, totalGames: games.length };
  _previewCache.set(cacheKey, data);
  return data;
}

// ── Preview show/revert ───────────────────────────────────────────────────

async function showPreviewFor(utcFrom: string, utcTo: string, periodStr: string): Promise<void> {
  _hovering = true;
  const seq = ++_hoverSeq;
  // Show strip and update label immediately — leave games list intact to avoid flicker
  const strip = document.getElementById('cal-game-preview');
  if (strip) strip.style.display = 'block';
  const labelEl = document.getElementById('cal-preview-label');
  if (labelEl) labelEl.textContent = periodStr;

  const data = await fetchPreviewData(utcFrom, utcTo);
  if (seq !== _hoverSeq) return; // superseded by another hover or mouseleave

  const mergedData = mergeLiveIntoPreview(data, utcFrom, utcTo);

  // When a game filter is active, restrict the preview to that game so hover
  // counts are consistent with the heat-map (which also game-filters).
  const displayData: PeriodGames = state.gameFilter
    ? (() => {
        const filtered = mergedData.games.filter(g => g.id === state.gameFilter);
        return { games: filtered, totalGames: filtered.length };
      })()
    : mergedData;

  const total = displayData.games.reduce((s, g) => s + g.cnt, 0);
  const label = total > 0 ? `${periodStr} · ${t().clipCount(total)}` : periodStr;
  displayPreview(label, displayData);
}

function revertToDefault(): void {
  _hovering = false;
  _hoverSeq++; // cancel any in-flight hover query
  if (_defaultPreview) {
    displayPreview(_defaultPreview.label, _defaultPreview.data);
  } else {
    // No default yet (e.g. before the first render completes) — hide strip.
    const strip = document.getElementById('cal-game-preview');
    if (strip) strip.style.display = 'none';
  }
}

// ── Convenience wrappers for each period type ─────────────────────────────

function showPreviewForYear(y: number): void {
  const [from, to] = yearUtcBounds(y);
  void showPreviewFor(from, to, String(y));
}

function showPreviewForMonth(y: number, m: number): void {
  const [from, to] = monthUtcBounds(y, m);
  void showPreviewFor(from, to, `${t().monthLong[m]!} ${y}`);
}

function showPreviewForWeek(sundayStr: string): void {
  const [from, to] = weekUtcBounds(sundayStr);
  void showPreviewFor(from, to, t().weekLabel(sundayStr));
}

function showPreviewForDay(dateStr: string): void {
  const [from, to] = dayUtcBounds(dateStr);
  void showPreviewFor(from, to, formatPreviewDate(dateStr));
}

// ── Default prefetch ──────────────────────────────────────────────────────

/**
 * Determines the "default" period shown in the strip when nothing is hovered:
 * - single-day selection           → that day
 * - week selection                 → that week
 * - calMonth (month view)          → that month
 * - else (year view)               → that year
 *
 * Fetches (or hits cache) and stores in _defaultPreview, then displays it.
 * Called fire-and-forget at the end of renderCalendar().
 */
async function prefetchDefault(): Promise<void> {
  const seq = ++_defaultSeq;

  const day = selectedDay();
  const week = selectedWeek();
  if (day && !state.gameFilter) {
    // Single-day selection, no game filter: override with full day breakdown.
    // When a game filter is active, app.ts already pushed the correct filtered
    // default via setDefaultPreviewGames(); don't overwrite it here.
    const [utcFrom, utcTo] = dayUtcBounds(day);
    const periodStr = formatPreviewDate(day);
    if (!_hovering) {
      const strip = document.getElementById('cal-game-preview');
      if (strip) strip.style.display = 'block';
      const labelEl = document.getElementById('cal-preview-label');
      if (labelEl) labelEl.textContent = periodStr;
    }
    const data = await fetchPreviewData(utcFrom, utcTo);
    if (seq !== _defaultSeq) return;
    const mergedData = mergeLiveIntoPreview(data, utcFrom, utcTo);
    const total = mergedData.games.reduce((s, g) => s + g.cnt, 0);
    const label = total > 0 ? `${periodStr} · ${t().clipCount(total)}` : periodStr;
    _defaultPreview = { label, data: mergedData };
    if (!_hovering) displayPreview(label, mergedData);
  } else if (week && !state.gameFilter) {
    // Week selection, no game filter: override with full week breakdown.
    // Same reasoning as the single-day case above.
    const [utcFrom, utcTo] = weekUtcBounds(week);
    const periodStr = t().weekLabel(week);
    if (!_hovering) {
      const strip = document.getElementById('cal-game-preview');
      if (strip) strip.style.display = 'block';
      const labelEl = document.getElementById('cal-preview-label');
      if (labelEl) labelEl.textContent = periodStr;
    }
    const data = await fetchPreviewData(utcFrom, utcTo);
    if (seq !== _defaultSeq) return;
    const mergedData = mergeLiveIntoPreview(data, utcFrom, utcTo);
    const total = mergedData.games.reduce((s, g) => s + g.cnt, 0);
    const label = total > 0 ? `${periodStr} · ${t().clipCount(total)}` : periodStr;
    _defaultPreview = { label, data: mergedData };
    if (!_hovering) displayPreview(label, mergedData);
  }
  // else: no specific day/week — app.ts has already pushed the correct default
  // via setDefaultPreviewGames(); nothing to do here.
}

// ── Heat color ────────────────────────────────────────────────────────────

function heatLevel(cnt: number): 0 | 1 | 2 | 3 | 4 {
  if (!cnt)      return 0;
  if (cnt <= 5)  return 1;
  if (cnt <= 15) return 2;
  if (cnt <= 30) return 3;
  return 4;
}

function heatColor(cnt: number): string {
  return `var(--cal-${heatLevel(cnt)})`;
}

/**
 * Computes [p25, p50, p75] quantile thresholds from an array of counts,
 * ignoring zeros.  Used for relative (per-view) heat normalization so that
 * the full 0–4 scale is visible regardless of absolute clip volume.
 */
function computeHeatThresholds(counts: number[]): [number, number, number] {
  const nonZero = counts.filter(v => v > 0).sort((a, b) => a - b);
  const n = nonZero.length;
  if (n === 0) return [1, 2, 3];
  const at = (p: number) => nonZero[Math.floor((n - 1) * p)]!;
  return [at(0.25), at(0.5), at(0.75)];
}

/** Assigns a heat level 0–4 using pre-computed quantile thresholds. */
function heatLevelRelative(cnt: number, thresholds: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (cnt === 0) return 0;
  if (cnt <= thresholds[0]) return 1;
  if (cnt <= thresholds[1]) return 2;
  if (cnt <= thresholds[2]) return 3;
  return 4;
}

// ── Selection ─────────────────────────────────────────────────────────────
// The date filter (calDateFrom / calDateTo) is the selection. Everything that
// changes it goes through applyDateSelection(). Navigation (the header's ‹ ›,
// the Year / Month toggle, clicking the timeline) only moves the view
// (calYear / calMonth) and never touches the filter.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function yearRange(y: number): [string, string] {
  return [`${y}-01-01`, `${y + 1}-01-01`];
}

function monthRange(y: number, m: number): [string, string] {
  return [`${y}-${pad2(m + 1)}-01`, m === 11 ? `${y + 1}-01-01` : `${y}-${pad2(m + 2)}-01`];
}

/** The selected day, when the selection is exactly one day. */
function selectedDay(): string | null {
  return rangeKind(state.calDateFrom, state.calDateTo) === 'day' ? state.calDateFrom : null;
}

/** The selected week's Sunday, when the selection is exactly one week. */
function selectedWeek(): string | null {
  return rangeKind(state.calDateFrom, state.calDateTo) === 'week' ? state.calDateFrom : null;
}

/**
 * Set the date filter and re-render. If the calendar is open and the new
 * selection lies entirely outside what it shows (e.g. typed into the date
 * inputs or dragged on the timeline), the view moves to it at the current
 * zoom level; otherwise the view stays put.
 */
export function applyDateSelection(from: string | null, to: string | null): void {
  state.setCalDateFrom(from);
  state.setCalDateTo(to);
  syncDateInputs();
  if (state.currentView === 'calendar') {
    const [vFrom, vTo] = viewRange();
    if ((from !== null || to !== null) && !rangesOverlap(from, to, vFrom, vTo)) {
      moveViewTo(from ?? addDays(to!, -1));
    }
    void renderCalendar();
  }
  state.setCurrentPage(1);
  callRender();
}

function selectDay(dateStr: string): void {
  applyDateSelection(dateStr, addDays(dateStr, 1));
}

function selectWeek(sundayStr: string): void {
  applyDateSelection(sundayStr, addDays(sundayStr, 7));
}

/**
 * Shift-click: extend the selection to include day — moving whichever end is
 * on day's side — or select just day if nothing is selected.
 */
function extendSelectionTo(day: string): void {
  const { calDateFrom: from, calDateTo: to } = state;
  if (from === null || to === null) { selectDay(day); return; }
  if (day < from) applyDateSelection(day, to);
  else applyDateSelection(from, addDays(day, 1));
}

/** "Filter to <viewed period>": select exactly the year / month on screen. */
function selectView(): void {
  const [from, to] = viewRange();
  applyDateSelection(from, to);
}

export function clearCalDateFilter(): void {
  state.setCalDateFrom(null);
  state.setCalDateTo(null);
  syncDateInputs();
}

// ── View (navigation) ─────────────────────────────────────────────────────
// calMonth === null means the year view of calYear.

// The month to return to when zooming back in from the year view.
let _lastMonth: number | null = null;

/** [from, to) of the period on screen. */
function viewRange(): [string, string] {
  return state.calMonth === null
    ? yearRange(state.calYear)
    : monthRange(state.calYear, state.calMonth);
}

/** The period the calendar shows, or null while the panel is closed. */
export function calendarViewPeriod(): { start: string; end: string } | null {
  if (state.currentView !== 'calendar') return null;
  const [start, end] = viewRange();
  return { start, end };
}

/** Archive bounds as [year, 0-based month] pairs. */
function archiveBounds(): { minY: number; minM: number; maxY: number; maxM: number } {
  const [minY, minM] = state.calMinDate ? state.calMinDate.split('-').map(Number) as [number, number] : [0, 1];
  const [maxY, maxM] = state.calMaxDate ? state.calMaxDate.split('-').map(Number) as [number, number] : [9999, 12];
  return { minY, minM: minM - 1, maxY, maxM: maxM - 1 };
}

/** Move the view to the year / month containing date, keeping the zoom level. */
function moveViewTo(date: string): void {
  let d = date;
  if (state.calMinDate && d < state.calMinDate) d = state.calMinDate;
  if (state.calMaxDate && d > state.calMaxDate) d = state.calMaxDate;
  state.setCalYear(Number(d.slice(0, 4)));
  if (state.calMonth !== null) state.setCalMonth(Number(d.slice(5, 7)) - 1);
}

function canStep(dir: -1 | 1): boolean {
  const b = archiveBounds();
  if (state.calMonth === null) return dir < 0 ? state.calYear > b.minY : state.calYear < b.maxY;
  const idx = state.calYear * 12 + state.calMonth;
  return dir < 0 ? idx > b.minY * 12 + b.minM : idx < b.maxY * 12 + b.maxM;
}

/** The [year, month | null] that stepping in dir would show. */
function steppedView(dir: -1 | 1): [number, number | null] {
  if (state.calMonth === null) return [state.calYear + dir, null];
  const idx = state.calYear * 12 + state.calMonth + dir;
  return [Math.floor(idx / 12), idx % 12];
}

function stepView(dir: -1 | 1): void {
  if (!canStep(dir)) return;
  const [y, m] = steppedView(dir);
  state.setCalYear(y);
  state.setCalMonth(m);
  navigate();
}

/** Month to open when zooming into year y: the selection's, the last viewed, or the latest with clips. */
function monthForYear(y: number): number {
  const from = state.calDateFrom;
  if (from && Number(from.slice(0, 4)) === y) return Number(from.slice(5, 7)) - 1;
  const b = archiveBounds();
  let m = _lastMonth ?? (y === b.maxY ? b.maxM : 0);
  if (y === b.minY && m < b.minM) m = b.minM;
  if (y === b.maxY && m > b.maxM) m = b.maxM;
  return m;
}

function setLevel(level: 'year' | 'month'): void {
  if ((level === 'year') === (state.calMonth === null)) return;
  if (level === 'year') {
    _lastMonth = state.calMonth;
    state.setCalMonth(null);
  } else {
    state.setCalMonth(monthForYear(state.calYear));
  }
  navigate();
}

function zoomToMonth(m: number): void {
  state.setCalMonth(m);
  navigate();
}

/** Re-render after a navigation-only change; the filter and results are untouched. */
function navigate(): void {
  if (state.calMonth !== null) _lastMonth = state.calMonth;
  void renderCalendar();
  callRender(); // keeps the URL hash and the timeline's view underline in sync
}

/**
 * Show date in the calendar (from a click on the timeline), opening the panel
 * if it's closed. Keeps the current zoom level.
 */
export function showDateInCalendar(date: string): void {
  moveViewTo(date);
  if (state.currentView === 'calendar') navigate();
  else openPanel();
}

export function syncDateInputs(): void {
  const fromEl = document.getElementById('date-from-input') as HTMLInputElement | null;
  const toEl   = document.getElementById('date-to-input')   as HTMLInputElement | null;
  if (!fromEl || !toEl) return;

  const fromVal = state.calDateFrom ?? '';
  // calDateTo is exclusive; display inclusive by showing the day before
  const toVal = state.calDateTo ? addDays(state.calDateTo, -1) : '';

  fromEl.value = fromVal;
  toEl.value   = toVal;

  // Cross-constraint: from can't exceed to (but no absolute DB-content bound)
  if (toVal) fromEl.setAttribute('max', toVal);
  else       fromEl.removeAttribute('max');
  fromEl.removeAttribute('min');

  // Cross-constraint: to can't be before from (but no absolute DB-content bound)
  if (fromVal) toEl.setAttribute('min', fromVal);
  else         toEl.removeAttribute('min');
  toEl.removeAttribute('max');
}

// ── Live clip counts ──────────────────────────────────────────────────────
// These helpers aggregate in-memory live clips into the same bucketed formats
// as the DB queries, so they can be merged into the heat-map counts.

/** day → count for live clips falling in the given calendar year (local time). */
function liveDayCountsForYear(year: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of state.liveClips) {
    if (state.dbCutoffDate && c.created_at <= state.dbCutoffDate) continue;
    if (state.gameFilter && c.game_id !== state.gameFilter) continue;
    const day = utcTimestampToLocalDate(c.created_at, state.tzOffset);
    if (day.startsWith(`${year}-`)) {
      counts[day] = (counts[day] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Merge in-memory live clips that fall in [utcFrom, utcTo) into a DB-only
 * PeriodGames result.  Returns `data` unchanged if there are no live clips
 * in the range.  The cache is intentionally left untouched so it stays
 * DB-only and can be re-merged whenever live clips update.
 */
function mergeLiveIntoPreview(data: PeriodGames, utcFrom: string, utcTo: string): PeriodGames {
  if (state.liveClips.length === 0) return data;

  const liveCounts = new Map<string, { name: string; count: number }>();
  for (const c of state.liveClips) {
    // ISO 8601 strings are lexicographically ordered — string comparison is correct.
    if (state.dbCutoffDate && c.created_at <= state.dbCutoffDate) continue;
    if (c.created_at < utcFrom || c.created_at >= utcTo) continue;
    const entry = liveCounts.get(c.game_id);
    if (entry) { entry.count++; }
    else        { liveCounts.set(c.game_id, { name: c.game_name, count: 1 }); }
  }
  if (liveCounts.size === 0) return data;

  const merged = new Map<string, GamePreviewEntry>(data.games.map(g => [g.id, { ...g }]));
  for (const [id, { name, count }] of liveCounts) {
    const existing = merged.get(id);
    if (existing) { merged.set(id, { ...existing, cnt: existing.cnt + count }); }
    else          { merged.set(id, { id, name, name_ja: '', cnt: count }); }
  }

  const games = [...merged.values()].sort((a, b) => b.cnt - a.cnt);
  return { games, totalGames: games.length };
}

/** day → count for live clips falling in the given calendar month (local time). */
function liveDayCountsForMonth(year: number, month: number): Record<string, number> {
  const pad    = (n: number) => String(n).padStart(2, '0');
  const prefix = `${year}-${pad(month + 1)}-`;
  const counts: Record<string, number> = {};
  for (const c of state.liveClips) {
    if (state.dbCutoffDate && c.created_at <= state.dbCutoffDate) continue;
    if (state.gameFilter && c.game_id !== state.gameFilter) continue;
    const day = utcTimestampToLocalDate(c.created_at, state.tzOffset);
    if (day.startsWith(prefix)) {
      counts[day] = (counts[day] ?? 0) + 1;
    }
  }
  return counts;
}

// ── Date-range helpers ────────────────────────────────────────────────────

/**
 * Returns the effective [from, to) bounds for range highlighting.
 * When a bound is absent, it falls back to the loaded data edge
 * (calMinDate / calMaxDate) so highlighting never extends beyond available
 * clip data.  Returns { from: null, to: null } when no filter is active.
 */
function effectiveRangeBounds(): { from: string | null; to: string | null } {
  const { calDateFrom, calDateTo } = state;
  if (!calDateFrom && !calDateTo) return { from: null, to: null };
  return {
    from: calDateFrom ?? state.calMinDate,
    to:   calDateTo   ?? (state.calMaxDate ? addDays(state.calMaxDate, 1) : null),
  };
}

/**
 * True when dateStr (YYYY-MM-DD) falls within the active calendar filter range.
 * calDateTo is exclusive, matching the rest of the codebase convention.
 * Either bound may be absent; open ends are clamped to the loaded data bounds.
 */
function isInRange(dateStr: string): boolean {
  const { from, to } = effectiveRangeBounds();
  if (!from && !to) return false;
  if (from && dateStr < from) return false;
  if (to   && dateStr >= to)  return false;
  return true;
}

/**
 * Inset box-shadow that tints a whole cell with the accent colour at `pct`%
 * opacity. Derived from --accent (not a fixed colour) so it follows the
 * site palette; color-mix() is already required by the heat-map ramp.
 */
function accentTint(pct: number): string {
  return `inset 0 0 0 1000px color-mix(in srgb, var(--accent) ${pct}%, transparent)`;
}

/**
 * Compute the combined box-shadow for an in-range day cell: a perimeter
 * accent border on whichever edges are not shared with another in-range cell,
 * plus a subtle tint layer covering the whole cell.
 *
 * dayOfWeek: 0=Sun, 6=Sat — used to force left/right edges at the grid
 * boundary regardless of whether the neighbouring date is in range.
 *
 * Technique: inset box-shadows with a large spread (1000px) act as a
 * semitransparent fill without clobbering the heat-map background colour.
 * Smaller inset shadows (spread 0, blur 0, large offset) produce edge-only
 * stripes that stack in front of the fill.
 */
function inRangeBoxShadow(dateKey: string, dayOfWeek: number, borderPx = 2, tintPct = 10): string {
  const b = borderPx;
  const shadows: string[] = [];
  if (!isInRange(addDays(dateKey, -7))) shadows.push(`inset 0 ${b}px 0 0 var(--accent)`);   // top
  if (!isInRange(addDays(dateKey,  7))) shadows.push(`inset 0 -${b}px 0 0 var(--accent)`);  // bottom
  if (dayOfWeek === 0 || !isInRange(addDays(dateKey, -1))) shadows.push(`inset ${b}px 0 0 0 var(--accent)`);  // left
  if (dayOfWeek === 6 || !isInRange(addDays(dateKey,  1))) shadows.push(`inset -${b}px 0 0 0 var(--accent)`); // right
  // Tint is listed last so it renders behind the edge stripes.
  shadows.push(accentTint(tintPct));
  return shadows.join(', ');
}

/**
 * True when the entire calendar month (0-based) is covered by the active filter.
 * Used to draw the card-level border on mini-month cards in the year view — the
 * border only appears when every day of the month is included in the selection.
 * Open ends are clamped to the loaded data bounds.
 */
function monthFullyInRange(year: number, month: number): boolean {
  const { from, to } = effectiveRangeBounds();
  if (!from && !to) return false;
  const pad    = (n: number) => String(n).padStart(2, '0');
  const mStart = `${year}-${pad(month + 1)}-01`;
  const mEnd   = month === 11 ? `${year + 1}-01-01` : `${year}-${pad(month + 2)}-01`;
  if (from && mStart < from) return false;
  if (to   && mEnd   > to)   return false;
  return true;
}

// ── DB queries ────────────────────────────────────────────────────────────

async function queryYearDays(year: number): Promise<{ day: string; cnt: number }[]> {
  const mod  = tzToSqlModifier(state.tzOffset);
  const from = localDateToUtcBound(`${year}-01-01`, state.tzOffset);
  const to   = localDateToUtcBound(`${year + 1}-01-01`, state.tzOffset);
  const gameClause = state.gameFilter ? ' AND game_id = ?' : '';
  const params: (string | number)[] = [mod, from, to];
  if (state.gameFilter) params.push(state.gameFilter);
  return (await q(
    `SELECT strftime('%Y-%m-%d', created_at, ?) AS day, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?${gameClause}
     GROUP BY day`,
    params,
  )) as { day: string; cnt: number }[];
}

async function queryMonthDays(year: number, month: number): Promise<{ day: string; cnt: number }[]> {
  const pad  = (n: number) => String(n).padStart(2, '0');
  const from = localDateToUtcBound(`${year}-${pad(month + 1)}-01`, state.tzOffset);
  const to   = localDateToUtcBound(
    month === 11 ? `${year + 1}-01-01` : `${year}-${pad(month + 2)}-01`,
    state.tzOffset,
  );
  const mod  = tzToSqlModifier(state.tzOffset);
  const gameClause = state.gameFilter ? ' AND game_id = ?' : '';
  const params: (string | number)[] = [mod, from, to];
  if (state.gameFilter) params.push(state.gameFilter);
  return (await q(
    `SELECT strftime('%Y-%m-%d', created_at, ?) AS day, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?${gameClause}
     GROUP BY day`,
    params,
  )) as { day: string; cnt: number }[];
}

// ── Main calendar dispatcher ──────────────────────────────────────────────

export async function renderCalendar(): Promise<void> {
  const panel = document.getElementById('calendar-panel')!;
  panel.style.display = 'block';

  // Reset hover state so the default preview isn't suppressed by a stale flag.
  _hovering = false;
  _hoverSeq++;

  if (state.calMonth === null) {
    await renderYearView();
  } else {
    await renderMonthView();
  }

  // Show notice when a title search is active — calendar counts reflect the
  // game filter but cannot reflect the text search (no efficient aggregate index).
  const notice = document.getElementById('cal-search-notice');
  if (notice) notice.style.display = state.searchQuery ? '' : 'none';

  renderHeader();
  void prefetchDefault(); // fire-and-forget: populate the game preview strip
}

function renderHeader(): void {
  const tr = t();
  const isYear = state.calMonth === null;
  const label = isYear ? yearLabel(state.calYear, lang) : monthLabel(state.calYear, state.calMonth!, lang);
  document.getElementById('cal-title')!.textContent = label;

  const prev = document.getElementById('cal-prev') as HTMLButtonElement;
  const next = document.getElementById('cal-next') as HTMLButtonElement;
  prev.disabled = !canStep(-1);
  next.disabled = !canStep(1);
  prev.title = isYear ? tr.calPrevYear : tr.calPrevMonth;
  next.title = isYear ? tr.calNextYear : tr.calNextMonth;
  prev.setAttribute('aria-label', prev.title);
  next.setAttribute('aria-label', next.title);

  const levelGroup = document.getElementById('cal-level')!;
  levelGroup.setAttribute('aria-label', tr.calLevelGroup);
  const levelYear  = document.getElementById('cal-level-year')!;
  const levelMonth = document.getElementById('cal-level-month')!;
  levelYear.textContent  = tr.calLevelYear;
  levelMonth.textContent = tr.calLevelMonth;
  levelYear.setAttribute('aria-pressed', String(isYear));
  levelMonth.setAttribute('aria-pressed', String(!isYear));

  document.getElementById('cal-hint')!.textContent = isYear ? tr.calHintYear : tr.calHintMonth;

  const [vFrom, vTo] = viewRange();
  const selected = state.calDateFrom === vFrom && state.calDateTo === vTo;
  const btn = document.getElementById('cal-select-view') as HTMLButtonElement;
  btn.textContent = selected ? tr.calFilteredTo(label) : tr.calFilterTo(label);
  btn.disabled = selected;
  btn.classList.toggle('active', selected);
}

// ── Year view ─────────────────────────────────────────────────────────────

async function renderYearView(): Promise<void> {
  document.getElementById('cal-year-view')!.style.display  = 'grid';
  document.getElementById('cal-month-view')!.style.display = 'none';

  const year = state.calYear;
  const yearData = await queryYearDays(year);
  // Navigated elsewhere while the query ran — a newer render owns the DOM.
  if (state.calYear !== year || state.calMonth !== null) return;
  const dayMap = Object.fromEntries(yearData.map(r => [r.day, r.cnt]));

  // Merge live clip counts (live clips are always newer than the DB cutoff,
  // so they appear at the end and never overlap archived days).
  for (const [day, cnt] of Object.entries(liveDayCountsForYear(year))) {
    dayMap[day] = ((dayMap[day] as number | undefined) ?? 0) + cnt;
  }

  const monthTotals = new Array<number>(12).fill(0);
  for (const [key, cnt] of Object.entries(dayMap)) {
    monthTotals[parseInt(key.slice(5, 7), 10) - 1]! += cnt as number;
  }

  const dayCountsArr  = Object.values(dayMap) as number[];
  const nonZeroDays   = dayCountsArr.filter(v => v > 0);
  const avgDay        = nonZeroDays.length > 0
    ? nonZeroDays.reduce((a, b) => a + b, 0) / nonZeroDays.length
    : 0;
  const dayThresholds = avgDay > 15 ? computeHeatThresholds(dayCountsArr) : null;

  const container = document.getElementById('cal-year-view')!;
  container.innerHTML = '';

  // All twelve months, so each keeps its slot; months without clips are
  // dimmed and inert rather than hidden.
  for (let m = 0; m < 12; m++) {
    const total     = monthTotals[m] ?? 0;
    const totalDays = daysInMonth(year, m);
    const firstDow  = firstDayOfMonth(year, m);

    // Pre-compute for use in both the card className and the mini-day loop.
    const isFullMonth = monthFullyInRange(year, m);

    // Clicking anywhere on a card zooms into that month (navigation only);
    // dragging across its days selects a range — see onCellPointerDown().
    const card = document.createElement('div');
    card.className = 'mini-month' + (isFullMonth ? ' in-range' : '') + (total === 0 ? ' is-empty' : '');
    card.dataset['month'] = String(m);

    // The title is the card's keyboard-accessible zoom control.
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'mini-month-title';
    title.textContent = t().monthShort[m]!;
    if (total === 0) {
      title.disabled = true;
    } else {
      card.title = t().calOpenMonth(monthLabel(year, m, lang));
      title.addEventListener('click', () => zoomToMonth(m));
    }
    card.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'mini-month-grid';

    for (let e = 0; e < firstDow; e++) {
      const cell = document.createElement('div');
      cell.className = 'mini-day empty';
      grid.appendChild(cell);
    }
    for (let day = 1; day <= totalDays; day++) {
      const key  = localDateStr(year, m, day);
      const cnt  = (dayMap[key] as number | undefined) ?? 0;
      const cell = document.createElement('div');
      cell.className = 'mini-day';
      cell.dataset['date'] = key;
      const miniDayLevel = dayThresholds ? heatLevelRelative(cnt, dayThresholds) : heatLevel(cnt);
      cell.style.background = `var(--cal-${miniDayLevel})`;
      if (isInRange(key)) {
        const dayOfWeek = (firstDow + day - 1) % 7; // 0=Sun, 6=Sat
        if (isFullMonth) {
          // Card border already shows the full-month selection — just tint the
          // cells without drawing per-cell left/right column-edge borders, which
          // would create a noisy grid of vertical stripes across all week rows.
          cell.style.boxShadow = accentTint(12);
        } else {
          cell.style.boxShadow = inRangeBoxShadow(key, dayOfWeek, 2, 12);
        }
      }
      if (cnt > 0) cell.title = t().dayTooltip(key, cnt);
      grid.appendChild(cell);
    }

    card.appendChild(grid);
    if (_supportsHover && total > 0) {
      card.addEventListener('mouseenter', () => showPreviewForMonth(year, m));
      card.addEventListener('mouseleave', revertToDefault);
    }
    container.appendChild(card);
  }
}

// ── Month view ────────────────────────────────────────────────────────────

async function renderMonthView(): Promise<void> {
  document.getElementById('cal-year-view')!.style.display  = 'none';
  document.getElementById('cal-month-view')!.style.display = 'block';
  await renderMonthGrid();
}

async function renderMonthGrid(): Promise<void> {
  const year  = state.calYear;
  const month = state.calMonth!;
  const monthData = await queryMonthDays(year, month);
  // Navigated elsewhere while the query ran — a newer render owns the DOM.
  if (state.calYear !== year || state.calMonth !== month) return;
  const dayMap    = Object.fromEntries(monthData.map(r => [r.day, r.cnt]));

  // Merge live clip counts into day map.
  for (const [day, cnt] of Object.entries(liveDayCountsForMonth(state.calYear, state.calMonth!))) {
    dayMap[day] = ((dayMap[day] as number | undefined) ?? 0) + cnt;
  }

  const totalDays  = daysInMonth(state.calYear, state.calMonth!);
  const firstDow   = firstDayOfMonth(state.calYear, state.calMonth!);
  const today      = todayStrInOffset(state.tzOffset);
  const totalSlots = Math.ceil((firstDow + totalDays) / 7) * 7;

  const dayCountsArr  = Object.values(dayMap) as number[];
  const nonZeroDays   = dayCountsArr.filter(v => v > 0);
  const avgDay        = nonZeroDays.length > 0
    ? nonZeroDays.reduce((a, b) => a + b, 0) / nonZeroDays.length
    : 0;
  const dayThresholds = avgDay > 15 ? computeHeatThresholds(dayCountsArr) : null;

  const container = document.getElementById('cal-month-grid')!;
  container.innerHTML = '';

  // DOW header row
  const header = document.createElement('div');
  header.className = 'month-dow-header';
  header.appendChild(document.createElement('span')); // empty corner above week gutter
  t().dayOfWeek.forEach(label => {
    const s = document.createElement('span');
    s.textContent = label;
    header.appendChild(s);
  });
  container.appendChild(header);

  let currentRow: HTMLDivElement | null = null;

  for (let slot = 0; slot < totalSlots; slot++) {
    const col = slot % 7;
    const day = slot - firstDow + 1;

    if (col === 0) {
      currentRow = document.createElement('div');
      currentRow.className = 'month-week-row';
      container.appendChild(currentRow);

      // The Sunday that this grid row starts on (may fall outside the current
      // month). Using addDays from the 1st avoids clamping to firstRealDay,
      // which previously caused the same ISO Monday to appear on two rows when
      // a month starts on Saturday (both clamped to days with the same Monday).
      const rowSunday = addDays(localDateStr(state.calYear, state.calMonth!, 1), day - 1);
      // ISO week number: use the Monday in the row so the number is unambiguous.
      const weekNum   = isoWeekNumber(addDays(rowSunday, 1));

      const weekBtn = document.createElement('div');
      weekBtn.className = 'week-number-btn' + (selectedWeek() === rowSunday ? ' selected' : '');
      weekBtn.textContent = String(weekNum);
      weekBtn.title = t().selectWeek(weekNum, rowSunday);
      weekBtn.addEventListener('click', () => selectWeek(rowSunday));
      if (_supportsHover) {
        weekBtn.addEventListener('mouseenter', () => showPreviewForWeek(rowSunday));
        weekBtn.addEventListener('mouseleave', revertToDefault);
      }
      currentRow.appendChild(weekBtn);
    }

    const cell = document.createElement('div');

    if (day < 1 || day > totalDays) {
      cell.className = 'month-day-cell empty';
    } else {
      const dateKey = localDateStr(state.calYear, state.calMonth!, day);
      const cnt     = (dayMap[dateKey] as number | undefined) ?? 0;

      const classes = ['month-day-cell'];
      if (dateKey === today)         classes.push('today');
      if (dateKey === selectedDay()) classes.push('selected');
      cell.className = classes.join(' ');
      const dayLevel = dayThresholds ? heatLevelRelative(cnt, dayThresholds) : heatLevel(cnt);
      cell.style.background = `var(--cal-${dayLevel})`;
      cell.dataset.heat = String(dayLevel);

      // Perimeter border + tint for in-range cells.
      // dayOfWeek derived from firstDow so we avoid a Date allocation per cell.
      if (isInRange(dateKey)) {
        const dayOfWeek = (firstDow + day - 1) % 7; // 0=Sun, 6=Sat
        cell.style.boxShadow = inRangeBoxShadow(dateKey, dayOfWeek);
      }

      const numEl = document.createElement('div');
      numEl.className = 'day-number';
      numEl.textContent = String(day);
      cell.appendChild(numEl);

      if (cnt > 0) {
        const cntEl = document.createElement('div');
        cntEl.className = 'day-count';
        cntEl.textContent = t().clipCount(cnt);
        cell.appendChild(cntEl);
      }

      cell.dataset['date'] = dateKey; // click / drag: see onCellPointerDown()
      if (_supportsHover) {
        // While drag-selecting, the strip previews the dragged range instead.
        cell.addEventListener('mouseenter', () => { if (!_press?.range) showPreviewForDay(dateKey); });
        cell.addEventListener('mouseleave', () => { if (!_press?.range) revertToDefault(); });
      }
    }

    currentRow!.appendChild(cell);
  }
}

// ── View switching ────────────────────────────────────────────────────────

/**
 * Derive a sensible calendar navigation position from the current date filter:
 * - No filter → year view for the most-recent year with data
 * - Filter span ≤ 62 days → month view for the start month of the range
 * - Filter span > 62 days → year view for the midpoint year
 *
 * Called when the user opens the calendar panel so it lands somewhere relevant.
 */
function deriveNavigationPosition(): void {
  const from = state.calDateFrom;
  const to   = state.calDateTo; // exclusive upper bound

  if (!from || !to) {
    // No filter: navigate to the most recent year with data.
    const maxY = state.calMaxDate
      ? parseInt(state.calMaxDate.slice(0, 4), 10)
      : new Date().getFullYear();
    state.setCalYear(maxY);
    state.setCalMonth(null);
    return;
  }

  // Use Date.UTC to compute span in days — avoids DST-related surprises.
  const f = Date.UTC(
    parseInt(from.slice(0, 4), 10),
    parseInt(from.slice(5, 7), 10) - 1,
    parseInt(from.slice(8, 10), 10),
  );
  const t = Date.UTC(
    parseInt(to.slice(0, 4), 10),
    parseInt(to.slice(5, 7), 10) - 1,
    parseInt(to.slice(8, 10), 10),
  );
  const span = Math.round((t - f) / 86400000);

  const fromYear  = parseInt(from.slice(0, 4), 10);
  const fromMonth = parseInt(from.slice(5, 7), 10) - 1; // 0-based

  if (span <= 62) {
    // ≤ 2 months: month view for the start of the range.
    state.setCalYear(fromYear);
    state.setCalMonth(fromMonth);
  } else {
    // > 2 months: year view for the midpoint year.
    const midYear = new Date((f + t) / 2).getUTCFullYear();
    state.setCalYear(midYear);
    state.setCalMonth(null);
  }
}

function openPanel(): void {
  state.setCurrentView('calendar');
  document.getElementById('btn-view-cal')!.classList.add('active');
  if (state.calMonth !== null) _lastMonth = state.calMonth;
  void renderCalendar();
  callRender();
}

export function switchView(view: 'grid' | 'calendar'): void {
  if (view === 'grid') {
    state.setCurrentView('grid');
    document.getElementById('btn-view-cal')!.classList.remove('active');
    document.getElementById('calendar-panel')!.style.display = 'none';
    callRender();
  } else {
    deriveNavigationPosition();
    openPanel();
  }
}

// ── Day cells: click, drag, shift-click ───────────────────────────────────
// Delegated from #cal-month-grid and #cal-year-view (cells carry data-date).
//   Month view: click a day to select it.
//   Year view:  click a month card to zoom into it.
//   Both (mouse): drag across days to select a range; Shift-click extends the
//   selection to the clicked day, also across months.
// Touch only taps: a touch drag scrolls the page as usual.

interface CellPress {
  container: HTMLElement;
  anchor: string | null;   // day under the press, if any
  month: number | null;    // year view: month card under the press
  x0: number;
  y0: number;
  mouse: boolean;
  range: [string, string] | null;  // inclusive, once dragging
}

let _press: CellPress | null = null;

function dateUnder(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-date]');
  return el && _press?.container.contains(el) ? el.dataset['date']! : null;
}

function paintDragRange(range: [string, string] | null): void {
  _press?.container.querySelectorAll<HTMLElement>('[data-date]').forEach(el => {
    const d = el.dataset['date']!;
    el.classList.toggle('drag-sel', range !== null && d >= range[0] && d <= range[1]);
  });
}

function onCellPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  // The mini-month title button handles its own clicks (and keyboard).
  if (target.closest('.mini-month-title')) return;
  const card = target.closest<HTMLElement>('.mini-month');
  _press = {
    container: e.currentTarget as HTMLElement,
    anchor: target.closest<HTMLElement>('[data-date]')?.dataset['date'] ?? null,
    month: card && !card.classList.contains('is-empty') ? Number(card.dataset['month']) : null,
    x0: e.clientX,
    y0: e.clientY,
    mouse: e.pointerType !== 'touch',
    range: null,
  };
  window.addEventListener('pointermove', onCellPointerMove);
  window.addEventListener('pointerup', onCellPointerUp);
  window.addEventListener('pointercancel', endCellPress);
}

function onCellPointerMove(e: PointerEvent): void {
  const p = _press;
  if (!p || !p.mouse || !p.anchor) return;
  if (!p.range && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) <= 4) return;
  const cur = dateUnder(e.clientX, e.clientY) ?? p.range?.[1] ?? p.anchor;
  const range: [string, string] = p.anchor <= cur ? [p.anchor, cur] : [cur, p.anchor];
  if (p.range && p.range[0] === range[0] && p.range[1] === range[1]) return;
  p.range = range;
  paintDragRange(range);
  if (_supportsHover) {
    const [from, to] = [range[0], addDays(range[1], 1)];
    void showPreviewFor(
      localDateToUtcBound(from, state.tzOffset),
      localDateToUtcBound(to, state.tzOffset),
      periodLabel(from, to, lang),
    );
  }
}

function onCellPointerUp(e: PointerEvent): void {
  const p = _press;
  endCellPress();
  if (!p) return;
  if (p.range) {
    applyDateSelection(p.range[0], addDays(p.range[1], 1));
  } else if (e.shiftKey && p.anchor) {
    extendSelectionTo(p.anchor);
  } else if (p.month !== null) {
    zoomToMonth(p.month);                       // year view
  } else if (p.anchor && state.calMonth !== null) {
    selectDay(p.anchor);                        // month view
  }
}

function endCellPress(): void {
  paintDragRange(null);
  _press = null;
  window.removeEventListener('pointermove', onCellPointerMove);
  window.removeEventListener('pointerup', onCellPointerUp);
  window.removeEventListener('pointercancel', endCellPress);
}

// ── Init ──────────────────────────────────────────────────────────────────

/**
 * Recomputes calMinDate / calMaxDate from the stored raw timestamps using the
 * current timezone offset.
 * Called on init and whenever the user changes timezone.
 */
export function recomputeDateBounds(tzOff: number): void {
  if (!_rawMinTimestamp || !_rawMaxTimestamp) return;

  const minDate = utcTimestampToLocalDate(_rawMinTimestamp, tzOff);
  const maxDate = utcTimestampToLocalDate(_rawMaxTimestamp, tzOff);
  state.setCalMinDate(minDate);
  state.setCalMaxDate(maxDate);

  const minY = parseInt(minDate.slice(0, 4), 10);
  const maxY = parseInt(maxDate.slice(0, 4), 10);

  // Clamp calYear to the new valid range.
  if (state.calYear > maxY) state.setCalYear(maxY);
  else if (state.calYear < minY) state.setCalYear(minY);
}

/** Called by app.ts when the user changes the timezone setting. */
export function onTzChange(): void {
  recomputeDateBounds(state.tzOffset);
  void renderCalendar();
  callRender();
}

/**
 * Called by app.ts after live clips are fetched. If any live clip is newer
 * than the DB's max timestamp, extends _rawMaxTimestamp so that calMaxDate
 * covers those clips and the calendar year/month navigation can reach them.
 * The calendar will pick up the updated counts on its next render — app.ts
 * must call renderCalendar() if the calendar view is currently visible.
 */
export function updateLiveClipBounds(): void {
  if (state.liveClips.length === 0) return;

  let maxTs = '';
  for (const c of state.liveClips) {
    if (c.created_at > maxTs) maxTs = c.created_at;
  }
  if (!maxTs) return;

  // Only extend; never shrink the range.
  if (_rawMaxTimestamp && maxTs <= _rawMaxTimestamp) return;

  _rawMaxTimestamp = maxTs;
  recomputeDateBounds(state.tzOffset);
}

export async function initCalendar(onRender: () => Promise<void>): Promise<void> {
  _onRender = onRender;

  // Fetch raw min/max timestamps so we can derive local calendar boundaries
  // for any timezone via recomputeDateBounds().
  //
  // When the prepared DB is present, clips_meta holds precomputed values as a
  // single-row lookup — avoiding a full table scan that would trigger
  // sql.js-httpvfs's exponential read-ahead (O(n) → O(1) page reads).
  // Falls back to the live aggregate for the raw dev-symlink database.
  if (state.useMeta) {
    try {
      // Prefer the new min_timestamp / max_timestamp columns (present after
      // running the updated prepare_web_db.py).
      const row = await q('SELECT min_timestamp AS minTs, max_timestamp AS maxTs FROM clips_meta');
      if (row.length && row[0]!['minTs']) {
        _rawMinTimestamp = row[0]!['minTs'] as string;
        _rawMaxTimestamp = row[0]!['maxTs'] as string;
      }
    } catch {
      // Old prepared DB without min_timestamp — fall back to date columns.
      const row = await q('SELECT min_date AS minD, max_date AS maxD FROM clips_meta');
      if (row.length && row[0]!['minD']) {
        _rawMinTimestamp = (row[0]!['minD'] as string) + 'T00:00:00Z';
        _rawMaxTimestamp = (row[0]!['maxD'] as string) + 'T00:00:00Z';
      }
    }
  } else {
    const row = await q('SELECT MIN(created_at) AS minTs, MAX(created_at) AS maxTs FROM clips');
    if (row.length && row[0]!['minTs']) {
      _rawMinTimestamp = row[0]!['minTs'] as string;
      _rawMaxTimestamp = row[0]!['maxTs'] as string;
    }
  }

  recomputeDateBounds(state.tzOffset);

  syncDateInputs();

  const fromInput = document.getElementById('date-from-input') as HTMLInputElement;
  fromInput.addEventListener('change', () => {
    applyDateSelection(fromInput.value || null, state.calDateTo);
  });

  const toInput = document.getElementById('date-to-input') as HTMLInputElement;
  toInput.addEventListener('change', () => {
    applyDateSelection(state.calDateFrom, toInput.value ? addDays(toInput.value, 1) : null);
  });

  document.getElementById('btn-view-cal')!.addEventListener('click', () => {
    switchView(state.currentView === 'calendar' ? 'grid' : 'calendar');
  });

  document.getElementById('btn-clear-dates')!.addEventListener('click', () => {
    applyDateSelection(null, null);
  });

  const prev = document.getElementById('cal-prev')!;
  const next = document.getElementById('cal-next')!;
  prev.addEventListener('click', () => stepView(-1));
  next.addEventListener('click', () => stepView(1));
  document.getElementById('cal-level-year')!.addEventListener('click', () => setLevel('year'));
  document.getElementById('cal-level-month')!.addEventListener('click', () => setLevel('month'));
  const selectBtn = document.getElementById('cal-select-view')!;
  selectBtn.addEventListener('click', selectView);
  for (const id of ['cal-month-grid', 'cal-year-view']) {
    document.getElementById(id)!.addEventListener('pointerdown', onCellPointerDown);
  }

  if (_supportsHover) {
    // Preview the period a button would show or select. State is read at
    // event time so it reflects the current view.
    const previewView = (y: number, m: number | null): void => {
      if (m === null) showPreviewForYear(y); else showPreviewForMonth(y, m);
    };
    prev.addEventListener('mouseenter', () => { if (canStep(-1)) previewView(...steppedView(-1)); });
    next.addEventListener('mouseenter', () => { if (canStep(1)) previewView(...steppedView(1)); });
    selectBtn.addEventListener('mouseenter', () => previewView(state.calYear, state.calMonth));
    for (const el of [prev, next, selectBtn]) el.addEventListener('mouseleave', revertToDefault);
  }
}
