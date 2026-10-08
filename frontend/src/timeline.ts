// ── Timeline overview ──────────────────────────────────────────────────────
//
// A histogram of the whole archive in the filter bar — one bar per week, or
// per month when week bars would be too thin — that both shows and edits the
// date filter:
//
//   - The filter is a band with a drag handle at each closed end. Dragging a
//     handle resizes it, dragging the band slides it by its own unit (day,
//     week, month, year, or its length for custom ranges), and with a mouse,
//     dragging across empty space selects a new range. Ends snap to bars.
//   - The period the calendar panel shows is an underline below the bars.
//     Clicking (or tapping) moves the calendar there, opening it; a double-
//     click (or double-tap) also selects that year or month.
//
// Touch drags outside the band are ignored, so a stray swipe can't replace a
// selection. Bars follow the game and search filters but never the date filter
// (the band shows that); when a filter is active, the unfiltered totals are
// drawn faintly behind on the same scale. Until the timeline has been used to
// select dates, a line under it says how.
//
// Geometry (binning, snapping, x ↔ date) is in lib/timeline.ts; selection
// semantics (kinds, shifting, labels) in lib/dateRange.ts.

import * as state from './state';
import { q } from './db';
import { aggregateHint, buildWhere } from './lib/query';
import { filterLiveClips } from './lib/liveFilter';
import { addDays, tzToSqlModifier, utcTimestampToLocalDate } from './lib/dateUtils';
import { daysBetween, periodLabel, shiftRange, rangeKind } from './lib/dateRange';
import {
  buildBins,
  chooseBinUnit,
  dateToX,
  dragShift,
  nearestBinBoundary,
  rangeFromDrag,
  resizeRange,
  xToDate,
  type Bin,
  type BinUnit,
  type Scale,
} from './lib/timeline';
import {
  applyDateSelection,
  calendarPeriodAt,
  calendarViewPeriod,
  selectDateInCalendar,
  showDateInCalendar,
} from './calendar';
import { t, lang } from './lib/i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PLOT_H = 34;            // bar area
const AXIS_H = 16;            // year labels + calendar-view underline
const HEIGHT = PLOT_H + AXIS_H;
const DRAG_THRESHOLD = 4;     // px before a press counts as a drag
const DOUBLE_CLICK_MS = 450;  // a second click this soon after is a double-click
const MIN_BAND_PX = 6;        // keep a one-day selection visible
const NARROW_BAND_PX = 12;    // below this the band is drawn solid, without handles

// ── DOM ────────────────────────────────────────────────────────────────────

let _root: HTMLElement | null = null;
let _svg: SVGSVGElement | null = null;
let _tip: HTMLElement | null = null;
let _intro: HTMLElement | null = null;
const _el: Record<string, SVGElement> = {};

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// ── Data ───────────────────────────────────────────────────────────────────
// Per-local-day counts for the whole archive. Bins are rebuilt from these on
// resize, so only filter / timezone / live-clip changes re-query.

let _baseCounts = new Map<string, number>();   // no game/search filter
let _counts = new Map<string, number>();       // current game/search filter
let _baseKey = '';
let _filterKey = '';
let _fetchSeq = 0;

// ── Layout ─────────────────────────────────────────────────────────────────

let _unit: BinUnit = 'week';
let _scale: Scale | null = null;
let _bins: Bin[] = [];

// ── Interaction ───────────────────────────────────────────────────────────

type Drag =
  | { mode: 'pending'; x0: number; touch: boolean; moved: boolean }
  | { mode: 'create'; anchor: string }
  | { mode: 'resize'; edge: 'from' | 'to'; from: string | null; to: string | null }
  | { mode: 'move'; from: string; to: string; x0: number };

let _drag: Drag | null = null;
// The selection drawn while dragging; committed on release.
let _preview: { from: string | null; to: string | null } | null = null;
// The last press that didn't drag, to tell a double-click; date is where the
// first click showed the calendar, which the double-click then selects.
let _lastClick: { time: number; x: number; date: string } | null = null;

