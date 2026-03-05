import * as state from './state';
import { q } from './db';
import {
  daysInMonth,
  firstDayOfMonth,
  localDateStr,
  addDays,
  weekStart,
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

    const card = document.createElement('div');
    card.className = 'mini-month';

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

  const strip = document.getElementById('cal-year-strip')!;
  strip.innerHTML = '';

  for (let m = 0; m < 12; m++) {
    const key = `${state.calYear}-${String(m + 1).padStart(2, '0')}`;
    const cnt = (monthMap[key] as number | undefined) ?? 0;

    const el = document.createElement('div');
    el.className = 'strip-month' + (m === state.calMonth ? ' active' : '');
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

      const firstRealDay = Math.max(1, Math.min(day, totalDays));
      const rowDateStr   = localDateStr(state.calYear, state.calMonth!, firstRealDay);
      const rowWeekMon   = weekStart(rowDateStr);
      const weekNum      = isoWeekNumber(rowDateStr);

      const weekBtn = document.createElement('div');
      weekBtn.className = 'week-number-btn' + (state.calWeek === rowWeekMon ? ' selected' : '');
      weekBtn.textContent = String(weekNum);
      weekBtn.title = t().selectWeek(weekNum, rowWeekMon);
      weekBtn.addEventListener('click', () => selectWeek(rowWeekMon));
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
    state.setSortBy('date_asc');
    (document.getElementById('sort') as HTMLSelectElement).value = 'date_asc';
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
    callRender();
  });

  const toInput = document.getElementById('date-to-input') as HTMLInputElement;
  toInput.addEventListener('change', e => {
    const val = (e.target as HTMLInputElement).value;
    state.setCalDateTo(val ? addDays(val, 1) : null);
    state.setCalDay(null);
    state.setCalWeek(null);
    state.setCurrentPage(1);
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
