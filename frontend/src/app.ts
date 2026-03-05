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
import { setUseMeta } from './state';
import * as auth from './auth';
import * as twitch from './twitch';
import type { LiveClip } from './twitch';
import { filterLiveClips } from './lib/liveFilter';
import { ensureRfc3339 } from './lib/dateUtils';

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
  state.setSortBy((partial.sortBy ?? 'date_desc') as SortKey);
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

// Broadcaster ID and DB cutoff date — set once during init, never change.
let _broadcasterId: string | null = null;
let _dbCutoffDate:  string | null = null;

async function setStreamerTag(): Promise<string | null> {
  const rows = await q('SELECT id, display_name, login FROM streamers LIMIT 1');
  if (rows.length) {
    const row     = rows[0]!;
    const display = row['display_name'];
    const login   = row['login'];
    document.getElementById('streamer-tag')!.textContent =
      display ? `${String(display)} (${String(login)})` : String(login);
    return String(row['id']);
  }
  return null;
}

async function updateGameFilter(): Promise<void> {
  let rows: Awaited<ReturnType<typeof q>>;

  if (state.useMeta && state.calDateFrom === null) {
    // Fast path: precomputed table — single page read, no aggregate scan.
    rows = await q('SELECT id, name, cnt FROM game_clip_counts ORDER BY cnt DESC');
  } else {
    // Slow path: live aggregate (needed when a date filter is active, or
    // when running against the raw dev-symlink DB without clips_meta).
    const params: Record<string, string> = {};
    const dateClause = state.calDateFrom !== null
      ? (params[':dateFrom'] = state.calDateFrom,
         params[':dateTo']   = state.calDateTo!,
         'WHERE c.created_at >= :dateFrom AND c.created_at < :dateTo')
      : '';
    rows = await q(
      `SELECT g.id, g.name, COUNT(c.id) AS cnt
       FROM games g
       JOIN clips c ON c.game_id = g.id
       ${dateClause}
       GROUP BY g.id
       ORDER BY cnt DESC`,
      params,
    );
  }

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

// ── Clip card HTML helper ─────────────────────────────────────────────────

// Shared template for DB clips (render) and live clips (renderLiveSection).
// The onerror attribute is intentionally omitted — broken images are handled
// by attachImgErrorHandlers() after setting innerHTML, avoiding inline JS
// which is blocked by the Content-Security-Policy.
function clipCardHtml(clip: {
  url: string; thumbnail_url: string; title: string; duration: number;
  view_count: number; game_name: string; creator_name: string; created_at: string;
}, extraClass = ''): string {
  return `
    <div class="clip-card${extraClass}" data-clip-url="${escHtml(clip.url)}">
      <div class="clip-thumb">
        <img src="${escHtml(clip.thumbnail_url)}" alt="${escHtml(clip.title)}" loading="lazy">
        <div class="clip-play-icon">
          <svg viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
        </div>
        <span class="clip-duration">${fmtDuration(clip.duration)}</span>
      </div>
      <div class="clip-info">
        <div class="clip-title">
          <a href="${escHtml(clip.url)}" target="_blank" rel="noopener noreferrer">
            ${escHtml(clip.title)}
          </a>
        </div>
        <div class="clip-meta">
          <span class="views">${t().views(fmtViews(clip.view_count))}</span>
          ${clip.game_name ? `<span>${escHtml(clip.game_name)}</span>` : ''}
          <span>${t().creatorLine(escHtml(clip.creator_name), fmtDateTime(clip.created_at, lang))}</span>
        </div>
      </div>
    </div>`;
}

// Attach img error handlers after innerHTML is set (avoids inline onerror
// attributes which are blocked by the Content-Security-Policy).
function attachImgErrorHandlers(container: HTMLElement): void {
  container.querySelectorAll<HTMLImageElement>('.clip-thumb img').forEach(img => {
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
  });
}

// ── Clip embed ─────────────────────────────────────────────────────────────

function extractClipSlug(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    // https://www.twitch.tv/{streamer}/clip/{slug}
    const idx = parts.indexOf('clip');
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1]!;
    // https://clips.twitch.tv/{slug}
    if (u.hostname === 'clips.twitch.tv' && parts[0]) return parts[0]!;
    return null;
  } catch {
    return null;
  }
}