const _supportsHover = window.matchMedia('(hover: hover)').matches;

function selection(): { from: string | null; to: string | null } {
  return _preview ?? { from: state.calDateFrom, to: state.calDateTo };
}

function filtersActive(): boolean {
  return state.searchQuery !== '' || state.gameFilter !== '';
}

// ── Queries ────────────────────────────────────────────────────────────────

async function queryDayCounts(filtered: boolean): Promise<Map<string, number>> {
  const search = filtered ? state.searchQuery : '';
  const game   = filtered ? state.gameFilter  : '';
  const opts = {
    searchQuery: search,
    gameFilter:  game,
    calDateFrom: null,
    calDateTo:   null,
    useFts:      state.useFts,
    tzOffset:    state.tzOffset,
    devCutoff:   state.devCutoff,
    indexHints:  state.useIndexHints,
  };
  const w = buildWhere(opts);
  const { where, params } = w;
  // Scans clips_created_at_game (≈250 pages, also for an FTS search, whatever
  // the term), or clips_title for a LIKE search — see aggregateHint().
  const rows = await q(
    `SELECT strftime('%Y-%m-%d', c.created_at, :tzmod) AS day, COUNT(*) AS cnt
     FROM clips c ${aggregateHint(w, opts)} ${where}
     GROUP BY day`,
    { ...params, ':tzmod': tzToSqlModifier(state.tzOffset) },
  );
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(String(r['day']), Number(r['cnt']));

  const live = filterLiveClips({
    clips:        state.liveClips,
    dbCutoffDate: state.dbCutoffDate,
    calDateFrom:  null,
    calDateTo:    null,
    gameFilter:   game,
    searchQuery:  search,
    tzOffset:     state.tzOffset,
  });
  for (const c of live) {
    const day = utcTimestampToLocalDate(c.created_at, state.tzOffset);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return counts;
}

async function refreshData(): Promise<void> {
  const baseKey = [state.tzOffset, state.liveClips.length, state.useFts, state.calMinDate, state.calMaxDate].join('|');
  const filterKey = `${baseKey}|${state.searchQuery}\u0000${state.gameFilter}`;
  if (baseKey === _baseKey && filterKey === _filterKey) return;

  const seq = ++_fetchSeq;
  try {
    let base = _baseCounts;
    if (baseKey !== _baseKey) base = await queryDayCounts(false);
    const counts = filtersActive() ? await queryDayCounts(true) : base;
    if (seq !== _fetchSeq) return; // superseded by a newer filter change
    _baseCounts = base;
    _counts = counts;
    _baseKey = baseKey;
    _filterKey = filterKey;
    layout();
  } catch (e) {
    console.error('timeline query failed:', e);
  }
}

// ── Drawing ────────────────────────────────────────────────────────────────

/** Recompute bins and scale for the current width, then redraw everything. */
function layout(): void {
  if (!_svg || !state.calMinDate || !state.calMaxDate) return;
  const width = _svg.clientWidth;
  if (width === 0) return; // hidden
  _unit = chooseBinUnit(width, state.calMinDate, state.calMaxDate);
  _bins = buildBins(state.calMinDate, state.calMaxDate, _unit, _counts);
  _scale = _bins.length
    ? { start: _bins[0]!.start, end: _bins[_bins.length - 1]!.end, width }
    : null;
  _svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
  showHover(undefined);
  drawBars();
  drawAxis();
  drawMarks();
}

/** One <path> of bars for the given bins, scaled so `max` fills the plot. */
function barsPath(bins: Bin[], max: number): string {
  if (!_scale || max <= 0) return '';
  const d: string[] = [];
  for (const b of bins) {
    if (b.count <= 0) continue;
    const x0 = dateToX(_scale, b.start);
    const x1 = dateToX(_scale, b.end);
    const w  = x1 - x0 >= 3 ? x1 - x0 - 1 : x1 - x0; // 1px gap when there's room
    // Square-root scale: one busy week shouldn't flatten everything else.
    const h  = Math.max(1.5, Math.sqrt(b.count / max) * (PLOT_H - 2));
    d.push(`M${x0.toFixed(2)} ${PLOT_H}h${w.toFixed(2)}v${(-h).toFixed(2)}h${(-w).toFixed(2)}z`);
  }
  return d.join('');
}

function drawBars(): void {
  const ghost = filtersActive()
    ? buildBins(state.calMinDate!, state.calMaxDate!, _unit, _baseCounts)
    : [];
  // Shared scale: with a filter active the bars show what share of each
  // period matched, against the faint unfiltered totals behind them.
  const max = Math.max(1, ...(ghost.length ? ghost : _bins).map(b => b.count));
  _el['ghost']!.setAttribute('d', barsPath(ghost, max));
  const d = barsPath(_bins, max);
  _el['bars']!.setAttribute('d', d);
  _el['barsSel']!.setAttribute('d', d);
}

function drawAxis(): void {
  const axis = _el['axis']!;
  axis.replaceChildren();
  if (!_scale) return;
  const firstYear = Number(_scale.start.slice(0, 4));
  const lastYear  = Number(addDays(_scale.end, -1).slice(0, 4));
  for (let y = firstYear; y <= lastYear; y++) {
    const start = y === firstYear ? _scale.start : `${y}-01-01`;
    const x = dateToX(_scale, start);
    const next = y === lastYear ? _scale.width : dateToX(_scale, `${y + 1}-01-01`);
    if (y !== firstYear) {
      axis.appendChild(svgEl('line', { x1: x, x2: x, y1: 0, y2: PLOT_H + AXIS_H, class: 'tl-tick' }));
    }
    // Slivers of a year (the archive's first / last months) get "'26", or
    // nothing if even that won't fit.
    const room = next - x;
    if (room >= 18) {
      const label = svgEl('text', { x: x + 3, y: PLOT_H + 12, class: 'tl-year' });
      label.textContent = room >= 30 ? String(y) : `'${String(y).slice(2)}`;
      axis.appendChild(label);
    }
  }
}

/** Selection band, handles and calendar-view underline (cheap; no bars). */
function drawMarks(): void {
  if (!_svg || !_scale) return;
  const s = _scale;
  const { from, to } = selection();
  const kind = rangeKind(from, to);
  const band = _el['band']!;
  const clip = _el['clip']!;
  const hFrom = _el['handleFrom']!;
  const hTo = _el['handleTo']!;

  _svg.classList.toggle('has-sel', kind !== 'none');
  _svg.classList.remove('narrow-sel');
  if (kind === 'none') {
    for (const el of [band, hFrom, hTo]) el.setAttribute('display', 'none');
    clip.setAttribute('width', '0');
  } else {
    let x1 = from !== null ? Math.max(0, dateToX(s, from)) : 0;
    let x2 = to !== null ? Math.min(s.width, dateToX(s, to)) : s.width;
    if (x2 - x1 < MIN_BAND_PX) {
      const mid = (x1 + x2) / 2;
      x1 = mid - MIN_BAND_PX / 2;
      x2 = mid + MIN_BAND_PX / 2;
    }
    for (const el of [band, clip]) {
      el.setAttribute('x', String(x1));
      el.setAttribute('width', String(x2 - x1));
    }
    // Two handles a few px apart read as "||"; a narrow band is drawn as one
    // solid marker instead (the handles stay focusable for the keyboard).
    _svg.classList.toggle('narrow-sel', x2 - x1 < NARROW_BAND_PX);
    band.removeAttribute('display');
    band.setAttribute('aria-valuetext', periodLabel(from, to, lang));
    placeHandle(hFrom, from !== null ? x1 : null, from !== null ? periodLabel(from, addDays(from, 1), lang) : '');
    placeHandle(hTo, to !== null ? x2 : null, to !== null ? periodLabel(addDays(to, -1), to, lang) : '');
  }

  const view = _el['view']!;
  const period = calendarViewPeriod();
  if (period) {
    const x1 = Math.max(0, dateToX(s, period.start));
    const x2 = Math.min(s.width, dateToX(s, period.end));
    view.setAttribute('x', String(x1));
    view.setAttribute('width', String(Math.max(2, x2 - x1)));
    view.removeAttribute('display');
  } else {
    view.setAttribute('display', 'none');
  }
}

function placeHandle(el: SVGElement, x: number | null, valueText: string): void {
  if (x === null) { el.setAttribute('display', 'none'); return; }
  el.removeAttribute('display');
  el.setAttribute('x', String(x - 2));
  el.setAttribute('aria-valuetext', valueText);
}

// ── Tooltip ────────────────────────────────────────────────────────────────

function countIn(from: string | null, to: string | null): number {
  let n = 0;
  for (const [day, cnt] of _counts) {
    if ((from === null || day >= from) && (to === null || day < to)) n += cnt;
  }
  return n;
}

/** Show text over x, with optional gesture → action rows below it. */
function showTip(x: number, text: string, hints: [string, string][] = []): void {
  if (!_tip || !_scale) return;
  const title = document.createElement('div');
  title.className = 'tl-tip-title';
  title.textContent = text;
  _tip.replaceChildren(title);
  if (hints.length) {
    const list = document.createElement('dl');
    list.className = 'tl-tip-hints';
    for (const [gesture, action] of hints) {
      const dt = document.createElement('dt');
      dt.textContent = gesture;
      const dd = document.createElement('dd');
      dd.textContent = action;
      list.append(dt, dd);
    }
    _tip.appendChild(list);
  }
  _tip.hidden = false;
  // Centre on x, clamped inside the timeline.
  const w = _tip.offsetWidth;
  _tip.style.left = `${Math.min(Math.max(0, x - w / 2), _scale.width - w)}px`;
}

function hideTip(): void {
  if (_tip) _tip.hidden = true;
}

function selectionTip(x: number, hints: [string, string][] = []): void {
  const { from, to } = selection();
  showTip(x, `${periodLabel(from, to, lang)} · ${t().clipCount(countIn(from, to))}`, hints);
}

/** Highlight the bar under the pointer (mouse hover), or nothing. */
function showHover(bin: Bin | undefined): void {
  const el = _el['hover'];
  if (!el) return;
  if (!bin || !_scale) { el.setAttribute('display', 'none'); return; }
  const x0 = dateToX(_scale, bin.start);
  el.setAttribute('x', String(x0));
  el.setAttribute('width', String(Math.max(1, dateToX(_scale, bin.end) - x0)));
  el.removeAttribute('display');
}

// ── How-to line ────────────────────────────────────────────────────────────
// Shown under the timeline until it has been used to select dates (or the
// line is dismissed), so its gestures don't depend on finding the tooltip.

const INTRO_KEY = 'tc_timeline_intro_done';

function introSeen(): boolean {
  try { return localStorage.getItem(INTRO_KEY) === '1'; } catch { return false; }
}

function introDone(): void {
  if (_intro) _intro.hidden = true;
  try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* storage blocked: hide for this visit */ }
}

