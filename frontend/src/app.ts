import * as state from './state';
import { initDb, q, DB_URL } from './db';
import { escHtml, fmtDuration, fmtViews, fmtDateTime } from './lib/format';
import { buildWhere, ORDER } from './lib/query';
import type { SortKey } from './lib/query';
import { serializeHash, deserializeHash } from './lib/hash';
import { t, lang, setLang, detectLang } from './lib/i18n';
import type { Lang } from './lib/i18n';
import {
  initCalendar,
  renderCalendar,
  clearCalDateFilter,
  syncDateInputs,
  rebuildMonthSelect,
} from './calendar';

// ── URL hash state ────────────────────────────────────────────────────────

function pushHash(): void {
  const s = serializeHash({
    currentView: state.currentView,
    searchQuery: state.searchQuery,
    sortBy: state.sortBy,
    gameFilter: state.gameFilter,
    currentPage: state.currentPage,
    calDateFrom: state.calDateFrom,
    calDateTo: state.calDateTo,
    calYear: state.calYear,
    calMonth: state.calMonth,
    calDay: state.calDay,
    calWeek: state.calWeek,
  });
  history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
}

function applyStateHash(hashStr: string): void {
  const partial = deserializeHash(hashStr);

  state.setSearchQuery(partial.searchQuery ?? '');
  state.setSortBy((partial.sortBy ?? 'view_count_desc') as SortKey);
  state.setGameFilter(partial.gameFilter ?? '');
  state.setCurrentPage(partial.currentPage ?? 1);
  state.setCalDateFrom(partial.calDateFrom ?? null);
  state.setCalDateTo(partial.calDateTo ?? null);

  if (partial.calYear !== undefined) state.setCalYear(partial.calYear);
  state.setCalMonth(partial.calMonth ?? null);
  state.setCalDay(partial.calDay ?? null);
  state.setCalWeek(partial.calWeek ?? null);

  // Sync DOM controls
  (document.getElementById('search') as HTMLInputElement).value      = state.searchQuery;
  (document.getElementById('sort') as HTMLSelectElement).value       = state.sortBy;
  (document.getElementById('game-filter') as HTMLSelectElement).value = state.gameFilter;
  const ySel = document.getElementById('cal-year-select') as HTMLSelectElement | null;
  if (ySel) ySel.value = String(state.calYear);
  syncDateInputs();

  const isCalendar = partial.currentView === 'calendar';
  if (isCalendar) {
    state.setCurrentView('calendar');
    document.getElementById('btn-view-cal')!.classList.add('active');
    document.getElementById('btn-view-grid')!.classList.remove('active');
    void renderCalendar();
  } else {
    state.setCurrentView('grid');
    document.getElementById('btn-view-grid')!.classList.add('active');
    document.getElementById('btn-view-cal')!.classList.remove('active');
    document.getElementById('calendar-panel')!.style.display = 'none';
  }

  void render();
}

// ── DB query helpers ──────────────────────────────────────────────────────

async function setStreamerTag(): Promise<void> {
  const rows = await q('SELECT display_name, login FROM streamers LIMIT 1');
  if (rows.length) {
    const row = rows[0]!;
    const display = row['display_name'];
    const login   = row['login'];
    document.getElementById('streamer-tag')!.textContent =
      display ? `${String(display)} (${String(login)})` : String(login);
  }
}

async function updateGameFilter(): Promise<void> {
  const params: Record<string, string> = {};
  const dateClause = state.calDateFrom !== null
    ? (params[':dateFrom'] = state.calDateFrom,
       params[':dateTo']   = state.calDateTo!,
       'WHERE c.created_at >= :dateFrom AND c.created_at < :dateTo')
    : '';

  const rows = await q(
    `SELECT g.id, g.name, COUNT(c.id) AS cnt
     FROM games g
     JOIN clips c ON c.game_id = g.id
     ${dateClause}
     GROUP BY g.id
     ORDER BY cnt DESC`,
    params,
  );

  const sel = document.getElementById('game-filter') as HTMLSelectElement;
  const validIds = new Set(rows.map(r => String(r['id'])));

  sel.innerHTML = `<option value="">${escHtml(t().allGames)}</option>`;
  for (const row of rows) {
    const opt = document.createElement('option');
    opt.value = String(row['id']);
    opt.textContent = `${String(row['name'])} (${Number(row['cnt']).toLocaleString()})`;
    sel.appendChild(opt);
  }

  if (state.gameFilter && !validIds.has(String(state.gameFilter))) {
    state.setGameFilter('');
  }
  sel.value = state.gameFilter;
}

// ── Main render ───────────────────────────────────────────────────────────

