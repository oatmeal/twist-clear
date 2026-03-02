import * as state from './state';
import { q } from './db';
import {
  daysInMonth,
  firstDayOfMonth,
  localDateStr,
  addDays,
  todayStr,
  weekStart,
  isoWeekNumber,
} from './lib/dateUtils';

// ── Constants ─────────────────────────────────────────────────────────────

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_LONG  = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const DOW_LABELS  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ── Render callback ───────────────────────────────────────────────────────
// Injected by app.ts via initCalendar() to avoid a circular import.

let _onRender: (() => void) | null = null;

function callRender(): void {
  _onRender?.();
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

  // Absolute lower bound: never before first clip
  if (state.calMinDate) fromEl.setAttribute('min', state.calMinDate);
  else                  fromEl.removeAttribute('min');

  // Absolute upper bound: never after last clip; tightened by cross-constraint
  const fromMax = toVal || state.calMaxDate;
  if (fromMax) fromEl.setAttribute('max', fromMax);
  else         fromEl.removeAttribute('max');

  // Cross-constraint lower bound for to-input
  const toMin = fromVal || state.calMinDate;
  if (toMin) toEl.setAttribute('min', toMin);
  else       toEl.removeAttribute('min');

  // Absolute upper bound for to-input
  if (state.calMaxDate) toEl.setAttribute('max', state.calMaxDate);
  else                  toEl.removeAttribute('max');
}

// ── DB queries ────────────────────────────────────────────────────────────

function queryYearDays(year: number): { day: string; cnt: number }[] {
  return q(
    `SELECT strftime('%Y-%m-%d', created_at) AS day, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?
     GROUP BY day`,
    [`${year}-01-01`, `${year + 1}-01-01`],
  ) as { day: string; cnt: number }[];
}