// ── Pointer handling ───────────────────────────────────────────────────────

function pointerX(e: PointerEvent): number {
  return e.clientX - _svg!.getBoundingClientRect().left;
}

/** What's under x: a handle, the band, or empty space. */
function hitTest(x: number, touch: boolean): 'from' | 'to' | 'band' | null {
  if (!_scale) return null;
  const { from, to } = { from: state.calDateFrom, to: state.calDateTo };
  if (from === null && to === null) return null;
  const tol = touch ? 16 : 6;
  const xFrom = from !== null ? dateToX(_scale, from) : null;
  const xTo   = to   !== null ? dateToX(_scale, to)   : null;
  const lo = xFrom ?? 0;
  const hi = xTo ?? _scale.width;
  if (xFrom !== null && xTo !== null && hi - lo < 2 * tol) {
    // Narrow band (e.g. one month on a phone): the band itself moves it, and
    // the handle zones extend outward only, so both stay reachable.
    const mid = (lo + hi) / 2;
    if (Math.abs(x - mid) <= Math.max(MIN_BAND_PX, hi - lo) / 2) return 'band';
    if (x < mid && x >= lo - tol) return 'from';
    if (x > mid && x <= hi + tol) return 'to';
    return null;
  }
  const dFrom = xFrom !== null ? Math.abs(x - xFrom) : Infinity;
  const dTo   = xTo   !== null ? Math.abs(x - xTo)   : Infinity;
  if (Math.min(dFrom, dTo) <= tol) return dFrom < dTo ? 'from' : 'to';
  return x > lo && x < hi ? 'band' : null;
}