// AbortController guard: if a new render() call starts while one is in
// flight, the earlier one checks the signal and returns early.
let _renderController: AbortController | null = null;

export async function render(): Promise<void> {
  _renderController?.abort();
  const ctrl = new AbortController();
  _renderController = ctrl;

  try {
    await updateGameFilter();
    if (ctrl.signal.aborted) return;

    const { where, params } = buildWhere({
      searchQuery: state.searchQuery,
      gameFilter: state.gameFilter,
      calDateFrom: state.calDateFrom,
      calDateTo: state.calDateTo,
      useFts: state.useFts,
    });

    const countRows = await q(`SELECT COUNT(*) AS cnt FROM clips c ${where}`, params);
    if (ctrl.signal.aborted) return;
    state.setTotalClips((countRows[0]?.['cnt'] as number | undefined) ?? 0);

    const offset = (state.currentPage - 1) * state.PAGE_SIZE;
    const clips = await q(
      `SELECT c.id, c.title, c.creator_name, c.view_count,
              c.created_at, c.duration, c.thumbnail_url, c.url,
              COALESCE(g.name, '') AS game_name
       FROM clips c
       LEFT JOIN games g ON c.game_id = g.id
       ${where}
       ORDER BY ${ORDER[state.sortBy]}
       LIMIT ${state.PAGE_SIZE} OFFSET ${offset}`,
      params,
    );
    if (ctrl.signal.aborted) return;

    document.getElementById('result-count')!.textContent = t().resultCount(state.totalClips);

    const grid  = document.getElementById('clips-grid')!;
    const empty = document.getElementById('empty')!;

    if (!clips.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      grid.innerHTML = clips.map(c => `
        <div class="clip-card">
          <div class="clip-thumb">
            <a href="${escHtml(c['url'])}" target="_blank" rel="noopener noreferrer">
              <img src="${escHtml(c['thumbnail_url'])}" alt="${escHtml(c['title'])}"
                   loading="lazy" onerror="this.classList.add('broken')">
              <div class="clip-play-icon">
                <svg viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
              </div>
            </a>
            <span class="clip-duration">${fmtDuration(c['duration'] as number)}</span>
          </div>
          <div class="clip-info">
            <div class="clip-title">
              <a href="${escHtml(c['url'])}" target="_blank" rel="noopener noreferrer">
                ${escHtml(c['title'])}
              </a>
            </div>
            <div class="clip-meta">
              <span class="views">${t().views(fmtViews(c['view_count'] as number))}</span>
              ${c['game_name'] ? `<span>${escHtml(c['game_name'])}</span>` : ''}
              <span>${t().creatorLine(escHtml(c['creator_name']), fmtDateTime(c['created_at'] as string, lang))}</span>
            </div>
          </div>
        </div>
      `).join('');
    }

    renderPagination();
    pushHash();
  } catch (e) {
    if (ctrl.signal.aborted) return; // expected: a newer render() preempted us
    throw e;
  }
}

function renderPagination(): void {
  const totalPages = Math.ceil(state.totalClips / state.PAGE_SIZE);
  const pg = document.getElementById('pagination')!;
  if (totalPages <= 1) { pg.innerHTML = ''; return; }

  const show = new Set([1, totalPages]);
  for (let i = Math.max(1, state.currentPage - 2); i <= Math.min(totalPages, state.currentPage + 2); i++) {
    show.add(i);
  }
  const sorted = [...show].sort((a, b) => a - b);

  const parts: string[] = [];
  parts.push(`<button id="pg-prev" ${state.currentPage === 1 ? 'disabled' : ''}>&#8249;</button>`);

  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) parts.push(`<span class="pg-ellipsis">&hellip;</span>`);
    parts.push(`<button class="pg-btn${p === state.currentPage ? ' active' : ''}" data-page="${p}">${p}</button>`);
    prev = p;
  }
  parts.push(`<button id="pg-next" ${state.currentPage === totalPages ? 'disabled' : ''}>&#8250;</button>`);
  pg.innerHTML = parts.join('');

  pg.querySelector('#pg-prev')!.addEventListener('click', () => goPage(state.currentPage - 1));
  pg.querySelector('#pg-next')!.addEventListener('click', () => goPage(state.currentPage + 1));
  pg.querySelectorAll('.pg-btn').forEach(btn =>
    btn.addEventListener('click', () => goPage(Number((btn as HTMLButtonElement).dataset['page']))),
  );
}

