// Path to the SQLite DB relative to this HTML file when served via HTTP.
const DB_URL = '../data/clips.db';
const PAGE_SIZE = 24;

let db          = null;
let currentPage = 1;
let totalClips  = 0;
let searchQuery = '';
let sortBy      = 'view_count_desc';
let gameFilter  = '';
let searchTimer = null;

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  try {
    const SQL = await initSqlJs({
      locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`
    });

    const res = await fetch(DB_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${DB_URL}`);

    const buf = await res.arrayBuffer();
    db = new SQL.Database(new Uint8Array(buf));

    document.getElementById('loading').style.display = 'none';
    document.getElementById('controls').style.display = 'flex';

    setStreamerTag();
    populateGameFilter();
    bindEvents();
    initCalendar(); // must come before applyStateHash so selects are populated

    // Restore from URL hash (permalink), otherwise just render the default view
    if (location.hash && location.hash.length > 1) {
      applyStateHash(location.hash);
    } else {
      render();
    }

    // Re-apply state if the user edits the hash manually in the address bar
    window.addEventListener('hashchange', () => {
      if (location.hash && location.hash.length > 1) {
        applyStateHash(location.hash);
      } else {
        // Empty hash → reset to default state
        searchQuery = ''; sortBy = 'view_count_desc'; gameFilter = ''; currentPage = 1;
        currentView = 'grid';
        clearCalDateFilter();
        document.getElementById('search').value      = '';
        document.getElementById('sort').value        = 'view_count_desc';
        document.getElementById('game-filter').value = '';
        document.getElementById('btn-view-grid').classList.add('active');
        document.getElementById('btn-view-cal').classList.remove('active');
        document.getElementById('calendar-panel').style.display = 'none';
        render();
      }
    });
  } catch (err) {
    document.getElementById('loading').style.display = 'none';
    const el = document.getElementById('error');
    el.style.display = 'block';
    el.innerHTML =
      `<strong>Could not load the database.</strong><br>` +
      `${escHtml(err.message)}<br><br>` +
      `Make sure you are serving this page over HTTP (not <code>file://</code>) ` +
      `and that <code>data/clips.db</code> is accessible from the server root. ` +
      `Run: <code>uv run python -m http.server 8765</code> from the worktree directory.`;
  }
}

// ── URL hash state (permalink) ─────────────────────────────────────────────

// Serialize current app + calendar state into a URLSearchParams hash string.
// Default values are omitted to keep URLs short.
function getStateHash() {
  const p = new URLSearchParams();

  // App state (omit defaults)
  if (currentView === 'calendar')       p.set('view', 'calendar');
  if (searchQuery)                      p.set('q',    searchQuery);
  if (sortBy !== 'view_count_desc')     p.set('sort', sortBy);
  if (gameFilter)                       p.set('game', gameFilter);
  if (currentPage > 1)                  p.set('page', currentPage);

  // Date filter (present in both views when set via the date inputs)
  if (calDateFrom !== null)             p.set('from', calDateFrom);
  if (calDateTo   !== null)             p.set('to',   calDateTo);

  // Calendar navigation position (only meaningful in calendar view)
  if (currentView === 'calendar') {
    p.set('year', calYear);
    if (calMonth !== null)              p.set('month', calMonth);
    if (calDay   !== null)              p.set('day',   calDay);
    if (calWeek  !== null)              p.set('week',  calWeek);
  }

  return p.toString();
}

// Write current state to location.hash without creating a browser history entry.
function pushHash() {
  const s = getStateHash();
  history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
}

