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

  // When a game filter is active, restrict the preview to that game so hover
  // counts are consistent with the heat-map (which also game-filters).
  const displayData: PeriodGames = state.gameFilter
    ? (() => {
        const filtered = data.games.filter(g => g.id === state.gameFilter);
        return { games: filtered, totalGames: filtered.length };
      })()
    : data;

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
 * - calDay (single-day selection)  → that day
 * - calWeek (week selection)       → that week
 * - calMonth (month view)          → that month
 * - else (year view)               → that year
 *
 * Fetches (or hits cache) and stores in _defaultPreview, then displays it.
 * Called fire-and-forget at the end of renderCalendar().
 */
async function prefetchDefault(): Promise<void> {
  const seq = ++_defaultSeq;

  if (state.calDay && !state.gameFilter) {
    // Single-day selection, no game filter: override with full day breakdown.
    // When a game filter is active, app.ts already pushed the correct filtered
    // default via setDefaultPreviewGames(); don't overwrite it here.
    const [utcFrom, utcTo] = dayUtcBounds(state.calDay);
    const periodStr = formatPreviewDate(state.calDay);
    if (!_hovering) {
      const strip = document.getElementById('cal-game-preview');
      if (strip) strip.style.display = 'block';
      const labelEl = document.getElementById('cal-preview-label');
      if (labelEl) labelEl.textContent = periodStr;
    }
    const data = await fetchPreviewData(utcFrom, utcTo);
    if (seq !== _defaultSeq) return;
    const total = data.games.reduce((s, g) => s + g.cnt, 0);
    const label = total > 0 ? `${periodStr} · ${t().clipCount(total)}` : periodStr;
    _defaultPreview = { label, data };
    if (!_hovering) displayPreview(label, data);
  } else if (state.calWeek && !state.gameFilter) {
    // Week selection, no game filter: override with full week breakdown.
    // Same reasoning as calDay above.
    const [utcFrom, utcTo] = weekUtcBounds(state.calWeek);
    const periodStr = t().weekLabel(state.calWeek);
    if (!_hovering) {
      const strip = document.getElementById('cal-game-preview');
      if (strip) strip.style.display = 'block';
      const labelEl = document.getElementById('cal-preview-label');
      if (labelEl) labelEl.textContent = periodStr;
    }
    const data = await fetchPreviewData(utcFrom, utcTo);
    if (seq !== _defaultSeq) return;
    const total = data.games.reduce((s, g) => s + g.cnt, 0);
    const label = total > 0 ? `${periodStr} · ${t().clipCount(total)}` : periodStr;
    _defaultPreview = { label, data };
    if (!_hovering) displayPreview(label, data);
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

// ── Date filter helpers ───────────────────────────────────────────────────

function setYearFilter(y: number): void {
  state.setCalDateFrom(`${y}-01-01`);
  state.setCalDateTo(`${y + 1}-01-01`);
  syncDateInputs();
}

function setMonthFilter(y: number, m: number): void {
  const pad = (n: number) => String(n).padStart(2, '0');
  state.setCalDateFrom(`${y}-${pad(m + 1)}-01`);
  state.setCalDateTo(
    m === 11 ? `${y + 1}-01-01` : `${y}-${pad(m + 2)}-01`,
  );
  syncDateInputs();
}

export function clearCalDateFilter(): void {
  state.setCalDay(null);
  state.setCalWeek(null);
  state.setCalDateFrom(null);
  state.setCalDateTo(null);
  syncDateInputs();
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
    if (state.gameFilter && c.game_id !== state.gameFilter) continue;
    const day = utcTimestampToLocalDate(c.created_at, state.tzOffset);
    if (day.startsWith(`${year}-`)) {
      counts[day] = (counts[day] ?? 0) + 1;
    }
  }
  return counts;
}

/** YYYY → count for live clips, keyed by year (local time). */
function liveYearCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of state.liveClips) {
    if (state.gameFilter && c.game_id !== state.gameFilter) continue;
    const yr = utcTimestampToLocalDate(c.created_at, state.tzOffset).slice(0, 4);
    counts[yr] = (counts[yr] ?? 0) + 1;
  }
  return counts;
}