function cursorFor(hit: ReturnType<typeof hitTest>): string {
  if (hit === 'from' || hit === 'to') return 'ew-resize';
  if (hit === 'band') return rangeKind(state.calDateFrom, state.calDateTo) === 'open' ? 'default' : 'grab';
  return 'crosshair';
}

function onPointerDown(e: PointerEvent): void {
  if (!_svg || !_scale || e.button !== 0) return;
  const x = pointerX(e);
  const touch = e.pointerType === 'touch';
  const hit = hitTest(x, touch);
  const { calDateFrom: from, calDateTo: to } = state;

  // preventDefault() below also cancels the browser's focus-on-press, so
  // focus explicitly: arrow keys then work right after a click.
  if (hit) {
    const el = _el[hit === 'from' ? 'handleFrom' : hit === 'to' ? 'handleTo' : 'band']!;
    el.focus({ preventScroll: true });
  }
  showHover(undefined);
  if (hit === 'from' || hit === 'to') {
    _drag = { mode: 'resize', edge: hit, from, to };
  } else if (hit === 'band' && from !== null && to !== null) {
    _drag = { mode: 'move', from, to, x0: x };
    _svg.style.cursor = 'grabbing';
  } else {
    _drag = { mode: 'pending', x0: x, touch, moved: false };
  }
  _svg.setPointerCapture(e.pointerId);
  if (!touch) e.preventDefault(); // no text selection while dragging
}