// Parse a hash string and restore all state, then re-render.
// Called on page load (if a hash is present) and on hashchange.
function applyStateHash(hashStr) {
  const p = new URLSearchParams(hashStr.replace(/^#/, ''));

  // App state
  searchQuery = p.get('q')     || '';
  sortBy      = p.get('sort')  || 'view_count_desc';
  gameFilter  = p.get('game')  || '';
  currentPage = parseInt(p.get('page') || '1', 10);

  // Calendar date filter
  calDateFrom = p.get('from') || null;
  calDateTo   = p.get('to')   || null;

  // Calendar navigation position
  if (p.has('year')) calYear = parseInt(p.get('year'), 10);
  calMonth = p.has('month') ? parseInt(p.get('month'), 10) : null;
  calDay   = p.get('day')   || null;
  calWeek  = p.get('week')  || null;

  // Sync DOM controls
  document.getElementById('search').value       = searchQuery;
  document.getElementById('sort').value         = sortBy;
  document.getElementById('game-filter').value  = gameFilter;
  const ySel = document.getElementById('cal-year-select');
  if (ySel) ySel.value = calYear;
  syncDateInputs(); // defined in calendar.js

  // View-specific rendering
  const isCalendar = p.get('view') === 'calendar';
  if (isCalendar) {
    currentView = 'calendar';
    document.getElementById('btn-view-cal').classList.add('active');
    document.getElementById('btn-view-grid').classList.remove('active');
    renderCalendar(); // defined in calendar.js
  } else {
    currentView = 'grid';
    document.getElementById('btn-view-grid').classList.add('active');
    document.getElementById('btn-view-cal').classList.remove('active');
    document.getElementById('calendar-panel').style.display = 'none';
  }

  render();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function q(sql, params) {
  const res = db.exec(sql, params);
  if (!res.length) return [];
  const cols = res[0].columns;
  return res[0].values.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDuration(secs) {
  const s = Math.round(secs);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtViews(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

// ── Populate UI from DB ───────────────────────────────────────────────────

function setStreamerTag() {
  const rows = q('SELECT display_name, login FROM streamers LIMIT 1');
  if (rows.length) {
    const { display_name, login } = rows[0];
    document.getElementById('streamer-tag').textContent =
      display_name ? `${display_name} (${login})` : login;
  }
}

function populateGameFilter() {
  const rows = q(`
    SELECT g.id, g.name, COUNT(c.id) as cnt
    FROM games g
    JOIN clips c ON c.game_id = g.id
    GROUP BY g.id
    ORDER BY cnt DESC
  `);
  const sel = document.getElementById('game-filter');
  for (const { id, name, cnt } of rows) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${name} (${cnt.toLocaleString()})`;
    sel.appendChild(opt);
  }
}

// ── Query building ────────────────────────────────────────────────────────

function buildWhere() {
  const parts  = [];
  const params = {};
  if (searchQuery) {
    parts.push('c.title LIKE :search');
    params[':search'] = `%${searchQuery}%`;
  }
  if (gameFilter) {
    parts.push('c.game_id = :game');
    params[':game'] = gameFilter;
  }
  if (calDateFrom !== null) {
    parts.push('c.created_at >= :dateFrom AND c.created_at < :dateTo');
    params[':dateFrom'] = calDateFrom;
    params[':dateTo']   = calDateTo;
  }
  return {
    where:  parts.length ? `WHERE ${parts.join(' AND ')}` : '',
    params,
  };
}

const ORDER = {
  view_count_desc: 'c.view_count DESC',
  view_count_asc:  'c.view_count ASC',
  date_desc:       'c.created_at DESC',
  date_asc:        'c.created_at ASC',
};

// ── Render ────────────────────────────────────────────────────────────────

function render() {
  const { where, params } = buildWhere();

  const countRes = db.exec(`SELECT COUNT(*) FROM clips c ${where}`, params);
  totalClips = countRes[0].values[0][0];

  const offset = (currentPage - 1) * PAGE_SIZE;
  const clips = q(`
    SELECT c.id, c.title, c.creator_name, c.view_count,
           c.created_at, c.duration, c.thumbnail_url, c.url,
           COALESCE(g.name, '') AS game_name
    FROM clips c
    LEFT JOIN games g ON c.game_id = g.id
    ${where}
    ORDER BY ${ORDER[sortBy]}
    LIMIT ${PAGE_SIZE} OFFSET ${offset}
  `, params);

  document.getElementById('result-count').textContent =
    `${totalClips.toLocaleString()} clip${totalClips !== 1 ? 's' : ''}`;

  const grid  = document.getElementById('clips-grid');
  const empty = document.getElementById('empty');

  if (!clips.length) {
    grid.innerHTML = '';
    empty.style.display = 'block';
  } else {
    empty.style.display = 'none';
    grid.innerHTML = clips.map(c => `
      <div class="clip-card">
        <div class="clip-thumb">
          <a href="${escHtml(c.url)}" target="_blank" rel="noopener noreferrer">
            <img src="${escHtml(c.thumbnail_url)}" alt="${escHtml(c.title)}"
                 loading="lazy" onerror="this.classList.add('broken')">
            <div class="clip-play-icon">
              <svg viewBox="0 0 24 24" fill="white">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </div>
          </a>
          <span class="clip-duration">${fmtDuration(c.duration)}</span>
        </div>
        <div class="clip-info">
          <div class="clip-title">
            <a href="${escHtml(c.url)}" target="_blank" rel="noopener noreferrer">
              ${escHtml(c.title)}
            </a>
          </div>
          <div class="clip-meta">
            <span class="views">${fmtViews(c.view_count)} views</span>
            ${c.game_name ? `<span>${escHtml(c.game_name)}</span>` : ''}
            <span>by ${escHtml(c.creator_name)} &middot; ${fmtDateTime(c.created_at)}</span>
          </div>
        </div>
      </div>
    `).join('');
  }

  renderPagination();
  pushHash();
}

function renderPagination() {
  const totalPages = Math.ceil(totalClips / PAGE_SIZE);
  const pg = document.getElementById('pagination');
  if (totalPages <= 1) { pg.innerHTML = ''; return; }

  // Build set of page numbers to show: first, last, current ± 2
  const show = new Set([1, totalPages]);
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
    show.add(i);
  }
  const sorted = [...show].sort((a, b) => a - b);

  const parts = [];
  parts.push(`<button id="pg-prev" ${currentPage === 1 ? 'disabled' : ''}>&#8249;</button>`);

  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) parts.push(`<span class="pg-ellipsis">&hellip;</span>`);
    parts.push(`<button class="pg-btn${p === currentPage ? ' active' : ''}" data-page="${p}">${p}</button>`);
    prev = p;
  }
  parts.push(`<button id="pg-next" ${currentPage === totalPages ? 'disabled' : ''}>&#8250;</button>`);
  pg.innerHTML = parts.join('');

  pg.querySelector('#pg-prev').addEventListener('click', () => goPage(currentPage - 1));
  pg.querySelector('#pg-next').addEventListener('click', () => goPage(currentPage + 1));
  pg.querySelectorAll('.pg-btn').forEach(btn =>
    btn.addEventListener('click', () => goPage(Number(btn.dataset.page)))
  );
}

function goPage(p) {
  currentPage = p;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Event binding ─────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value.trim();
      currentPage = 1;
      render();
    }, 300);
  });

  document.getElementById('sort').addEventListener('change', e => {
    sortBy = e.target.value;
    currentPage = 1;
    render();
  });

  document.getElementById('game-filter').addEventListener('change', e => {
    gameFilter = e.target.value;
    currentPage = 1;
    render();
  });
}

init();
