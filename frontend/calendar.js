// ── Calendar State ────────────────────────────────────────────────────────

let currentView = 'grid';
let calYear     = new Date().getFullYear();
let calMonth    = null;   // null = year view | 0–11 = month view
let calDay      = null;   // null | 'YYYY-MM-DD'
let calWeek     = null;   // null | 'YYYY-MM-DD' (Monday of selected week)
let calDateFrom = null;   // consumed by buildWhere() in app.js
let calDateTo   = null;   // exclusive upper bound
let calMinDate  = null;   // 'YYYY-MM-DD' — earliest clip in DB (set by initCalendar)
let calMaxDate  = null;   // 'YYYY-MM-DD' — latest  clip in DB (set by initCalendar)

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_LONG  = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const DOW_LABELS  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ── Date Utilities ────────────────────────────────────────────────────────
// All use integer-argument Date constructors to avoid UTC/local timezone
// pitfalls that arise when parsing 'YYYY-MM-DD' strings directly.

function daysInMonth(y, m) {
  // new Date(y, m+1, 0) = last day of month m (0-based)
  return new Date(y, m + 1, 0).getDate();
}

function firstDayOfMonth(y, m) {
  return new Date(y, m, 1).getDay(); // 0=Sun
}

function localDateStr(y, m, d) {
  // m is 0-based
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, mo - 1, d + n);
  return localDateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

function todayStr() {
  const t = new Date();
  return localDateStr(t.getFullYear(), t.getMonth(), t.getDate());
}