function onPointerMove(e: PointerEvent): void {
  if (!_svg || !_scale) return;
  const x = pointerX(e);

  if (!_drag) {
    if (e.pointerType !== 'mouse') return;
    const hit = hitTest(x, false);
    _svg.style.cursor = cursorFor(hit);
    if (hit) {
      showHover(undefined);
      selectionTip(x, hit === 'band' ? t().timelineBandTip : t().timelineHandleTip);
      return;
    }
    const day = xToDate(_scale, x);
    const bin = _bins.find(b => day >= b.start && day < b.end);
    showHover(bin);
    if (bin) {
      const [pFrom, pTo] = calendarPeriodAt(day);
      showTip(
        x,
        `${periodLabel(bin.start, bin.end, lang)} · ${t().clipCount(bin.count)}`,
        t().timelineTip(periodLabel(pFrom, pTo, lang)),
      );
    }
    return;
  }

  const day = xToDate(_scale, x);
  switch (_drag.mode) {
    case 'pending':
      if (Math.abs(x - _drag.x0) <= DRAG_THRESHOLD) return;
      _drag.moved = true;
      if (_drag.touch) return; // touch: only handles and the band are draggable
      _drag = { mode: 'create', anchor: xToDate(_scale, _drag.x0) };
      _preview = rangeFromDrag(_drag.anchor, day, _unit);
      break;
    case 'create':
      _preview = rangeFromDrag(_drag.anchor, day, _unit);
      break;
    case 'resize': {
      const { edge, from, to } = _drag;
      if (from !== null && to !== null) _preview = resizeRange(from, to, edge, day, _unit);
      else if (edge === 'from') _preview = { from: nearestBinBoundary(day, _unit), to };
      else _preview = { from, to: nearestBinBoundary(day, _unit) };
      break;
    }
    case 'move': {
      if (!_preview && Math.abs(x - _drag.x0) <= DRAG_THRESHOLD) return; // still a click
      const deltaDays = ((x - _drag.x0) / _scale.width) * daysBetween(_scale.start, _scale.end);
      _preview = dragShift(_drag.from, _drag.to, deltaDays, _scale.start, _scale.end);
      break;
    }
  }
  drawMarks();
  selectionTip(x);
}