const _thumbCache = new WeakMap<HTMLElement, HTMLElement>();
let _expandedCard: HTMLElement | null = null;

function _onDocClickOutside(e: MouseEvent): void {
  if (_expandedCard && !_expandedCard.contains(e.target as Node)) {
    collapseCard(_expandedCard);
  }
}

function collapseCard(card: HTMLElement): void {
  const savedThumb = _thumbCache.get(card);
  const embedWrap = card.querySelector<HTMLElement>('.clip-embed-wrap');
  if (embedWrap && savedThumb) embedWrap.replaceWith(savedThumb);
  _thumbCache.delete(card);
  card.classList.remove('expanded');
  document.removeEventListener('click', _onDocClickOutside);
  _expandedCard = null;
}

function expandCard(card: HTMLElement): void {
  if (_expandedCard && _expandedCard !== card) collapseCard(_expandedCard);

  const clipUrl = card.dataset['clipUrl'] ?? '';
  const slug = extractClipSlug(clipUrl);
  if (!slug) {
    window.open(clipUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  const parent = encodeURIComponent(window.location.hostname || 'localhost');
  const src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${parent}&autoplay=false`;

  const thumb = card.querySelector<HTMLElement>('.clip-thumb');
  if (!thumb) return;

  _thumbCache.set(card, thumb);

  const embedWrap = document.createElement('div');
  embedWrap.className = 'clip-embed-wrap';
  embedWrap.innerHTML =
    `<button class="clip-close-btn" aria-label="Close embed" type="button">&#x2715;</button>` +
    `<iframe src="${escHtml(src)}" class="clip-iframe" allowfullscreen scrolling="no"></iframe>`;

  thumb.replaceWith(embedWrap);
  card.classList.add('expanded');
  _expandedCard = card;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // Add click-outside listener on the next tick so the current click
  // doesn't immediately trigger it and collapse the card.
  setTimeout(() => document.addEventListener('click', _onDocClickOutside), 0);
}

// ── Live clips ────────────────────────────────────────────────────────────

/** Fetch clips newer than the DB cutoff and store in state. */
async function fetchLiveClips(): Promise<void> {
  if (!_broadcasterId || !_dbCutoffDate) return;

  const token = await auth.getValidToken();
  if (!token) { auth.logout(); syncAuthUI(); return; }

  state.setLiveFetching(true);

  // clips_meta stores max_date as YYYY-MM-DD (date-only) for calendar use.
  // Twitch's started_at parameter requires full RFC3339; ensureRfc3339 appends
  // midnight UTC when the string has no time component.
  const sinceDate = ensureRfc3339(_dbCutoffDate);

  const clips = await twitch.fetchNewClips(_broadcasterId, sinceDate, token);

  if (clips.length > 0) {
    const gameIds   = clips.map(c => c.game_id);
    const gameNames = await twitch.fetchGameNames(gameIds, token);
    for (const c of clips) c.game_name = gameNames[c.game_id] ?? '';
  }

  state.setLiveFetching(false);
  state.setLiveClips(clips);
  void render();
}

/** Filter live clips against current filter state. */
function _filteredLiveClips(): LiveClip[] {
  return filterLiveClips({
    clips:        state.liveClips,
    dbCutoffDate: _dbCutoffDate,
    calDateTo:    state.calDateTo,
    calDateFrom:  state.calDateFrom,
    gameFilter:   state.gameFilter,
    searchQuery:  state.searchQuery,
  });
}

/** Render (or hide) the live clips section above the main grid. */
function renderLiveSection(): void {
  const section  = document.getElementById('live-section')!;
  const titleEl  = document.getElementById('live-section-title')!;
  const toggleEl = document.getElementById('btn-live-toggle')!;
  const grid     = document.getElementById('live-clips-grid')!;

  // If an expanded card was in the live section, it's about to be wiped.
  if (_expandedCard?.closest('#live-section')) {
    _expandedCard = null;
    document.removeEventListener('click', _onDocClickOutside);
  }

  if (!auth.isLoggedIn() || state.liveClips.length === 0) {
    section.style.display = 'none';
    grid.innerHTML = '';
    return;
  }

  const filtered = _filteredLiveClips();
  if (filtered.length === 0) {
    section.style.display = 'none';
    grid.innerHTML = '';
    return;
  }

  const dateLabel = _dbCutoffDate
    ? new Date(_dbCutoffDate).toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  const plural    = filtered.length === 1 ? 'clip' : 'clips';
  titleEl.textContent = `${filtered.length} new ${plural}${dateLabel ? ` since ${dateLabel}` : ''}`;

  const collapsed = localStorage.getItem('tc_live_collapsed') === '1';
  toggleEl.textContent = collapsed ? '▶' : '▼';
  toggleEl.title       = collapsed ? 'Show' : 'Collapse';
  grid.style.display   = collapsed ? 'none' : '';

  grid.innerHTML = filtered.map(c => clipCardHtml(c, ' live-clip')).join('');
  attachImgErrorHandlers(grid);

  section.style.display = 'block';
}

// ── Auth UI ───────────────────────────────────────────────────────────────

/**
 * Update the login banner and auth indicator to match current auth state.
 * Must be called after _dbCutoffDate is set.
 */
function syncAuthUI(): void {
  const banner     = document.getElementById('login-banner')!;
  const indicator  = document.getElementById('auth-indicator')!;
  const usernameEl = document.getElementById('auth-username')!;
  const bannerText = document.getElementById('banner-text')!;

  if (!auth.hasClientId) {
    // No Client ID configured at build time — hide auth UI entirely.
    banner.style.display    = 'none';
    indicator.style.display = 'none';
    return;
  }

  if (auth.isLoggedIn()) {
    banner.style.display    = 'none';
    indicator.style.display = 'flex';
    usernameEl.textContent  = state.twitchUsername ?? auth.getUsername() ?? '';
  } else {
    indicator.style.display = 'none';

    const dismissed = localStorage.getItem('tc_banner_dismissed') === '1';
    if (dismissed) {
      banner.style.display = 'none';
    } else {
      const dateLabel = _dbCutoffDate
        ? new Date(_dbCutoffDate).toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' })
        : '';
      bannerText.textContent = dateLabel
        ? `This archive has clips through ${dateLabel}. Log in with Twitch to see newer clips.`
        : 'Log in with Twitch to see clips newer than this archive.';
      banner.style.display = 'flex';
    }
  }
}

// ── AbortController guard ─────────────────────────────────────────────────

// If a new render() call starts while one is in flight, the earlier one
// checks the signal and returns early.
let _renderController: AbortController | null = null;

export async function render(): Promise<void> {
  _renderController?.abort();
  const ctrl = new AbortController();
  _renderController = ctrl;

  try {
    // Live section is pure in-memory — no async DB reads needed.
    renderLiveSection();
    if (ctrl.signal.aborted) return;

    await updateGameFilter();
    if (ctrl.signal.aborted) return;

    const { where, params } = buildWhere({
      searchQuery: state.searchQuery,
      gameFilter: state.gameFilter,
      calDateFrom: state.calDateFrom,
      calDateTo: state.calDateTo,
      useFts: state.useFts,
    });

    // Fast path: when no filters are active and clips_meta is available,
    // use the precomputed total instead of scanning all rows.
    let totalClips: number;
    if (state.useMeta && where === '') {
      const metaRows = await q('SELECT total_clips FROM clips_meta');
      totalClips = (metaRows[0]?.['total_clips'] as number | undefined) ?? 0;
    } else {
      const countRows = await q(`SELECT COUNT(*) AS cnt FROM clips c ${where}`, params);
      totalClips = (countRows[0]?.['cnt'] as number | undefined) ?? 0;
    }
    if (ctrl.signal.aborted) return;
    state.setTotalClips(totalClips);

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

    // Reset any expanded embed from the previous render — the DOM is about
    // to be replaced entirely.
    if (_expandedCard?.closest('#clips-grid')) {
      _expandedCard = null;
      document.removeEventListener('click', _onDocClickOutside);
    }

    if (!clips.length) {
      grid.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      grid.innerHTML = clips.map(c => clipCardHtml({
        url:           String(c['url']           ?? ''),
        thumbnail_url: String(c['thumbnail_url'] ?? ''),
        title:         String(c['title']         ?? ''),
        duration:      Number(c['duration']      ?? 0),
        view_count:    Number(c['view_count']    ?? 0),
        game_name:     String(c['game_name']     ?? ''),
        creator_name:  String(c['creator_name']  ?? ''),
        created_at:    String(c['created_at']    ?? ''),
      })).join('');
      attachImgErrorHandlers(grid);
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
  sort.value = state.sortBy;

  (document.getElementById('date-from-input') as HTMLInputElement).title = tr.dateFrom;
  (document.getElementById('date-from-input') as HTMLInputElement).lang  = lang;
  (document.getElementById('date-to-input')   as HTMLInputElement).title = tr.dateTo;
  (document.getElementById('date-to-input')   as HTMLInputElement).lang  = lang;

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

  // Clip embed: delegated click handler on <main> covers both #clips-grid
  // and #live-clips-grid (cards are re-created on every render so per-element
  // listeners would be lost).
  document.querySelector('main')!.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    if (target.closest('.clip-close-btn')) {
      const card = target.closest<HTMLElement>('.clip-card');
      if (card) collapseCard(card);
      return;
    }
    if (target.closest('.clip-thumb')) {
      const card = target.closest<HTMLElement>('.clip-card');
      if (card) expandCard(card);
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _expandedCard) collapseCard(_expandedCard);
  });

  // ── Auth buttons ──────────────────────────────────────────────────────────

  document.getElementById('btn-login')?.addEventListener('click', () => {
    void auth.initiateLogin();
  });

  document.getElementById('btn-logout')?.addEventListener('click', () => {
    auth.logout();
    localStorage.removeItem('tc_banner_dismissed'); // show banner again after logout
    syncAuthUI();
    void render();
  });

  document.getElementById('btn-dismiss-banner')?.addEventListener('click', () => {
    localStorage.setItem('tc_banner_dismissed', '1');
    document.getElementById('login-banner')!.style.display = 'none';
  });

  document.getElementById('btn-live-toggle')?.addEventListener('click', () => {
    const collapsed = localStorage.getItem('tc_live_collapsed') === '1';
    localStorage.setItem('tc_live_collapsed', collapsed ? '0' : '1');
    renderLiveSection();
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

  // Handle OAuth redirect before anything else. Reads the token from the URL
  // hash (implicit grant) and cleans it before applyStateHash() runs.
  await auth.handleOAuthCallback();

  // Restore username from localStorage so the auth indicator shows immediately.
  const storedUsername = auth.getUsername();
  if (storedUsername) state.setTwitchUsername(storedUsername);

  try {
    await initDb(DB_URL);

    // Enable FTS5 trigram search if the index was built by prepare_web_db.py.
    // This is a cheap read from sqlite_master (always in the first DB page).
    const ftsRows = await q(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='clips_fts'",
    );
    state.setUseFts(ftsRows.length > 0);

    // Enable precomputed-metadata fast paths if prepare_web_db.py has run.
    // clips_meta holds total_clips, min_date, max_date as a single row.
    // game_clip_counts holds per-game counts without requiring a live GROUP BY.
    const metaRows = await q(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='clips_meta'",
    );
    setUseMeta(metaRows.length > 0);

    // Get the DB cutoff date for the login banner and the live-clip fetch.
    // Always use MAX(created_at) directly — clips_meta.max_date is truncated to
    // YYYY-MM-DD for calendar use, which would cause clips already in the DB to
    // be re-fetched as "new" when passed as started_at to the Twitch API.
    // The clips_created_at index makes this a single B-tree leaf read.
    const cutoffRows = await q('SELECT MAX(created_at) AS max_date FROM clips');
    _dbCutoffDate = (cutoffRows[0]?.['max_date'] as string | undefined) ?? null;

    document.getElementById('loading')!.style.display = 'none';
    document.getElementById('controls')!.style.display = 'flex';

    _broadcasterId = await setStreamerTag();
    bindEvents();
    syncAuthUI();
    await initCalendar(render); // must await: queries clip date range for nav bounds

    // Fetch live clips in the background; render() is called again when done.
    if (auth.isLoggedIn()) void fetchLiveClips();

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
        state.setSortBy('date_desc');
        state.setGameFilter('');
        state.setCurrentPage(1);
        state.setCurrentView('grid');
        clearCalDateFilter();
        (document.getElementById('search') as HTMLInputElement).value       = '';
        (document.getElementById('sort') as HTMLSelectElement).value        = 'date_desc';
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