function weekStart(dateStr) {
  // Returns the Monday of the ISO week containing dateStr.
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt  = new Date(y, mo - 1, d);
  const dow = dt.getDay(); // 0=Sun
  const diff = dow === 0 ? 6 : dow - 1; // days back to Monday
  dt.setDate(dt.getDate() - diff);
  return localDateStr(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

function isoWeekNumber(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  // Set to nearest Thursday (ISO week rule)
  const dayNum = dt.getDay() || 7;
  dt.setDate(dt.getDate() + 4 - dayNum);
  const yearStart = new Date(dt.getFullYear(), 0, 1);
  return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
}

// ── Heat Color ────────────────────────────────────────────────────────────

function heatLevel(cnt) {
  if (!cnt)    return 0;
  if (cnt <= 5)  return 1;
  if (cnt <= 15) return 2;
  if (cnt <= 30) return 3;
  return 4;
}

function heatColor(cnt) {
  return `var(--cal-${heatLevel(cnt)})`;
}

// ── Date Filter Helpers ───────────────────────────────────────────────────

function setYearFilter(y) {
  calDateFrom = `${y}-01-01`;
  calDateTo   = `${y + 1}-01-01`;
  syncDateInputs();
}

function setMonthFilter(y, m) {
  const pad = n => String(n).padStart(2, '0');
  calDateFrom = `${y}-${pad(m + 1)}-01`;
  calDateTo   = m === 11
    ? `${y + 1}-01-01`
    : `${y}-${pad(m + 2)}-01`;
  syncDateInputs();
}

function clearCalDateFilter() {
  calDay      = null;
  calWeek     = null;
  calDateFrom = null;
  calDateTo   = null;
  syncDateInputs();
}

function syncDateInputs() {
  const fromEl = document.getElementById('date-from-input');
  const toEl   = document.getElementById('date-to-input');
  if (!fromEl) return;

  const fromVal = calDateFrom ?? '';
  // calDateTo is exclusive; display inclusive by showing the day before
  const toVal = calDateTo ? addDays(calDateTo, -1) : '';

  fromEl.value = fromVal;
  toEl.value   = toVal;

  // Absolute lower bound: never before first clip
  if (calMinDate) fromEl.setAttribute('min', calMinDate);
  else            fromEl.removeAttribute('min');

  // Absolute upper bound: never after last clip; tightened by cross-constraint
  const fromMax = toVal || calMaxDate;
  if (fromMax) fromEl.setAttribute('max', fromMax);
  else         fromEl.removeAttribute('max');

  // Cross-constraint lower bound for to-input; loosened to absolute min
  const toMin = fromVal || calMinDate;
  if (toMin) toEl.setAttribute('min', toMin);
  else       toEl.removeAttribute('min');

  // Absolute upper bound for to-input: never after last clip
  if (calMaxDate) toEl.setAttribute('max', calMaxDate);
  else            toEl.removeAttribute('max');
}

// ── SQL Query Helpers ─────────────────────────────────────────────────────
// q() is defined in app.js and available globally.

function queryYearDays(year) {
  return q(
    `SELECT strftime('%Y-%m-%d', created_at) AS day, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?
     GROUP BY day`,
    [`${year}-01-01`, `${year + 1}-01-01`]
  );
}

function queryMonthDays(year, month) {
  const from = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const to   = month === 11
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 2).padStart(2, '0')}-01`;
  return q(
    `SELECT strftime('%Y-%m-%d', created_at) AS day, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?
     GROUP BY day`,
    [from, to]
  );
}

function queryYearMonthTotals(year) {
  return q(
    `SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS cnt
     FROM clips
     WHERE created_at >= ? AND created_at < ?
     GROUP BY month`,
    [`${year}-01-01`, `${year + 1}-01-01`]
  );
}

// ── Main Dispatcher ───────────────────────────────────────────────────────

function renderCalendar() {
  const panel = document.getElementById('calendar-panel');
  panel.style.display = 'block';

  if (calMonth === null) {
    renderYearView();
  } else {
    renderMonthView();
  }

  renderNavControls();
}

function renderNavControls() {
  const ySel = document.getElementById('cal-year-select');
  if (ySel) ySel.value = calYear;

  // Parse DB boundaries (month/day are 1-based from split)
  const [mnY, mnM] = calMinDate ? calMinDate.split('-').map(Number) : [0,  1 ];
  const [mxY, mxM] = calMaxDate ? calMaxDate.split('-').map(Number) : [9999, 12];

  // Year arrow buttons: disable at DB year boundaries
  document.getElementById('cal-prev-year').disabled = (calYear <= mnY);
  document.getElementById('cal-next-year').disabled = (calYear >= mxY);

  const monthNav = document.getElementById('cal-month-nav');
  const dayNav   = document.getElementById('cal-day-nav');

  if (calMonth !== null) {
    const mSel = document.getElementById('cal-month-select');
    if (mSel) {
      mSel.value = calMonth;
      // Disable months outside the DB range for boundary years
      Array.from(mSel.options).forEach((opt, i) => {
        // i is 0-based; mnM/mxM are 1-based
        opt.disabled = (calYear === mnY && i < mnM - 1)
                    || (calYear === mxY && i > mxM - 1);
      });
    }

    // Month arrow buttons: disable when already at the min/max year-month
    document.getElementById('cal-prev-month').disabled =
      (calYear <= mnY && calMonth <= mnM - 1);
    document.getElementById('cal-next-month').disabled =
      (calYear >= mxY && calMonth >= mxM - 1);

    monthNav.style.display = 'flex';

    if (calDay !== null) {
      const dSel = document.getElementById('cal-day-select');
      if (dSel) {
        const total = daysInMonth(calYear, calMonth);
        dSel.innerHTML = '';
        for (let d = 1; d <= total; d++) {
          const dateKey = localDateStr(calYear, calMonth, d);
          const opt = document.createElement('option');
          opt.value = d;
          opt.textContent = d;
          // Disable days outside the absolute clip date range
          opt.disabled = (calMinDate && dateKey < calMinDate)
                      || (calMaxDate && dateKey > calMaxDate);
          dSel.appendChild(opt);
        }
        const [, , dd] = calDay.split('-');
        dSel.value = parseInt(dd, 10);
      }

      // Day arrow buttons: disable at absolute min/max dates
      document.getElementById('cal-prev-day').disabled =
        !!(calMinDate && calDay <= calMinDate);
      document.getElementById('cal-next-day').disabled =
        !!(calMaxDate && calDay >= calMaxDate);

      dayNav.style.display = 'flex';
    } else {
      dayNav.style.display = 'none';
    }
  } else {
    monthNav.style.display = 'none';
    dayNav.style.display = 'none';
  }
}

// ── Year View ─────────────────────────────────────────────────────────────

function renderYearView() {
  document.getElementById('cal-year-view').style.display  = 'grid';
  document.getElementById('cal-month-view').style.display = 'none';
  renderBreadcrumb();

  const yearData = queryYearDays(calYear);
  const dayMap   = Object.fromEntries(yearData.map(r => [r.day, r.cnt]));

  const container = document.getElementById('cal-year-view');
  container.innerHTML = '';

  for (let m = 0; m < 12; m++) {
    const totalDays = daysInMonth(calYear, m);
    const firstDow  = firstDayOfMonth(calYear, m);

    const card = document.createElement('div');
    card.className = 'mini-month';

    const title = document.createElement('div');
    title.className = 'mini-month-title';
    title.textContent = MONTH_SHORT[m];
    card.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'mini-month-grid';

    // Leading empty cells
    for (let e = 0; e < firstDow; e++) {
      const cell = document.createElement('div');
      cell.className = 'mini-day empty';
      grid.appendChild(cell);
    }
    // Day squares
    for (let day = 1; day <= totalDays; day++) {
      const key  = localDateStr(calYear, m, day);
      const cnt  = dayMap[key] ?? 0;
      const cell = document.createElement('div');
      cell.className = 'mini-day';
      cell.style.background = heatColor(cnt);
      if (cnt > 0) cell.title = `${key}: ${cnt} clip${cnt !== 1 ? 's' : ''}`;
      grid.appendChild(cell);
    }

    card.appendChild(grid);
    card.addEventListener('click', () => {
      calMonth = m;
      calDay   = null;
      calWeek  = null;
      setMonthFilter(calYear, m);
      renderCalendar();
      currentPage = 1;
      render();
    });
    container.appendChild(card);
  }
}

// ── Month View ────────────────────────────────────────────────────────────

function renderMonthView() {
  document.getElementById('cal-year-view').style.display  = 'none';
  document.getElementById('cal-month-view').style.display = 'block';
  renderBreadcrumb();
  renderYearStrip();
  renderMonthGrid();
}

function renderYearStrip() {
  const totals   = queryYearMonthTotals(calYear);
  const monthMap = Object.fromEntries(totals.map(r => [r.month, r.cnt]));

  const strip = document.getElementById('cal-year-strip');
  strip.innerHTML = '';

  for (let m = 0; m < 12; m++) {
    const key = `${calYear}-${String(m + 1).padStart(2, '0')}`;
    const cnt = monthMap[key] ?? 0;

    const el = document.createElement('div');
    el.className = 'strip-month' + (m === calMonth ? ' active' : '');
    el.textContent = MONTH_SHORT[m];
    el.title = `${MONTH_LONG[m]}: ${cnt.toLocaleString()} clip${cnt !== 1 ? 's' : ''}`;
    el.style.background = heatColor(cnt);

    el.addEventListener('click', () => {
      calMonth = m;
      calDay   = null;
      calWeek  = null;
      setMonthFilter(calYear, m);
      renderCalendar();
      currentPage = 1;
      render();
    });
    strip.appendChild(el);
  }
}

function renderMonthGrid() {
  const monthData = queryMonthDays(calYear, calMonth);
  const dayMap    = Object.fromEntries(monthData.map(r => [r.day, r.cnt]));

  const totalDays  = daysInMonth(calYear, calMonth);
  const firstDow   = firstDayOfMonth(calYear, calMonth);
  const today      = todayStr();
  const totalSlots = Math.ceil((firstDow + totalDays) / 7) * 7;

  const container = document.getElementById('cal-month-grid');
  container.innerHTML = '';

  // DOW header row
  const header = document.createElement('div');
  header.className = 'month-dow-header';
  // empty corner above week-number gutter
  header.appendChild(document.createElement('span'));
  DOW_LABELS.forEach(label => {
    const s = document.createElement('span');
    s.textContent = label;
    header.appendChild(s);
  });
  container.appendChild(header);

  let currentRow = null;

  for (let slot = 0; slot < totalSlots; slot++) {
    const col = slot % 7;
    const day = slot - firstDow + 1; // may be <1 or >totalDays for padding cells

    // Start a new row
    if (col === 0) {
      currentRow = document.createElement('div');
      currentRow.className = 'month-week-row';
      container.appendChild(currentRow);

      // Week gutter button — anchor on first real day of this row
      const firstRealDay = Math.max(1, Math.min(day, totalDays));
      const rowDateStr   = localDateStr(calYear, calMonth, firstRealDay);
      const rowWeekMon   = weekStart(rowDateStr);
      const weekNum      = isoWeekNumber(rowDateStr);

      const weekBtn = document.createElement('div');
      weekBtn.className = 'week-number-btn' + (calWeek === rowWeekMon ? ' selected' : '');
      weekBtn.textContent = weekNum;
      weekBtn.title = `Select week ${weekNum} (${rowWeekMon})`;
      weekBtn.addEventListener('click', () => selectWeek(rowWeekMon));
      currentRow.appendChild(weekBtn);
    }

    const cell = document.createElement('div');

    if (day < 1 || day > totalDays) {
      cell.className = 'month-day-cell empty';
    } else {
      const dateKey = localDateStr(calYear, calMonth, day);
      const cnt     = dayMap[dateKey] ?? 0;

      const classes = ['month-day-cell'];
      if (dateKey === today)   classes.push('today');
      if (dateKey === calDay)  classes.push('selected');
      cell.className = classes.join(' ');
      cell.style.background = heatColor(cnt);

      const numEl = document.createElement('div');
      numEl.className = 'day-number';
      numEl.textContent = day;
      cell.appendChild(numEl);

      if (cnt > 0) {
        const cntEl = document.createElement('div');
        cntEl.className = 'day-count';
        cntEl.textContent = `${cnt} clip${cnt !== 1 ? 's' : ''}`;
        cell.appendChild(cntEl);
      }

      cell.addEventListener('click', () => selectDay(dateKey));
    }

    currentRow.appendChild(cell);
  }
}

// ── Breadcrumb ────────────────────────────────────────────────────────────

function renderBreadcrumb() {
  const bc    = document.getElementById('cal-breadcrumb');
  const parts = [];

  if (calMonth === null) {
    parts.push(`<span class="crumb-current">${calYear}</span>`);
  } else {
    parts.push(`<span class="crumb" data-action="year">${calYear}</span>`);
  }

  if (calMonth !== null) {
    parts.push(`<span class="sep">›</span>`);
    if (calDay === null && calWeek === null) {
      parts.push(`<span class="crumb-current">${MONTH_LONG[calMonth]}</span>`);
    } else {
      parts.push(`<span class="crumb" data-action="month">${MONTH_LONG[calMonth]}</span>`);
    }
  }

  if (calDay !== null) {
    const [, , d] = calDay.split('-');
    parts.push(`<span class="sep">›</span>`);
    parts.push(`<span class="crumb-current">${parseInt(d, 10)}</span>`);
  } else if (calWeek !== null) {
    parts.push(`<span class="sep">›</span>`);
    parts.push(`<span class="crumb-current">Week of ${calWeek}</span>`);
  }

  bc.innerHTML = parts.join('');

  bc.querySelector('[data-action="year"]')?.addEventListener('click', () => {
    calMonth = null;
    calDay   = null;
    calWeek  = null;
    setYearFilter(calYear);
    renderCalendar();
    currentPage = 1;
    render();
  });

  bc.querySelector('[data-action="month"]')?.addEventListener('click', () => {
    calDay  = null;
    calWeek = null;
    setMonthFilter(calYear, calMonth);
    renderCalendar();
    currentPage = 1;
    render();
  });
}

// ── Selection ─────────────────────────────────────────────────────────────

function selectDay(dateStr) {
  calDay      = dateStr;
  calWeek     = null;
  calDateFrom = dateStr;
  calDateTo   = addDays(dateStr, 1);
  syncDateInputs();
  renderCalendar();
  currentPage = 1;
  render();
}

function selectWeek(weekMonStr) {
  calWeek     = weekMonStr;
  calDay      = null;
  calDateFrom = weekMonStr;
  calDateTo   = addDays(weekMonStr, 7);
  syncDateInputs();
  renderCalendar();
  currentPage = 1;
  render();
}

// ── View Switching ────────────────────────────────────────────────────────

function switchView(view) {
  currentView = view;

  const gridBtn  = document.getElementById('btn-view-grid');
  const calBtn   = document.getElementById('btn-view-cal');
  const calPanel = document.getElementById('calendar-panel');

  if (view === 'grid') {
    gridBtn.classList.add('active');
    calBtn.classList.remove('active');
    calPanel.style.display = 'none';
    clearCalDateFilter();
    currentPage = 1;
    render();
  } else {
    calBtn.classList.add('active');
    gridBtn.classList.remove('active');
    // Default to chronological sort when entering calendar
    sortBy = 'date_asc';
    document.getElementById('sort').value = 'date_asc';
    // Always start with a year-level filter so clips are visible immediately
    setYearFilter(calYear);
    renderCalendar();
    currentPage = 1;
    render();
  }
}

// ── Year / Month / Day Navigation ─────────────────────────────────────────

function prevYear() {
  const minY = calMinDate ? parseInt(calMinDate.slice(0, 4), 10) : 0;
  if (calYear <= minY) return;
  calYear--;
  calMonth = null;
  calDay   = null;
  calWeek  = null;
  setYearFilter(calYear);
  renderCalendar();
  currentPage = 1;
  render();
}

function nextYear() {
  const maxY = calMaxDate ? parseInt(calMaxDate.slice(0, 4), 10) : 9999;
  if (calYear >= maxY) return;
  calYear++;
  calMonth = null;
  calDay   = null;
  calWeek  = null;
  setYearFilter(calYear);
  renderCalendar();
  currentPage = 1;
  render();
}

function prevMonth() {
  const [mnY, mnM] = calMinDate ? calMinDate.split('-').map(Number) : [0, 1];
  if (calYear <= mnY && calMonth <= mnM - 1) return;
  if (calMonth === 0) { calMonth = 11; calYear--; }
  else                { calMonth--;               }
  calDay  = null;
  calWeek = null;
  setMonthFilter(calYear, calMonth);
  renderCalendar();
  currentPage = 1;
  render();
}

function nextMonth() {
  const [mxY, mxM] = calMaxDate ? calMaxDate.split('-').map(Number) : [9999, 12];
  if (calYear >= mxY && calMonth >= mxM - 1) return;
  if (calMonth === 11) { calMonth = 0; calYear++; }
  else                 { calMonth++;              }
  calDay  = null;
  calWeek = null;
  setMonthFilter(calYear, calMonth);
  renderCalendar();
  currentPage = 1;
  render();
}

function prevDay() {
  if (calMinDate && calDay <= calMinDate) return;
  const newDay = addDays(calDay, -1);
  const [y, m] = newDay.split('-').map(Number);
  calYear  = y;
  calMonth = m - 1; // 0-based
  selectDay(newDay);
}

function nextDay() {
  if (calMaxDate && calDay >= calMaxDate) return;
  const newDay = addDays(calDay, 1);
  const [y, m] = newDay.split('-').map(Number);
  calYear  = y;
  calMonth = m - 1; // 0-based
  selectDay(newDay);
}

// ── Init ──────────────────────────────────────────────────────────────────
// Called from app.js after the DB is loaded.

function initCalendar() {
  // Fetch the full date range of the clip archive in a single query
  const rangeRow = q(`
    SELECT MIN(strftime('%Y-%m-%d', created_at)) AS minD,
           MAX(strftime('%Y-%m-%d', created_at)) AS maxD
    FROM clips
  `);
  if (rangeRow.length && rangeRow[0].minD) {
    calMinDate = rangeRow[0].minD; // 'YYYY-MM-DD'
    calMaxDate = rangeRow[0].maxD;
  }

  const minY = calMinDate ? parseInt(calMinDate.slice(0, 4), 10) : new Date().getFullYear();
  const maxY = calMaxDate ? parseInt(calMaxDate.slice(0, 4), 10) : new Date().getFullYear();
  calYear = maxY;

  // Populate year select (only years that have clips)
  const ySel = document.getElementById('cal-year-select');
  for (let y = maxY; y >= minY; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    ySel.appendChild(opt);
  }
  ySel.value = calYear;

  // Sync date inputs with absolute DB bounds now that calMinDate/calMaxDate are set
  syncDateInputs();
  ySel.addEventListener('change', () => {
    calYear  = parseInt(ySel.value, 10);
    calMonth = null;
    calDay   = null;
    calWeek  = null;
    setYearFilter(calYear);
    renderCalendar();
    currentPage = 1;
    render();
  });

  // Populate month select (static 12 options)
  const mSel = document.getElementById('cal-month-select');
  MONTH_LONG.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = name;
    mSel.appendChild(opt);
  });
  mSel.addEventListener('change', () => {
    calMonth = parseInt(mSel.value, 10);
    calDay   = null;
    calWeek  = null;
    setMonthFilter(calYear, calMonth);
    renderCalendar();
    currentPage = 1;
    render();
  });

  // Day select — options populated dynamically in renderNavControls()
  document.getElementById('cal-day-select').addEventListener('change', e => {
    const d = parseInt(e.target.value, 10);
    selectDay(localDateStr(calYear, calMonth, d));
  });

  // Date range inputs
  document.getElementById('date-from-input').addEventListener('change', e => {
    calDateFrom = e.target.value || null;
    calDay      = null;
    calWeek     = null;
    const toVal = document.getElementById('date-to-input').value;
    calDateTo = toVal
      ? addDays(toVal, 1)
      : (calDateFrom ? addDays(calDateFrom, 1) : null);
    currentPage = 1;
    render();
  });
  document.getElementById('date-to-input').addEventListener('change', e => {
    const toVal = e.target.value;
    calDateTo = toVal ? addDays(toVal, 1) : null;
    calDay    = null;
    calWeek   = null;
    currentPage = 1;
    render();
  });

  // View switcher
  document.getElementById('btn-view-grid') .addEventListener('click', () => switchView('grid'));
  document.getElementById('btn-view-cal')  .addEventListener('click', () => switchView('calendar'));

  // Year / month / day arrow navigation
  document.getElementById('cal-prev-year') .addEventListener('click', prevYear);
  document.getElementById('cal-next-year') .addEventListener('click', nextYear);
  document.getElementById('cal-prev-month').addEventListener('click', prevMonth);
  document.getElementById('cal-next-month').addEventListener('click', nextMonth);
  document.getElementById('cal-prev-day')  .addEventListener('click', prevDay);
  document.getElementById('cal-next-day')  .addEventListener('click', nextDay);
}