/** Finish a press: commit it on release (e), or cancel it (null). */
function endDrag(e: PointerEvent | null, commit: boolean): void {
  if (!_svg || !_drag) return;
  const drag = _drag;
  const preview = _preview;
  _drag = null;
  _preview = null;
  _svg.style.cursor = '';
  hideTip();
  drawMarks();
  if (!e || !commit || !_scale) { _lastClick = null; return; }

  // A press that never became a drag — on empty space or on the band — is a
  // click: show that date in the calendar. A second click there soon after
  // selects the year or month the calendar now shows.
  if ((drag.mode === 'pending' && !drag.moved) || (drag.mode === 'move' && !preview)) {
    const x = pointerX(e);
    const last = _lastClick;
    const tolerance = e.pointerType === 'touch' ? 24 : 8;
    if (last && e.timeStamp - last.time <= DOUBLE_CLICK_MS && Math.abs(x - last.x) <= tolerance) {
      _lastClick = null;
      selectDateInCalendar(last.date);
      introDone();
    } else {
      const date = xToDate(_scale, x);
      _lastClick = { time: e.timeStamp, x, date };
      showDateInCalendar(date);
    }
    notifyFilterBar();
    return;
  }
  _lastClick = null;
  if (drag.mode === 'pending') return;
  if (preview && (preview.from !== state.calDateFrom || preview.to !== state.calDateTo)) {
    applyDateSelection(preview.from, preview.to);
    introDone();
    notifyFilterBar();
  }
}