function goPage(p: number): void {
  state.setCurrentPage(p);
  void render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Translation application ───────────────────────────────────────────────

function applyTranslations(): void {
  const tr = t();
  (document.getElementById('search') as HTMLInputElement).placeholder = tr.searchPlaceholder;

  const sort = document.getElementById('sort') as HTMLSelectElement;
  // Options are indexed 0–3 matching HTML order: Most Viewed, Least Viewed, Newest, Oldest
  sort.options[0]!.textContent = tr.sortMostViewed;
  sort.options[1]!.textContent = tr.sortLeastViewed;
  sort.options[2]!.textContent = tr.sortNewest;
  sort.options[3]!.textContent = tr.sortOldest;

  (document.getElementById('date-from-input') as HTMLInputElement).title = tr.dateFrom;
  (document.getElementById('date-to-input')   as HTMLInputElement).title = tr.dateTo;

  (document.getElementById('btn-view-grid') as HTMLButtonElement).textContent = tr.viewGrid;
  (document.getElementById('btn-view-cal')  as HTMLButtonElement).textContent = tr.viewCalendar;

  const loadingText = document.getElementById('loading-text');
  if (loadingText) loadingText.textContent = tr.loading;
  (document.getElementById('empty') as HTMLElement).textContent = tr.noClips;

  (document.getElementById('lang-toggle') as HTMLButtonElement).textContent = tr.langToggle;
}

// ── Event binding ─────────────────────────────────────────────────────────

let searchTimer: ReturnType<typeof setTimeout> | null = null;

function bindEvents(): void {
  const searchInput = document.getElementById('search') as HTMLInputElement;
  searchInput.addEventListener('input', e => {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.setSearchQuery((e.target as HTMLInputElement).value.trim());
      state.setCurrentPage(1);
      void render();
    }, 300);
  });

  const sortSelect = document.getElementById('sort') as HTMLSelectElement;
  sortSelect.addEventListener('change', e => {
    state.setSortBy((e.target as HTMLSelectElement).value as SortKey);
    state.setCurrentPage(1);
    void render();
  });

  const gameSelect = document.getElementById('game-filter') as HTMLSelectElement;
  gameSelect.addEventListener('change', e => {
    state.setGameFilter((e.target as HTMLSelectElement).value);
    state.setCurrentPage(1);
    void render();
  });

}

// ── Bootstrap ─────────────────────────────────────────────────────────────

export async function init(): Promise<void> {
  setLang(detectLang());
  applyTranslations();

  // Bind the lang toggle immediately so it works even if DB fails to load.
  document.getElementById('lang-toggle')!.addEventListener('click', () => {
    const newLang: Lang = lang === 'en' ? 'ja' : 'en';
    setLang(newLang);
    applyTranslations();
    rebuildMonthSelect();
    state.setCurrentPage(1);
    void render();
    if (state.currentView === 'calendar') void renderCalendar();
  });

  try {
    await initDb(DB_URL);

    // Enable FTS5 trigram search if the index was built by prepare_web_db.py.
    // This is a cheap read from sqlite_master (always in the first DB page).
    const ftsRows = await q(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='clips_fts'",
    );
    state.setUseFts(ftsRows.length > 0);

    document.getElementById('loading')!.style.display = 'none';
    document.getElementById('controls')!.style.display = 'flex';

    void setStreamerTag();
    bindEvents();
    await initCalendar(render); // must await: queries clip date range for nav bounds

    if (location.hash && location.hash.length > 1) {
      applyStateHash(location.hash);
    } else {
      void render();
    }

    window.addEventListener('hashchange', () => {
      if (location.hash && location.hash.length > 1) {
        applyStateHash(location.hash);
      } else {
        // Empty hash → reset to default state
        state.setSearchQuery('');
        state.setSortBy('view_count_desc');
        state.setGameFilter('');
        state.setCurrentPage(1);
        state.setCurrentView('grid');
        clearCalDateFilter();
        (document.getElementById('search') as HTMLInputElement).value       = '';
        (document.getElementById('sort') as HTMLSelectElement).value        = 'view_count_desc';
        (document.getElementById('game-filter') as HTMLSelectElement).value = '';
        document.getElementById('btn-view-grid')!.classList.add('active');
        document.getElementById('btn-view-cal')!.classList.remove('active');
        document.getElementById('calendar-panel')!.style.display = 'none';
        void render();
      }
    });
  } catch (err) {
    document.getElementById('loading')!.style.display = 'none';
    const el = document.getElementById('error')!;
    el.style.display = 'block';
    el.innerHTML =
      `<strong>${escHtml(t().errorTitle)}</strong><br>` +
      `${escHtml(err instanceof Error ? err.message : String(err))}<br><br>` +
      `${t().errorHint}`;
  }
}
