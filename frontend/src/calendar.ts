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
import { t } from './lib/i18n';

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
    const day = utcTimestampToLocalDate(c.created_at, state.tzOffset);
    if (day.startsWith(`${year}-`)) {
      counts[day] = (counts[day] ?? 0) + 1;
    }
  }
  return counts;
}

/** YYYY-MM → count for live clips falling in the given calendar year (local time). */
function liveMonthCountsForYear(year: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of state.liveClips) {
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
    const day = utcTimestampToLocalDate(c.created_at, state.tzOffset);
    if (day.startsWith(prefix)) {
      counts[day] = (counts[day] ?? 0) + 1;
    }
  }
  return counts;
}

// ── Date-range helpers ────────────────────────────────────────────────────

/**
 * True when dateStr (YYYY-MM-DD) falls within the active calendar filter range.
 * calDateTo is exclusive, matching the rest of the codebase convention.
 */
function isInRange(dateStr: string): boolean {
  return !!(
    state.calDateFrom &&
    state.calDateTo &&
    dateStr >= state.calDateFrom &&
    dateStr < state.calDateTo
  );
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
 */
function monthFullyInRange(year: number, month: number): boolean {
  if (!state.calDateFrom || !state.calDateTo) return false;
  const pad    = (n: number) => String(n).padStart(2, '0');
  const mStart = `${year}-${pad(month + 1)}-01`;
  const mEnd   = month === 11 ? `${year + 1}-01-01` : `${year}-${pad(month + 2)}-01`;
  return state.calDateFrom <= mStart && state.calDateTo >= mEnd;
}

/**
 * True when the calendar month (0-based) overlaps the active filter range at all.
 * Used to highlight year-strip pills that touch the selection.
 */
function monthOverlapsRange(year: number, month: number): boolean {
  if (!state.calDateFrom && !state.calDateTo) return false;
  const pad      = (n: number) => String(n).padStart(2, '0');
  const mStart   = `${year}-${pad(month + 1)}-01`;
  const mEnd     = month === 11 ? `${year + 1}-01-01` : `${year}-${pad(month + 2)}-01`;
  const from     = state.calDateFrom;
  const to       = state.calDateTo;
  // Both bounds present: overlap if from < mEnd AND to > mStart.
  if (from && to)   return from < mEnd && to > mStart;
  if (from)         return mEnd  > from;  // open upper bound
  if (to)           return mStart < to;   // open lower bound
  return false;
}

// ── DB queries ────────────────────────────────────────────────────────────

async function queryYearDays(year: number): Promise<{ day: string; cnt: number }[]> {
  const mod  = tzToSqlModifier(state.tzOffset);
  const from = localDateToUtcBound(`${year}-01-01`, state.tzOffset);
  const to   = localDateToUtcBound(`${year + 1}-01-01`, state.tzOffset);
  return (await q(
    `SELECT strftime('%Y-%m-%d', created_at, ?) AS day, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?
     GROUP BY day`,
    [mod, from, to],
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
  return (await q(
    `SELECT strftime('%Y-%m-%d', created_at, ?) AS day, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?
     GROUP BY day`,
    [mod, from, to],
  )) as { day: string; cnt: number }[];
}

async function queryYearMonthTotals(year: number): Promise<{ month: string; cnt: number }[]> {
  const mod  = tzToSqlModifier(state.tzOffset);
  const from = localDateToUtcBound(`${year}-01-01`, state.tzOffset);
  const to   = localDateToUtcBound(`${year + 1}-01-01`, state.tzOffset);
  return (await q(
    `SELECT strftime('%Y-%m', created_at, ?) AS month, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?
     GROUP BY month`,
    [mod, from, to],
  )) as { month: string; cnt: number }[];
}

// ── Main calendar dispatcher ──────────────────────────────────────────────

export async function renderCalendar(): Promise<void> {
  const panel = document.getElementById('calendar-panel')!;
  panel.style.display = 'block';

  if (state.calMonth === null) {
    await renderYearView();
  } else {
    await renderMonthView();
  }

  renderNavControls();
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

async function renderYearView(): Promise<void> {
  document.getElementById('cal-year-view')!.style.display  = 'grid';
  document.getElementById('cal-month-view')!.style.display = 'none';
  renderBreadcrumb();

  const yearData = await queryYearDays(state.calYear);
  const dayMap   = Object.fromEntries(yearData.map(r => [r.day, r.cnt]));

  // Merge live clip counts (live clips are always newer than the DB cutoff,
  // so they appear at the end and never overlap archived days).
  for (const [day, cnt] of Object.entries(liveDayCountsForYear(state.calYear))) {
    dayMap[day] = ((dayMap[day] as number | undefined) ?? 0) + cnt;
  }

  const monthTotals = new Array<number>(12).fill(0);
  for (const [key, cnt] of Object.entries(dayMap)) {
    monthTotals[parseInt(key.slice(5, 7), 10) - 1]! += cnt as number;
  }

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
      cell.style.background = heatColor(cnt);
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
    container.appendChild(card);
  }
}

// ── Month view ────────────────────────────────────────────────────────────

async function renderMonthView(): Promise<void> {
  document.getElementById('cal-year-view')!.style.display  = 'none';
  document.getElementById('cal-month-view')!.style.display = 'block';
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

  for (let m = 0; m < 12; m++) {
    const key = `${state.calYear}-${String(m + 1).padStart(2, '0')}`;
    const cnt = (monthMap[key] as number | undefined) ?? 0;

    const el = document.createElement('div');
    const classes = ['strip-month'];
    if (m === state.calMonth)               classes.push('active');
    if (monthOverlapsRange(state.calYear, m)) classes.push('in-range');
    el.className = classes.join(' ');
    el.textContent = t().monthShort[m]!;
    el.title = t().monthTooltip(t().monthLong[m]!, cnt);
    el.style.background = heatColor(cnt);
    el.dataset.heat = String(heatLevel(cnt));

    el.addEventListener('click', () => {
      state.setCalMonth(m);
      state.setCalDay(null);
      state.setCalWeek(null);
      setMonthFilter(state.calYear, m);
      void renderCalendar();
      state.setCurrentPage(1);
      callRender();
    });
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
      cell.style.background = heatColor(cnt);
      cell.dataset.heat = String(heatLevel(cnt));

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
    }

    currentRow!.appendChild(cell);
  }
}

// ── Breadcrumb ────────────────────────────────────────────────────────────

function renderBreadcrumb(): void {
  const bc    = document.getElementById('cal-breadcrumb')!;
  const parts: string[] = [];

  if (state.calMonth === null) {
    parts.push(`<span class="crumb-current">${state.calYear}</span>`);
  } else {
    parts.push(`<span class="crumb" data-action="year">${state.calYear}</span>`);
  }

  if (state.calMonth !== null) {
    parts.push(`<span class="sep">›</span>`);
    if (state.calDay === null && state.calWeek === null) {
      parts.push(`<span class="crumb-current">${t().monthLong[state.calMonth]!}</span>`);
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

  bc.querySelector('[data-action="month"]')?.addEventListener('click', () => {
    state.setCalDay(null);
    state.setCalWeek(null);
    setMonthFilter(state.calYear, state.calMonth!);
    void renderCalendar();
    state.setCurrentPage(1);
    callRender();
  });
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

export function switchView(view: 'grid' | 'calendar'): void {
  state.setCurrentView(view);

  const gridBtn  = document.getElementById('btn-view-grid')!;
  const calBtn   = document.getElementById('btn-view-cal')!;
  const calPanel = document.getElementById('calendar-panel')!;

  if (view === 'grid') {
    gridBtn.classList.add('active');
    calBtn.classList.remove('active');
    calPanel.style.display = 'none';
    clearCalDateFilter();
    state.setCurrentPage(1);
    callRender();
  } else {
    calBtn.classList.add('active');
    gridBtn.classList.remove('active');
    setYearFilter(state.calYear);
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
  setYearFilter(state.calYear);
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
  setYearFilter(state.calYear);
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
  setMonthFilter(state.calYear, state.calMonth!);
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
  setMonthFilter(state.calYear, state.calMonth!);
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
    setYearFilter(state.calYear);
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
    setMonthFilter(state.calYear, state.calMonth!);
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
    void renderCalendar();
    callRender();
  });

  const toInput = document.getElementById('date-to-input') as HTMLInputElement;
  toInput.addEventListener('change', e => {
    const val = (e.target as HTMLInputElement).value;
    state.setCalDateTo(val ? addDays(val, 1) : null);
    state.setCalDay(null);
    state.setCalWeek(null);
    state.setCurrentPage(1);
    void renderCalendar();
    callRender();
  });

  document.getElementById('btn-view-grid')!.addEventListener('click', () => switchView('grid'));
  document.getElementById('btn-view-cal')!.addEventListener('click', () => switchView('calendar'));

  document.getElementById('cal-prev-year')!.addEventListener('click', prevYear);
  document.getElementById('cal-next-year')!.addEventListener('click', nextYear);
  document.getElementById('cal-prev-month')!.addEventListener('click', prevMonth);
  document.getElementById('cal-next-month')!.addEventListener('click', nextMonth);
  document.getElementById('cal-prev-day')!.addEventListener('click', prevDay);
  document.getElementById('cal-next-day')!.addEventListener('click', nextDay);
}