function queryMonthDays(year: number, month: number): { day: string; cnt: number }[] {
  const from = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const to   = month === 11
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 2).padStart(2, '0')}-01`;
  return q(
    `SELECT strftime('%Y-%m-%d', created_at) AS day, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?
     GROUP BY day`,
    [from, to],
  ) as { day: string; cnt: number }[];
}

function queryYearMonthTotals(year: number): { month: string; cnt: number }[] {
  return q(
    `SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?
     GROUP BY month`,
    [`${year}-01-01`, `${year + 1}-01-01`],
  ) as { month: string; cnt: number }[];
}

// ── Main calendar dispatcher ──────────────────────────────────────────────

export function renderCalendar(): void {
  const panel = document.getElementById('calendar-panel')!;
  panel.style.display = 'block';

  if (state.calMonth === null) {
    renderYearView();
  } else {
    renderMonthView();
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

function renderYearView(): void {
  document.getElementById('cal-year-view')!.style.display  = 'grid';
  document.getElementById('cal-month-view')!.style.display = 'none';
  renderBreadcrumb();

  const yearData = queryYearDays(state.calYear);
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
    title.textContent = MONTH_SHORT[m]!;
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
      if (cnt > 0) cell.title = `${key}: ${cnt} clip${cnt !== 1 ? 's' : ''}`;
      grid.appendChild(cell);
    }

    card.appendChild(grid);
    card.addEventListener('click', () => {
      state.setCalMonth(m);
      state.setCalDay(null);
      state.setCalWeek(null);
      setMonthFilter(state.calYear, m);
      renderCalendar();
      state.setCurrentPage(1);
      callRender();
    });
    container.appendChild(card);
  }
}

// ── Month view ────────────────────────────────────────────────────────────

function renderMonthView(): void {
  document.getElementById('cal-year-view')!.style.display  = 'none';
  document.getElementById('cal-month-view')!.style.display = 'block';
  renderBreadcrumb();
  renderYearStrip();
  renderMonthGrid();
}

function renderYearStrip(): void {
  const totals   = queryYearMonthTotals(state.calYear);
  const monthMap = Object.fromEntries(totals.map(r => [r.month, r.cnt]));

  const strip = document.getElementById('cal-year-strip')!;
  strip.innerHTML = '';

  for (let m = 0; m < 12; m++) {
    const key = `${state.calYear}-${String(m + 1).padStart(2, '0')}`;
    const cnt = (monthMap[key] as number | undefined) ?? 0;

    const el = document.createElement('div');
    el.className = 'strip-month' + (m === state.calMonth ? ' active' : '');
    el.textContent = MONTH_SHORT[m]!;
    el.title = `${MONTH_LONG[m]}: ${cnt.toLocaleString()} clip${cnt !== 1 ? 's' : ''}`;
    el.style.background = heatColor(cnt);

    el.addEventListener('click', () => {
      state.setCalMonth(m);
      state.setCalDay(null);
      state.setCalWeek(null);
      setMonthFilter(state.calYear, m);
      renderCalendar();
      state.setCurrentPage(1);
      callRender();
    });
    strip.appendChild(el);
  }
}

function renderMonthGrid(): void {
  const monthData = queryMonthDays(state.calYear, state.calMonth!);
  const dayMap    = Object.fromEntries(monthData.map(r => [r.day, r.cnt]));

  const totalDays  = daysInMonth(state.calYear, state.calMonth!);
  const firstDow   = firstDayOfMonth(state.calYear, state.calMonth!);
  const today      = todayStr();
  const totalSlots = Math.ceil((firstDow + totalDays) / 7) * 7;

  const container = document.getElementById('cal-month-grid')!;
  container.innerHTML = '';

  // DOW header row
  const header = document.createElement('div');
  header.className = 'month-dow-header';
  header.appendChild(document.createElement('span')); // empty corner above week gutter
  DOW_LABELS.forEach(label => {
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
      weekBtn.title = `Select week ${weekNum} (${rowWeekMon})`;
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

      const numEl = document.createElement('div');
      numEl.className = 'day-number';
      numEl.textContent = String(day);
      cell.appendChild(numEl);

      if (cnt > 0) {
        const cntEl = document.createElement('div');
        cntEl.className = 'day-count';
        cntEl.textContent = `${cnt} clip${cnt !== 1 ? 's' : ''}`;
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
      parts.push(`<span class="crumb-current">${MONTH_LONG[state.calMonth]}</span>`);
    } else {
      parts.push(`<span class="crumb" data-action="month">${MONTH_LONG[state.calMonth]}</span>`);
    }
  }

  if (state.calDay !== null) {
    const dd = state.calDay.split('-')[2];
    parts.push(`<span class="sep">›</span>`);
    parts.push(`<span class="crumb-current">${parseInt(dd!, 10)}</span>`);
  } else if (state.calWeek !== null) {
    parts.push(`<span class="sep">›</span>`);
    parts.push(`<span class="crumb-current">Week of ${state.calWeek}</span>`);
  }

  bc.innerHTML = parts.join('');

  bc.querySelector('[data-action="year"]')?.addEventListener('click', () => {
    state.setCalMonth(null);
    state.setCalDay(null);
    state.setCalWeek(null);
    setYearFilter(state.calYear);
    renderCalendar();
    state.setCurrentPage(1);
    callRender();
  });

  bc.querySelector('[data-action="month"]')?.addEventListener('click', () => {
    state.setCalDay(null);
    state.setCalWeek(null);
    setMonthFilter(state.calYear, state.calMonth!);
    renderCalendar();
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
  renderCalendar();
  state.setCurrentPage(1);
  callRender();
}

function selectWeek(weekMonStr: string): void {
  state.setCalWeek(weekMonStr);
  state.setCalDay(null);
  state.setCalDateFrom(weekMonStr);
  state.setCalDateTo(addDays(weekMonStr, 7));
  syncDateInputs();
  renderCalendar();
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
    renderCalendar();
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
  renderCalendar();
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
  renderCalendar();
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
  renderCalendar();
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
  renderCalendar();
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

export function initCalendar(onRender: () => void): void {
  _onRender = onRender;

  const rangeRow = q(`
    SELECT MIN(strftime('%Y-%m-%d', created_at)) AS minD,
           MAX(strftime('%Y-%m-%d', created_at)) AS maxD
    FROM clips
  `);
  if (rangeRow.length && rangeRow[0]!['minD']) {
    state.setCalMinDate(rangeRow[0]!['minD'] as string);
    state.setCalMaxDate(rangeRow[0]!['maxD'] as string);
  }

  const minY = state.calMinDate ? parseInt(state.calMinDate.slice(0, 4), 10) : new Date().getFullYear();
  const maxY = state.calMaxDate ? parseInt(state.calMaxDate.slice(0, 4), 10) : new Date().getFullYear();
  state.setCalYear(maxY);

  const ySel = document.getElementById('cal-year-select') as HTMLSelectElement;
  for (let y = maxY; y >= minY; y--) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    ySel.appendChild(opt);
  }
  ySel.value = String(state.calYear);

  syncDateInputs();

  ySel.addEventListener('change', () => {
    state.setCalYear(parseInt(ySel.value, 10));
    state.setCalMonth(null);
    state.setCalDay(null);
    state.setCalWeek(null);
    setYearFilter(state.calYear);
    renderCalendar();
    state.setCurrentPage(1);
    callRender();
  });

  const mSel = document.getElementById('cal-month-select') as HTMLSelectElement;
  MONTH_LONG.forEach((name, i) => {
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
    renderCalendar();
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
    state.setCalDateTo(
      toVal ? addDays(toVal, 1) : (state.calDateFrom ? addDays(state.calDateFrom, 1) : null),
    );
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