/** YYYY-MM → count for live clips falling in the given calendar year (local time). */
function liveMonthCountsForYear(year: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of state.liveClips) {
    if (state.gameFilter && c.game_id !== state.gameFilter) continue;
    const day = utcTimestampToLocalDate(c.created_at, state.tzOffset);
    if (day.startsWith(`${year}-`)) {
      const month = day.slice(0, 7);
      counts[month] = (counts[month] ?? 0) + 1;
    }
  }
  return counts;
}

/** day → count for live clips falling in the given calendar month (local time). */
function liveDayCountsForMonth(year: number, month: number): Record<string, number> {
  const pad    = (n: number) => String(n).padStart(2, '0');
  const prefix = `${year}-${pad(month + 1)}-`;
  const counts: Record<string, number> = {};
  for (const c of state.liveClips) {
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
function inRangeBoxShadow(dateKey: string, dayOfWeek: number, borderPx = 2, tintOpacity = 0.10): string {
  const b = borderPx;
  const shadows: string[] = [];
  if (!isInRange(addDays(dateKey, -7))) shadows.push(`inset 0 ${b}px 0 0 var(--accent)`);   // top
  if (!isInRange(addDays(dateKey,  7))) shadows.push(`inset 0 -${b}px 0 0 var(--accent)`);  // bottom
  if (dayOfWeek === 0 || !isInRange(addDays(dateKey, -1))) shadows.push(`inset ${b}px 0 0 0 var(--accent)`);  // left
  if (dayOfWeek === 6 || !isInRange(addDays(dateKey,  1))) shadows.push(`inset -${b}px 0 0 0 var(--accent)`); // right
  // Tint is listed last so it renders behind the edge stripes.
  shadows.push(`inset 0 0 0 1000px rgba(145, 71, 255, ${tintOpacity})`);
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

/**
 * True when the calendar year overlaps the active filter range at all.
 * Used to highlight year-strip pills that touch the selection.
 * Open ends are clamped to the loaded data bounds.
 */
function yearOverlapsRange(year: number): boolean {
  const { from, to } = effectiveRangeBounds();
  if (!from && !to) return false;
  const yStart = `${year}-01-01`;
  const yEnd   = `${year + 1}-01-01`;
  if (from && to) return from < yEnd && to > yStart;
  if (from)       return yEnd  > from;
  if (to)         return yStart < to;
  return false;
}

/**
 * True when the calendar month (0-based) overlaps the active filter range at all.
 * Used to highlight year-strip pills that touch the selection.
 * Open ends are clamped to the loaded data bounds.
 */
function monthOverlapsRange(year: number, month: number): boolean {
  const { from, to } = effectiveRangeBounds();
  if (!from && !to) return false;
  const pad    = (n: number) => String(n).padStart(2, '0');
  const mStart = `${year}-${pad(month + 1)}-01`;
  const mEnd   = month === 11 ? `${year + 1}-01-01` : `${year}-${pad(month + 2)}-01`;
  if (from && to) return from < mEnd && to > mStart;
  if (from)       return mEnd  > from;
  if (to)         return mStart < to;
  return false;
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

async function queryYearMonthTotals(year: number): Promise<{ month: string; cnt: number }[]> {
  const mod  = tzToSqlModifier(state.tzOffset);
  const from = localDateToUtcBound(`${year}-01-01`, state.tzOffset);
  const to   = localDateToUtcBound(`${year + 1}-01-01`, state.tzOffset);
  const gameClause = state.gameFilter ? ' AND game_id = ?' : '';
  const params: (string | number)[] = [mod, from, to];
  if (state.gameFilter) params.push(state.gameFilter);
  return (await q(
    `SELECT strftime('%Y-%m', created_at, ?) AS month, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?${gameClause}
     GROUP BY month`,
    params,
  )) as { month: string; cnt: number }[];
}

async function queryAllYearTotals(): Promise<{ year: string; cnt: number }[]> {
  if (!state.calMinDate || !state.calMaxDate) return [];
  const mod  = tzToSqlModifier(state.tzOffset);
  const from = localDateToUtcBound(`${state.calMinDate.slice(0, 4)}-01-01`, state.tzOffset);
  const to   = localDateToUtcBound(`${Number(state.calMaxDate.slice(0, 4)) + 1}-01-01`, state.tzOffset);
  const gameClause = state.gameFilter ? ' AND game_id = ?' : '';
  const params: (string | number)[] = [mod, from, to];
  if (state.gameFilter) params.push(state.gameFilter);
  return (await q(
    `SELECT strftime('%Y', created_at, ?) AS year, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?${gameClause}
     GROUP BY year`,
    params,
  )) as { year: string; cnt: number }[];
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

  renderNavControls();
  void prefetchDefault(); // fire-and-forget: populate the game preview strip
}

function renderNavControls(): void {
  const ySel = document.getElementById('cal-year-select') as HTMLSelectElement | null;
  if (ySel) ySel.value = String(state.calYear);

  const [mnY, mnM] = state.calMinDate ? state.calMinDate.split('-').map(Number) as [number, number] : [0, 1];
  const [mxY, mxM] = state.calMaxDate ? state.calMaxDate.split('-').map(Number) as [number, number] : [9999, 12];

  (document.getElementById('cal-prev-year') as HTMLButtonElement).disabled = (state.calYear <= mnY);
  (document.getElementById('cal-next-year') as HTMLButtonElement).disabled = (state.calYear >= mxY);

  const monthNav = document.getElementById('cal-month-nav')!;
  const dayNav   = document.getElementById('cal-day-nav')!;

  if (state.calMonth !== null) {
    const mSel = document.getElementById('cal-month-select') as HTMLSelectElement | null;
    if (mSel) {
      mSel.value = String(state.calMonth);
      Array.from(mSel.options).forEach((opt, i) => {
        opt.disabled = (state.calYear === mnY && i < mnM - 1)
                    || (state.calYear === mxY && i > mxM - 1);
      });
    }

    (document.getElementById('cal-prev-month') as HTMLButtonElement).disabled =
      (state.calYear <= mnY && state.calMonth <= mnM - 1);
    (document.getElementById('cal-next-month') as HTMLButtonElement).disabled =
      (state.calYear >= mxY && state.calMonth >= mxM - 1);

    monthNav.style.display = 'flex';

    if (state.calDay !== null) {
      const dSel = document.getElementById('cal-day-select') as HTMLSelectElement | null;
      if (dSel) {
        const total = daysInMonth(state.calYear, state.calMonth);
        dSel.innerHTML = '';
        for (let d = 1; d <= total; d++) {
          const dateKey = localDateStr(state.calYear, state.calMonth, d);
          const opt = document.createElement('option');
          opt.value = String(d);
          opt.textContent = String(d);
          opt.disabled = !!(state.calMinDate && dateKey < state.calMinDate)
                      || !!(state.calMaxDate && dateKey > state.calMaxDate);
          dSel.appendChild(opt);
        }
        const dd = state.calDay.split('-')[2];
        dSel.value = String(parseInt(dd!, 10));
      }

      (document.getElementById('cal-prev-day') as HTMLButtonElement).disabled =
        !!(state.calMinDate && state.calDay <= state.calMinDate);
      (document.getElementById('cal-next-day') as HTMLButtonElement).disabled =
        !!(state.calMaxDate && state.calDay >= state.calMaxDate);

      dayNav.style.display = 'flex';
    } else {
      dayNav.style.display = 'none';
    }
  } else {
    monthNav.style.display = 'none';
    dayNav.style.display = 'none';
  }
}

// ── Year view ─────────────────────────────────────────────────────────────

async function renderAllYearsStrip(): Promise<void> {
  const strip = document.getElementById('cal-all-years-strip')!;
  strip.innerHTML = '';

  if (!state.calMinDate || !state.calMaxDate) return;

  const totals  = await queryAllYearTotals();
  const yearMap = Object.fromEntries(totals.map(r => [r.year, r.cnt]));

  // Merge live clip counts.
  for (const [yr, cnt] of Object.entries(liveYearCounts())) {
    yearMap[yr] = ((yearMap[yr] as number | undefined) ?? 0) + cnt;
  }

  const minYear = Number(state.calMinDate.slice(0, 4));
  const maxYear = Number(state.calMaxDate.slice(0, 4));

  const allYearCounts = Array.from(
    { length: maxYear - minYear + 1 },
    (_, i) => (yearMap[String(minYear + i)] as number | undefined) ?? 0,
  );
  const yearThresholds = computeHeatThresholds(allYearCounts);

  for (let y = minYear; y <= maxYear; y++) {
    const cnt   = (yearMap[String(y)] as number | undefined) ?? 0;
    const level = heatLevelRelative(cnt, yearThresholds);
    const el = document.createElement('div');
    const classes = ['strip-year'];
    if (y === state.calYear)  classes.push('active');
    if (yearOverlapsRange(y)) classes.push('in-range');
    el.className = classes.join(' ');
    el.textContent = String(y);
    el.title = t().monthTooltip(String(y), cnt);
    el.style.background = `var(--cal-${level})`;
    el.dataset.heat = String(level);

    el.addEventListener('click', () => {
      state.setCalYear(y);
      state.setCalMonth(null);
      state.setCalDay(null);
      state.setCalWeek(null);
      setYearFilter(y);
      void renderCalendar();
      state.setCurrentPage(1);
      callRender();
    });
    if (_supportsHover) {
      el.addEventListener('mouseenter', () => showPreviewForYear(y));
      el.addEventListener('mouseleave', revertToDefault);
    }
    strip.appendChild(el);
  }
}

async function renderYearView(): Promise<void> {
  document.getElementById('cal-all-years-strip')!.style.display = '';
  document.getElementById('cal-year-view')!.style.display        = 'grid';
  document.getElementById('cal-month-view')!.style.display       = 'none';
  renderBreadcrumb();

  const [yearData] = await Promise.all([queryYearDays(state.calYear), renderAllYearsStrip()]);
  const dayMap = Object.fromEntries(yearData.map(r => [r.day, r.cnt]));

  // Merge live clip counts (live clips are always newer than the DB cutoff,
  // so they appear at the end and never overlap archived days).
  for (const [day, cnt] of Object.entries(liveDayCountsForYear(state.calYear))) {
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

  for (let m = 0; m < 12; m++) {
    if ((monthTotals[m] ?? 0) === 0) continue;
    const totalDays = daysInMonth(state.calYear, m);
    const firstDow  = firstDayOfMonth(state.calYear, m);

    // Pre-compute for use in both the card className and the mini-day loop.
    const isFullMonth = monthFullyInRange(state.calYear, m);

    const card = document.createElement('div');
    card.className = 'mini-month' + (isFullMonth ? ' in-range' : '');

    const title = document.createElement('div');
    title.className = 'mini-month-title';
    title.textContent = t().monthShort[m]!;
    card.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'mini-month-grid';

    for (let e = 0; e < firstDow; e++) {
      const cell = document.createElement('div');
      cell.className = 'mini-day empty';
      grid.appendChild(cell);
    }
    for (let day = 1; day <= totalDays; day++) {
      const key  = localDateStr(state.calYear, m, day);
      const cnt  = (dayMap[key] as number | undefined) ?? 0;
      const cell = document.createElement('div');
      cell.className = 'mini-day';
      const miniDayLevel = dayThresholds ? heatLevelRelative(cnt, dayThresholds) : heatLevel(cnt);
      cell.style.background = `var(--cal-${miniDayLevel})`;
      if (isInRange(key)) {
        const dayOfWeek = (firstDow + day - 1) % 7; // 0=Sun, 6=Sat
        if (isFullMonth) {
          // Card border already shows the full-month selection — just tint the
          // cells without drawing per-cell left/right column-edge borders, which
          // would create a noisy grid of vertical stripes across all week rows.
          cell.style.boxShadow = 'inset 0 0 0 1000px rgba(145, 71, 255, 0.12)';
        } else {
          cell.style.boxShadow = inRangeBoxShadow(key, dayOfWeek, 2, 0.12);
        }
      }
      if (cnt > 0) cell.title = t().dayTooltip(key, cnt);
      grid.appendChild(cell);
    }

    card.appendChild(grid);
    card.addEventListener('click', () => {
      state.setCalMonth(m);
      state.setCalDay(null);
      state.setCalWeek(null);
      setMonthFilter(state.calYear, m);
      void renderCalendar();
      state.setCurrentPage(1);
      callRender();
    });
    if (_supportsHover) {
      card.addEventListener('mouseenter', () => showPreviewForMonth(state.calYear, m));
      card.addEventListener('mouseleave', revertToDefault);
    }
    container.appendChild(card);
  }
}

// ── Month view ────────────────────────────────────────────────────────────

async function renderMonthView(): Promise<void> {
  document.getElementById('cal-all-years-strip')!.style.display = 'none';
  document.getElementById('cal-year-view')!.style.display        = 'none';
  document.getElementById('cal-month-view')!.style.display       = 'block';
  renderBreadcrumb();
  await Promise.all([renderYearStrip(), renderMonthGrid()]);
}

async function renderYearStrip(): Promise<void> {
  const totals   = await queryYearMonthTotals(state.calYear);
  const monthMap = Object.fromEntries(totals.map(r => [r.month, r.cnt]));

  // Merge live clip counts into month totals.
  for (const [month, cnt] of Object.entries(liveMonthCountsForYear(state.calYear))) {
    monthMap[month] = ((monthMap[month] as number | undefined) ?? 0) + cnt;
  }

  const strip = document.getElementById('cal-year-strip')!;
  strip.innerHTML = '';

  const allMonthCounts = Array.from(
    { length: 12 },
    (_, m) => (monthMap[`${state.calYear}-${String(m + 1).padStart(2, '0')}`] as number | undefined) ?? 0,
  );
  const monthThresholds = computeHeatThresholds(allMonthCounts);

  for (let m = 0; m < 12; m++) {
    const key   = `${state.calYear}-${String(m + 1).padStart(2, '0')}`;
    const cnt   = (monthMap[key] as number | undefined) ?? 0;
    const level = heatLevelRelative(cnt, monthThresholds);

    const el = document.createElement('div');
    const classes = ['strip-month'];
    if (m === state.calMonth)               classes.push('active');
    if (monthOverlapsRange(state.calYear, m)) classes.push('in-range');
    el.className = classes.join(' ');
    el.textContent = t().monthShort[m]!;
    el.title = t().monthTooltip(t().monthLong[m]!, cnt);
    el.style.background = `var(--cal-${level})`;
    el.dataset.heat = String(level);

    el.addEventListener('click', () => {
      state.setCalMonth(m);
      state.setCalDay(null);
      state.setCalWeek(null);
      setMonthFilter(state.calYear, m);
      void renderCalendar();
      state.setCurrentPage(1);
      callRender();
    });
    if (_supportsHover) {
      el.addEventListener('mouseenter', () => showPreviewForMonth(state.calYear, m));
      el.addEventListener('mouseleave', revertToDefault);
    }
    strip.appendChild(el);
  }
}

async function renderMonthGrid(): Promise<void> {
  const monthData = await queryMonthDays(state.calYear, state.calMonth!);
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
      weekBtn.className = 'week-number-btn' + (state.calWeek === rowSunday ? ' selected' : '');
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
      if (dateKey === state.calDay)  classes.push('selected');
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

      cell.addEventListener('click', () => selectDay(dateKey));
      if (_supportsHover) {
        cell.addEventListener('mouseenter', () => showPreviewForDay(dateKey));
        cell.addEventListener('mouseleave', revertToDefault);
      }
    }

    currentRow!.appendChild(cell);
  }
}

// ── Breadcrumb ────────────────────────────────────────────────────────────

function renderBreadcrumb(): void {
  const bc    = document.getElementById('cal-breadcrumb')!;
  const parts: string[] = [];

  if (state.calMonth === null) {
    parts.push(`<span class="crumb" data-action="year-self">${state.calYear}</span>`);
  } else {
    parts.push(`<span class="crumb" data-action="year">${state.calYear}</span>`);
  }

  if (state.calMonth !== null) {
    parts.push(`<span class="sep">›</span>`);
    if (state.calDay === null && state.calWeek === null) {
      parts.push(`<span class="crumb" data-action="month-self">${t().monthLong[state.calMonth]!}</span>`);
    } else {
      parts.push(`<span class="crumb" data-action="month">${t().monthLong[state.calMonth]!}</span>`);
    }
  }

  if (state.calDay !== null) {
    const dd = state.calDay.split('-')[2];
    parts.push(`<span class="sep">›</span>`);
    parts.push(`<span class="crumb-current">${parseInt(dd!, 10)}</span>`);
  } else if (state.calWeek !== null) {
    parts.push(`<span class="sep">›</span>`);
    parts.push(`<span class="crumb-current">${t().weekLabel(state.calWeek!)}</span>`);
  }

  bc.innerHTML = parts.join('');

  bc.querySelector('[data-action="year"]')?.addEventListener('click', () => {
    state.setCalMonth(null);
    state.setCalDay(null);
    state.setCalWeek(null);
    setYearFilter(state.calYear);
    void renderCalendar();
    state.setCurrentPage(1);
    callRender();
  });
  if (_supportsHover) {
    const yearCrumb = bc.querySelector<HTMLElement>('[data-action="year"]');
    yearCrumb?.addEventListener('mouseenter', () => showPreviewForYear(state.calYear));
    yearCrumb?.addEventListener('mouseleave', revertToDefault);
  }

  bc.querySelector('[data-action="year-self"]')?.addEventListener('click', () => {
    setYearFilter(state.calYear);
    void renderCalendar();
    state.setCurrentPage(1);
    callRender();
  });
  if (_supportsHover) {
    const yearSelfCrumb = bc.querySelector<HTMLElement>('[data-action="year-self"]');
    yearSelfCrumb?.addEventListener('mouseenter', () => showPreviewForYear(state.calYear));
    yearSelfCrumb?.addEventListener('mouseleave', revertToDefault);
  }

  bc.querySelector('[data-action="month"]')?.addEventListener('click', () => {
    state.setCalDay(null);
    state.setCalWeek(null);
    setMonthFilter(state.calYear, state.calMonth!);
    void renderCalendar();
    state.setCurrentPage(1);
    callRender();
  });
  if (_supportsHover) {
    const monthCrumb = bc.querySelector<HTMLElement>('[data-action="month"]');
    monthCrumb?.addEventListener('mouseenter', () => showPreviewForMonth(state.calYear, state.calMonth!));
    monthCrumb?.addEventListener('mouseleave', revertToDefault);
  }

  bc.querySelector('[data-action="month-self"]')?.addEventListener('click', () => {
    setMonthFilter(state.calYear, state.calMonth!);
    void renderCalendar();
    state.setCurrentPage(1);
    callRender();
  });
  if (_supportsHover) {
    const monthSelfCrumb = bc.querySelector<HTMLElement>('[data-action="month-self"]');
    monthSelfCrumb?.addEventListener('mouseenter', () => showPreviewForMonth(state.calYear, state.calMonth!));
    monthSelfCrumb?.addEventListener('mouseleave', revertToDefault);
  }
}

// ── Selection ─────────────────────────────────────────────────────────────

function selectDay(dateStr: string): void {
  state.setCalDay(dateStr);
  state.setCalWeek(null);
  state.setCalDateFrom(dateStr);
  state.setCalDateTo(addDays(dateStr, 1));
  syncDateInputs();
  void renderCalendar();
  state.setCurrentPage(1);
  callRender();
}

function selectWeek(weekMonStr: string): void {
  state.setCalWeek(weekMonStr);
  state.setCalDay(null);
  state.setCalDateFrom(weekMonStr);
  state.setCalDateTo(addDays(weekMonStr, 7));
  syncDateInputs();
  void renderCalendar();
  state.setCurrentPage(1);
  callRender();
}

// ── View switching ────────────────────────────────────────────────────────

/**
 * Derive a sensible calendar navigation position from the current date filter:
 * - No filter → year view for the most-recent year with data
 * - Filter span ≤ 62 days → month view for the start month of the range
 * - Filter span > 62 days → year view for the midpoint year
 *
 * Called when the user opens the calendar panel so it lands somewhere relevant.
 * Resets calDay / calWeek because they were associated with the previous
 * navigation session, not the current filter.
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
    state.setCalDay(null);
    state.setCalWeek(null);
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
    state.setCalDay(null);
    state.setCalWeek(null);
  } else {
    // > 2 months: year view for the midpoint year.
    const midYear = new Date((f + t) / 2).getUTCFullYear();
    state.setCalYear(midYear);
    state.setCalMonth(null);
    state.setCalDay(null);
    state.setCalWeek(null);
  }
}

export function switchView(view: 'grid' | 'calendar'): void {
  state.setCurrentView(view);

  const calBtn   = document.getElementById('btn-view-cal')!;
  const calPanel = document.getElementById('calendar-panel')!;

  if (view === 'grid') {
    calBtn.classList.remove('active');
    calPanel.style.display = 'none';
    state.setCurrentPage(1);
    callRender();
  } else {
    calBtn.classList.add('active');
    deriveNavigationPosition();
    void renderCalendar();
    state.setCurrentPage(1);
    callRender();
  }
}

// ── Year / month / day navigation ─────────────────────────────────────────

function prevYear(): void {
  const minY = state.calMinDate ? parseInt(state.calMinDate.slice(0, 4), 10) : 0;
  if (state.calYear <= minY) return;
  state.setCalYear(state.calYear - 1);
  state.setCalMonth(null);
  state.setCalDay(null);
  state.setCalWeek(null);
  void renderCalendar();
  state.setCurrentPage(1);
  callRender();
}

function nextYear(): void {
  const maxY = state.calMaxDate ? parseInt(state.calMaxDate.slice(0, 4), 10) : 9999;
  if (state.calYear >= maxY) return;
  state.setCalYear(state.calYear + 1);
  state.setCalMonth(null);
  state.setCalDay(null);
  state.setCalWeek(null);
  void renderCalendar();
  state.setCurrentPage(1);
  callRender();
}

function prevMonth(): void {
  const [mnY, mnM] = state.calMinDate ? state.calMinDate.split('-').map(Number) as [number, number] : [0, 1];
  if (state.calYear <= mnY && state.calMonth! <= mnM - 1) return;
  if (state.calMonth === 0) { state.setCalMonth(11); state.setCalYear(state.calYear - 1); }
  else                       { state.setCalMonth(state.calMonth! - 1); }
  state.setCalDay(null);
  state.setCalWeek(null);
  void renderCalendar();
  state.setCurrentPage(1);
  callRender();
}

function nextMonth(): void {
  const [mxY, mxM] = state.calMaxDate ? state.calMaxDate.split('-').map(Number) as [number, number] : [9999, 12];
  if (state.calYear >= mxY && state.calMonth! >= mxM - 1) return;
  if (state.calMonth === 11) { state.setCalMonth(0); state.setCalYear(state.calYear + 1); }
  else                        { state.setCalMonth(state.calMonth! + 1); }
  state.setCalDay(null);
  state.setCalWeek(null);
  void renderCalendar();
  state.setCurrentPage(1);
  callRender();
}

function prevDay(): void {
  if (state.calMinDate && state.calDay! <= state.calMinDate) return;
  const newDay = addDays(state.calDay!, -1);
  const parts = newDay.split('-').map(Number) as [number, number, number];
  state.setCalYear(parts[0]);
  state.setCalMonth(parts[1] - 1); // 0-based
  selectDay(newDay);
}

function nextDay(): void {
  if (state.calMaxDate && state.calDay! >= state.calMaxDate) return;
  const newDay = addDays(state.calDay!, 1);
  const parts = newDay.split('-').map(Number) as [number, number, number];
  state.setCalYear(parts[0]);
  state.setCalMonth(parts[1] - 1); // 0-based
  selectDay(newDay);
}

// ── Init ──────────────────────────────────────────────────────────────────

/** Rebuild the month <select> options in the current language (call after lang change). */
export function rebuildMonthSelect(): void {
  const mSel = document.getElementById('cal-month-select') as HTMLSelectElement | null;
  if (!mSel) return;
  const currentVal = mSel.value;
  mSel.innerHTML = '';
  t().monthLong.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = name;
    mSel.appendChild(opt);
  });
  mSel.value = currentVal;
}

/**
 * Recomputes calMinDate / calMaxDate from the stored raw timestamps using the
 * current timezone offset, then rebuilds the year-select option list.
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

  // Rebuild the year select options.
  const ySel = document.getElementById('cal-year-select') as HTMLSelectElement | null;
  if (ySel) {
    ySel.innerHTML = '';
    for (let y = maxY; y >= minY; y--) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      ySel.appendChild(opt);
    }
    ySel.value = String(state.calYear);
  }
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

  const ySel = document.getElementById('cal-year-select') as HTMLSelectElement;
  ySel.addEventListener('change', () => {
    state.setCalYear(parseInt(ySel.value, 10));
    state.setCalMonth(null);
    state.setCalDay(null);
    state.setCalWeek(null);
    void renderCalendar();
    state.setCurrentPage(1);
    callRender();
  });

  const mSel = document.getElementById('cal-month-select') as HTMLSelectElement;
  t().monthLong.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = name;
    mSel.appendChild(opt);
  });
  mSel.addEventListener('change', () => {
    state.setCalMonth(parseInt(mSel.value, 10));
    state.setCalDay(null);
    state.setCalWeek(null);
    void renderCalendar();
    state.setCurrentPage(1);
    callRender();
  });

  const dSel = document.getElementById('cal-day-select') as HTMLSelectElement;
  dSel.addEventListener('change', e => {
    const d = parseInt((e.target as HTMLSelectElement).value, 10);
    selectDay(localDateStr(state.calYear, state.calMonth!, d));
  });

  const fromInput = document.getElementById('date-from-input') as HTMLInputElement;
  fromInput.addEventListener('change', e => {
    const val = (e.target as HTMLInputElement).value;
    state.setCalDateFrom(val || null);
    state.setCalDay(null);
    state.setCalWeek(null);
    const toVal = (document.getElementById('date-to-input') as HTMLInputElement).value;
    state.setCalDateTo(toVal ? addDays(toVal, 1) : null);
    state.setCurrentPage(1);
    if (state.currentView === 'calendar') void renderCalendar();
    callRender();
  });

  const toInput = document.getElementById('date-to-input') as HTMLInputElement;
  toInput.addEventListener('change', e => {
    const val = (e.target as HTMLInputElement).value;
    state.setCalDateTo(val ? addDays(val, 1) : null);
    state.setCalDay(null);
    state.setCalWeek(null);
    state.setCurrentPage(1);
    if (state.currentView === 'calendar') void renderCalendar();
    callRender();
  });

  document.getElementById('btn-view-cal')!.addEventListener('click', () => {
    switchView(state.currentView === 'calendar' ? 'grid' : 'calendar');
  });

  document.getElementById('btn-clear-dates')!.addEventListener('click', () => {
    clearCalDateFilter();
    state.setCurrentPage(1);
    callRender();
    if (state.currentView === 'calendar') void renderCalendar();
  });

  document.getElementById('cal-prev-year')!.addEventListener('click', prevYear);
  document.getElementById('cal-next-year')!.addEventListener('click', nextYear);
  document.getElementById('cal-prev-month')!.addEventListener('click', prevMonth);
  document.getElementById('cal-next-month')!.addEventListener('click', nextMonth);
  document.getElementById('cal-prev-day')!.addEventListener('click', prevDay);
  document.getElementById('cal-next-day')!.addEventListener('click', nextDay);

  if (_supportsHover) {
    // Prev/next buttons: preview the period they would navigate to.
    // State is read at event time (not closure-captured) so it reflects the
    // current navigation position even after the user has moved around.
    document.getElementById('cal-prev-year')!.addEventListener('mouseenter', () => {
      showPreviewForYear(state.calYear - 1);
    });
    document.getElementById('cal-next-year')!.addEventListener('mouseenter', () => {
      showPreviewForYear(state.calYear + 1);
    });
    document.getElementById('cal-prev-month')!.addEventListener('mouseenter', () => {
      const prevM = state.calMonth === 0 ? 11 : state.calMonth! - 1;
      const prevY = state.calMonth === 0 ? state.calYear - 1 : state.calYear;
      showPreviewForMonth(prevY, prevM);
    });
    document.getElementById('cal-next-month')!.addEventListener('mouseenter', () => {
      const nextM = state.calMonth === 11 ? 0 : state.calMonth! + 1;
      const nextY = state.calMonth === 11 ? state.calYear + 1 : state.calYear;
      showPreviewForMonth(nextY, nextM);
    });
    document.getElementById('cal-prev-day')!.addEventListener('mouseenter', () => {
      if (state.calDay) showPreviewForDay(addDays(state.calDay, -1));
    });
    document.getElementById('cal-next-day')!.addEventListener('mouseenter', () => {
      if (state.calDay) showPreviewForDay(addDays(state.calDay, 1));
    });
    // Revert on mouseleave for all nav buttons
    for (const id of ['cal-prev-year', 'cal-next-year', 'cal-prev-month', 'cal-next-month', 'cal-prev-day', 'cal-next-day']) {
      document.getElementById(id)!.addEventListener('mouseleave', revertToDefault);
    }
  }
}