/** Let filterBar.ts react as it does to other filter changes (reveal results). */
function notifyFilterBar(): void {
  _root?.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── Keyboard ───────────────────────────────────────────────────────────────
// The band is a slider whose arrow keys shift the selection by one of its own
// units; each handle is a slider moving its end by a day (a week with Shift).

function onBandKey(e: KeyboardEvent): void {
  const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1
            : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
  if (!dir) return;
  e.preventDefault();
  const r = shiftRange(state.calDateFrom, state.calDateTo, dir);
  if (r) applyDateSelection(r.from, r.to);
}

function onHandleKey(edge: 'from' | 'to', e: KeyboardEvent): void {
  const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1
            : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
  if (!dir) return;
  e.preventDefault();
  const step = dir * (e.shiftKey ? 7 : 1);
  let { calDateFrom: from, calDateTo: to } = state;
  if (edge === 'from' && from !== null) {
    from = addDays(from, step);
    if (to !== null && from >= to) return;
  } else if (edge === 'to' && to !== null) {
    to = addDays(to, step);
    if (from !== null && to <= from) return;
  } else {
    return;
  }
  applyDateSelection(from, to);
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Apply translated labels (call on init and language change). */
export function applyTimelineTranslations(): void {
  if (!_svg) return;
  _svg.setAttribute('aria-label', t().timelineLabel);
  _el['band']!.setAttribute('aria-label', t().timelineSelection);
  _el['handleFrom']!.setAttribute('aria-label', t().dateFrom);
  _el['handleTo']!.setAttribute('aria-label', t().dateTo);
  if (_intro) {
    _intro.querySelector('.tl-intro-text')!.textContent = _supportsHover ? t().timelineIntro : t().timelineIntroTouch;
    _intro.querySelector('.tl-intro-close')!.setAttribute('aria-label', t().dismissBanner);
  }
}

/**
 * Redraw the selection and calendar-view marks immediately, and re-query the
 * bars if the filters behind them changed. Called at the start of every
 * render() in app.ts.
 */
export function refreshTimeline(): void {
  if (!_svg) return;
  if (!_scale) layout(); else drawMarks();
  void refreshData();
}

export function initTimeline(): void {
  _root = document.getElementById('timeline');
  if (!_root) return;

  const svg = svgEl('svg', { class: 'tl-svg', height: HEIGHT, role: 'group' });
  const defs = svgEl('defs');
  const clipPath = svgEl('clipPath', { id: 'tl-sel-clip' });
  _el['clip'] = svgEl('rect', { y: 0, height: PLOT_H, width: 0 });
  clipPath.appendChild(_el['clip']);
  defs.appendChild(clipPath);

  _el['band'] = svgEl('rect', {
    class: 'tl-band', y: 0, height: PLOT_H, tabindex: 0, role: 'slider', display: 'none',
  });
  _el['hover'] = svgEl('rect', { class: 'tl-hover', y: 0, height: PLOT_H, display: 'none' });
  _el['ghost'] = svgEl('path', { class: 'tl-ghost' });
  _el['bars'] = svgEl('path', { class: 'tl-bars' });
  _el['barsSel'] = svgEl('path', { class: 'tl-bars-sel', 'clip-path': 'url(#tl-sel-clip)' });
  _el['axis'] = svgEl('g', { class: 'tl-axis' });
  _el['view'] = svgEl('rect', { class: 'tl-view', y: PLOT_H + 1, height: 3, rx: 1.5, display: 'none' });
  _el['handleFrom'] = svgEl('rect', {
    class: 'tl-handle', y: 0, width: 4, height: PLOT_H, rx: 2, tabindex: 0, role: 'slider', display: 'none',
  });
  _el['handleTo'] = svgEl('rect', {
    class: 'tl-handle', y: 0, width: 4, height: PLOT_H, rx: 2, tabindex: 0, role: 'slider', display: 'none',
  });
  svg.append(
    defs, _el['band'], _el['hover'], _el['ghost'], _el['bars'], _el['barsSel'], _el['axis'],
    _el['view'], _el['handleFrom'], _el['handleTo'],
  );

  _tip = document.createElement('div');
  _tip.className = 'tl-tip';
  _tip.hidden = true;

  _intro = document.createElement('p');
  _intro.className = 'tl-intro';
  _intro.hidden = introSeen();
  const introText = document.createElement('span');
  introText.className = 'tl-intro-text';
  const introClose = document.createElement('button');
  introClose.type = 'button';
  introClose.className = 'tl-intro-close';
  introClose.textContent = '\u2715';
  introClose.addEventListener('click', introDone);
  _intro.append(introText, introClose);

  _root.replaceChildren(svg, _tip, _intro);
  _svg = svg;
  applyTimelineTranslations();

  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', e => endDrag(e, true));
  svg.addEventListener('pointercancel', e => endDrag(e, false));
  svg.addEventListener('pointerleave', () => { if (!_drag) { hideTip(); showHover(undefined); } });
  // Escape abandons a drag, leaving the selection as it was.
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !_drag) return;
    e.stopPropagation(); // don't also unpin the filter bar or close a clip
    endDrag(null, false);
  }, true);
  _el['band'].addEventListener('keydown', e => onBandKey(e as KeyboardEvent));
  _el['handleFrom'].addEventListener('keydown', e => onHandleKey('from', e as KeyboardEvent));
  _el['handleTo'].addEventListener('keydown', e => onHandleKey('to', e as KeyboardEvent));

  new ResizeObserver(() => layout()).observe(_root);
}
