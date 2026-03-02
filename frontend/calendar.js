// ── Calendar State ────────────────────────────────────────────────────────

let currentView = 'grid';
let calYear     = new Date().getFullYear();
let calMonth    = null;   // null = year view | 0–11 = month view
let calDay      = null;   // null | 'YYYY-MM-DD'
let calWeek     = null;   // null | 'YYYY-MM-DD' (Monday of selected week)
let calDateFrom = null;   // consumed by buildWhere() in app.js
let calDateTo   = null;   // exclusive upper bound

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
  document.getElementById('cal-year-label').textContent = calYear;

  if (calMonth === null) {
    renderYearView();
  } else {
    renderMonthView();
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
      clearCalDateFilter();
      renderCalendar();
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
      clearCalDateFilter();
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
    clearCalDateFilter();
    renderCalendar();
    currentPage = 1;
    render();
  });

  bc.querySelector('[data-action="month"]')?.addEventListener('click', () => {
    clearCalDateFilter();
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
  showClipsGrid();
  renderCalendar();
  currentPage = 1;
  render();
  scrollToClips();
}

function selectWeek(weekMonStr) {
  calWeek     = weekMonStr;
  calDay      = null;
  calDateFrom = weekMonStr;
  calDateTo   = addDays(weekMonStr, 7);
  showClipsGrid();
  renderCalendar();
  currentPage = 1;
  render();
  scrollToClips();
}

function clearCalDateFilter() {
  calDay      = null;
  calWeek     = null;
  calDateFrom = null;
  calDateTo   = null;
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
    showClipsGrid();
    currentPage = 1;
    render();
  } else {
    calBtn.classList.add('active');
    gridBtn.classList.remove('active');
    // Hide clip grid until a date is selected
    if (calDateFrom === null) hideClipsGrid();
    renderCalendar();
  }
}

function showClipsGrid() {
  document.getElementById('clips-grid').style.removeProperty('display');
  document.getElementById('pagination').style.removeProperty('display');
  document.getElementById('empty').style.removeProperty('display');
}

function hideClipsGrid() {
  document.getElementById('clips-grid').style.display  = 'none';
  document.getElementById('pagination').style.display  = 'none';
  document.getElementById('empty').style.display       = 'none';
}

function scrollToClips() {
  document.getElementById('clips-grid')
    .scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Year Navigation ───────────────────────────────────────────────────────

function prevYear() {
  calYear--;
  calMonth = null;
  clearCalDateFilter();
  hideClipsGrid();
  renderCalendar();
}

function nextYear() {
  calYear++;
  calMonth = null;
  clearCalDateFilter();
  hideClipsGrid();
  renderCalendar();
}

// ── Init ──────────────────────────────────────────────────────────────────
// Called from app.js after the DB is loaded.

function initCalendar() {
  // Default to the most recent year that has clip data
  const row = q("SELECT MAX(strftime('%Y', created_at)) AS yr FROM clips");
  if (row.length && row[0].yr) calYear = parseInt(row[0].yr, 10);

  document.getElementById('btn-view-grid').addEventListener('click', () => switchView('grid'));
  document.getElementById('btn-view-cal') .addEventListener('click', () => switchView('calendar'));
  document.getElementById('cal-prev-year').addEventListener('click', prevYear);
  document.getElementById('cal-next-year').addEventListener('click', nextYear);
}
