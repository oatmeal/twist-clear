import * as state from './state';
import { initDb, q, DB_URL } from './db';
import { escHtml, fmtDuration, fmtViews, fmtDateTime, fmtDate } from './lib/format';
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
  onTzChange,
  updateLiveClipBounds,
} from './calendar';
import { setUseMeta } from './state';
import * as auth from './auth';
import * as twitch from './twitch';
import type { LiveClip } from './twitch';
import { filterLiveClips } from './lib/liveFilter';
import { ensureRfc3339, localDateToUtcBound } from './lib/dateUtils';
import {
  rankLiveClips, computeViewCountPage, interleavePage,
} from './lib/liveRank';
import type { ViewCountSortKey } from './lib/liveRank';

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
    tzOffset: state.tzOffset,
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

  if (partial.tzOffset !== undefined) {
    state.setTzOffset(partial.tzOffset);
    const tzSel = document.getElementById('tz-select') as HTMLSelectElement | null;
    if (tzSel) tzSel.value = String(state.tzOffset);
  }

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

// Broadcaster ID and DB metadata — set once during init, never change.
let _broadcasterId: string | null = null;
// MAX(created_at) from clips — used as started_at for the Twitch live-clip
// API call and as the deduplication boundary in filterLiveClips.
let _dbCutoffDate:  string | null = null;
// MAX(last_scraped_at) from streamers — shown in the login banner because it
// reflects when the scraper last ran (always >= _dbCutoffDate), giving a more
// accurate "archive current as of" time than the newest clip timestamp.
let _dbScrapeDate:  string | null = null;

async function setStreamerTag(): Promise<string | null> {
  const rows = await q('SELECT id, display_name, login FROM streamers');
  if (!rows.length) return null;

  const siteTitle = (import.meta.env as Record<string, string>)['VITE_SITE_TITLE']
    || 'twist-clear clip archive';

  const plainNames:  string[] = [];
  const linkedNames: string[] = [];
  for (const row of rows) {
    const login   = String(row['login']);
    const display = row['display_name'];
    const name    = display ? String(display) : login;
    plainNames.push(name);
    linkedNames.push(
      `<a href="https://www.twitch.tv/${escHtml(login)}" target="_blank" rel="noopener">`
      + `${escHtml(name)}</a>`,
    );
  }

  document.getElementById('streamer-tag')!.innerHTML = ': ' + linkedNames.join(', ');
  document.title = `${siteTitle}: ${plainNames.join(', ')}`;

  return String(rows[0]!['id']);
}

function renderFooter(): void {
  const env        = import.meta.env as Record<string, string>;
  const codeRepo   = env['VITE_CODE_REPO']    || '';
  const codeSha    = env['VITE_CODE_SHA']     || '';
  const archiveRepo = env['VITE_ARCHIVE_REPO'] || '';
  const archiveSha  = env['VITE_ARCHIVE_SHA']  || '';

  if (!codeRepo) return;

  const codeShort    = codeSha    ? codeSha.slice(0, 7)    : '';
  const archiveShort = archiveSha ? archiveSha.slice(0, 7) : '';
  const codeBase    = `https://github.com/${escHtml(codeRepo)}`;
  const archiveBase = archiveRepo ? `https://github.com/${escHtml(archiveRepo)}` : '';

  let html = `Built with <a href="${codeBase}" target="_blank" rel="noopener">twist-clear</a>`;
  if (codeShort) {
    html += ` (<a href="${codeBase}/commit/${escHtml(codeSha)}" target="_blank" rel="noopener">${escHtml(codeShort)}</a>)`;
  }
  if (archiveBase) {
    html += ` · Archive: <a href="${archiveBase}" target="_blank" rel="noopener">${escHtml(archiveRepo)}</a>`;
    if (archiveShort) {
      html += ` (<a href="${archiveBase}/commit/${escHtml(archiveSha)}" target="_blank" rel="noopener">${escHtml(archiveShort)}</a>)`;
    }
  }

  const footer = document.getElementById('site-footer');
  if (footer) footer.innerHTML = html;
}

async function updateGameFilter(): Promise<void> {
  let rows: Awaited<ReturnType<typeof q>>;

  if (state.useMeta && state.calDateFrom === null) {
    // Fast path: precomputed table — single page read, no aggregate scan.
    rows = await q('SELECT id, name, name_ja, cnt FROM game_clip_counts ORDER BY cnt DESC');
  } else {
    // Slow path: live aggregate (needed when a date filter is active, or
    // when running against the raw dev-symlink DB without clips_meta).
    const params: Record<string, string> = {};
    const dateClause = state.calDateFrom !== null
      ? (params[':dateFrom'] = localDateToUtcBound(state.calDateFrom, state.tzOffset),
         params[':dateTo']   = localDateToUtcBound(state.calDateTo!, state.tzOffset),
         'WHERE c.created_at >= :dateFrom AND c.created_at < :dateTo')
      : '';
    rows = await q(
      `SELECT g.id, g.name, g.name_ja, COUNT(c.id) AS cnt
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
    const displayName = (lang === 'ja' && row['name_ja']) ? String(row['name_ja']) : String(row['name']);
    opt.textContent = `${displayName} (${Number(row['cnt']).toLocaleString()})`;
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
  view_count: number; game_name: string; game_name_ja?: string;
  creator_name: string; created_at: string;
}, extraClass = ''): string {
  // Show the Japanese name when the UI language is Japanese and one is available;
  // otherwise fall back to the English name from the games table.
  const displayGameName = (lang === 'ja' && clip.game_name_ja) ? clip.game_name_ja : clip.game_name;
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
          <span class="views">${t().views(fmtViews(clip.view_count, lang))}</span>
          ${displayGameName ? `<span>${escHtml(displayGameName)}</span>` : ''}
          <span>${t().creatorLine(escHtml(clip.creator_name), fmtDateTime(clip.created_at, lang, state.tzOffset))}</span>
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
  // Restore clip-info from nav row if present
  const navRow = card.querySelector<HTMLElement>('.clip-nav-row');
  const info = navRow?.querySelector<HTMLElement>('.clip-info');
  if (navRow && info) navRow.replaceWith(info);
  card.classList.remove('expanded');
  document.removeEventListener('click', _onDocClickOutside);
  _expandedCard = null;
}

function expandCard(card: HTMLElement, skipScroll = false): void {
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
    `<button class="clip-close-btn" aria-label="${escHtml(t().closeEmbed)}" type="button">&#x2715;</button>` +
    `<iframe src="${escHtml(src)}" class="clip-iframe" allowfullscreen scrolling="no"></iframe>`;

  thumb.replaceWith(embedWrap);

  // Wrap clip-info with prev/next navigation buttons
  const info = card.querySelector<HTMLElement>('.clip-info');
  if (info) {
    const allCards = Array.from(card.parentElement?.querySelectorAll<HTMLElement>('.clip-card') ?? []);
    const idx = allCards.indexOf(card);
    const navRow = document.createElement('div');
    navRow.className = 'clip-nav-row';
    const prevBtn = document.createElement('button');
    prevBtn.className = 'clip-nav-btn clip-prev-btn';
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', t().prevClip);
    prevBtn.disabled = idx <= 0;
    prevBtn.innerHTML = '&#8592;';
    const nextBtn = document.createElement('button');
    nextBtn.className = 'clip-nav-btn clip-next-btn';
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', t().nextClip);
    nextBtn.disabled = idx >= allCards.length - 1;
    nextBtn.innerHTML = '&#8594;';
    info.replaceWith(navRow);
    navRow.append(prevBtn, info, nextBtn);
  }

  card.classList.add('expanded');
  _expandedCard = card;
  if (!skipScroll) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // Add click-outside listener on the next tick so the current click
  // doesn't immediately trigger it and collapse the card.
  setTimeout(() => document.addEventListener('click', _onDocClickOutside), 0);
}

function navigateClip(direction: 'prev' | 'next'): void {
  if (!_expandedCard) return;
  const allCards = Array.from(_expandedCard.parentElement?.querySelectorAll<HTMLElement>('.clip-card') ?? []);
  const idx = allCards.indexOf(_expandedCard);
  const target = allCards[direction === 'prev' ? idx - 1 : idx + 1];
  if (!target) return;
  // Capture the embed's current screen position before the DOM changes,
  // then instantly correct scroll so it stays at the same vertical position.
  const topBefore = _expandedCard.getBoundingClientRect().top;
  expandCard(target, true);
  const topAfter = target.getBoundingClientRect().top;
  window.scrollBy({ top: topAfter - topBefore, behavior: 'instant' });
}

// ── Live clips ────────────────────────────────────────────────────────────

/** Fetch clips newer than the DB cutoff and store in state. */
async function fetchLiveClips(): Promise<void> {
  if (!_broadcasterId || !_dbCutoffDate) return;

  const token = await auth.getValidToken();
  if (!token) { auth.logout(); syncAuthUI(); return; }

  const refreshBtnEl = document.getElementById('btn-refresh-live') as HTMLButtonElement | null;
  state.setLiveFetching(true);
  if (refreshBtnEl) { refreshBtnEl.disabled = true; refreshBtnEl.textContent = t().refreshingBtn; }

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
  if (refreshBtnEl) { refreshBtnEl.disabled = false; refreshBtnEl.textContent = t().refreshBtn; }
  state.setLiveClips(clips);
  updateLiveClipBounds();
  void render();
  if (state.currentView === 'calendar') void renderCalendar();
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
    tzOffset:     state.tzOffset,
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

  const dateLabel = _dbCutoffDate ? fmtDate(_dbCutoffDate, state.tzOffset, lang) : '';
  titleEl.textContent = dateLabel
    ? t().liveTitle(filtered.length, dateLabel)
    : t().liveTitleNoDate(filtered.length);

  const collapsed = localStorage.getItem('tc_live_collapsed') === '1';
  toggleEl.textContent = collapsed ? '▶' : '▼';
  toggleEl.title       = collapsed ? t().liveSectionShow : t().liveSectionCollapse;
  toggleEl.setAttribute('aria-label', collapsed ? t().liveSectionShow : t().liveSectionCollapse);
  grid.style.display   = collapsed ? 'none' : '';

  grid.innerHTML = filtered.map(c => clipCardHtml(c, ' live-clip')).join('');
  attachImgErrorHandlers(grid);

  section.style.display = 'block';
}

// ── Auth UI ───────────────────────────────────────────────────────────────

/**
 * Update the login banner and auth indicator to match current auth state.
 * Must be called after _dbCutoffDate and _dbScrapeDate are set.
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
      const displayDate = _dbScrapeDate ?? _dbCutoffDate;
      const dateLabel = displayDate ? fmtDateTime(displayDate, lang, state.tzOffset) : '';
      bannerText.textContent = dateLabel
        ? t().loginBannerWithDate(dateLabel)
        : t().loginBannerNoDate;
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
    // Decide whether to merge live clips into the main grid.
    // date_desc/date_asc: live clips are always newest, so they sit at the head
    //   or tail of the sequence — simple offset math.
    // view_count_desc/asc: per-clip COUNT queries determine each live clip's rank
    //   in the sorted DB sequence; see rankLiveClips() in lib/liveRank.ts.
    const filteredLive = _filteredLiveClips();
    const mergingDesc       = state.sortBy === 'date_desc'       && filteredLive.length > 0;
    const mergingAsc        = state.sortBy === 'date_asc'        && filteredLive.length > 0;
    const mergingViewCount  = (state.sortBy === 'view_count_desc' || state.sortBy === 'view_count_asc')
                              && filteredLive.length > 0;
    const merging = mergingDesc || mergingAsc || mergingViewCount;

    if (merging) {
      // Hide the collapsible panel — live clips appear inline in the main grid.
      const liveSection = document.getElementById('live-section')!;
      if (_expandedCard?.closest('#live-section')) {
        _expandedCard = null;
        document.removeEventListener('click', _onDocClickOutside);
      }
      liveSection.style.display = 'none';
      document.getElementById('live-clips-grid')!.innerHTML = '';
    } else {
      // Live section is pure in-memory — no async DB reads needed.
      renderLiveSection();
    }
    if (ctrl.signal.aborted) return;

    await updateGameFilter();
    if (ctrl.signal.aborted) return;

    const { where, params } = buildWhere({
      searchQuery: state.searchQuery,
      gameFilter: state.gameFilter,
      calDateFrom: state.calDateFrom,
      calDateTo: state.calDateTo,
      useFts: state.useFts,
      tzOffset: state.tzOffset,
    });

    // Fast path: avoid a full COUNT(*) scan when precomputed totals are available.
    //   - No filters: read total_clips from clips_meta (single row).
    //   - Game-only filter: read cnt from game_clip_counts (single row).
    //     COUNT(*) with only a game filter would scan the entire clips_game_created
    //     index for that game_id — potentially thousands of pages for popular games.
    //   - Any other filter combination: fall back to COUNT(*).
    let dbCount: number;
    const gameOnlyFilter = state.useMeta
      && state.gameFilter !== ''
      && !state.searchQuery
      && state.calDateFrom === null;
    if (state.useMeta && where === '') {
      const metaRows = await q('SELECT total_clips FROM clips_meta');
      dbCount = (metaRows[0]?.['total_clips'] as number | undefined) ?? 0;
    } else if (gameOnlyFilter) {
      const gcRows = await q(
        'SELECT cnt FROM game_clip_counts WHERE id = :game',
        { ':game': state.gameFilter },
      );
      dbCount = (gcRows[0]?.['cnt'] as number | undefined) ?? 0;
    } else {
      const countRows = await q(`SELECT COUNT(*) AS cnt FROM clips c ${where}`, params);
      dbCount = (countRows[0]?.['cnt'] as number | undefined) ?? 0;
    }
    if (ctrl.signal.aborted) return;

    // For view_count sorts, compute each live clip's rank in the DB sequence.
    // One COUNT(*) per unique (view_count, created_at) pair; uses the composite
    // clips_view_count index so each query is O(log N).
    const rankedLive = mergingViewCount
      ? await rankLiveClips(filteredLive, state.sortBy as ViewCountSortKey, where, params, q)
      : [];
    if (ctrl.signal.aborted) return;

    // ISO 8601 strings are lexicographically ordered so string comparison is correct.
    // date_desc: newest-first among live clips; date_asc: oldest-first.
    const sortedLive = (mergingDesc || mergingAsc)
      ? [...filteredLive].sort((a, b) => {
          const cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
          return mergingDesc ? -cmp : cmp;
        })
      : [];
    const liveCount = mergingViewCount ? rankedLive.length : sortedLive.length;

    state.setTotalClips(merging ? liveCount + dbCount : dbCount);

    // Compute how many live/DB clips fall on the current page.
    //   date_desc:       live clips occupy positions 0..(liveCount-1), DB follows.
    //   date_asc:        DB clips occupy positions 0..(dbCount-1), live follows.
    //   view_count_desc/asc: live clips are scattered; computeViewCountPage() handles it.
    const pageStart = (state.currentPage - 1) * state.PAGE_SIZE;
    let liveOnPage: number, dbOnPage: number, dbOffset: number, liveStart: number;
    let vcPage: ReturnType<typeof computeViewCountPage> | null = null;
    if (mergingDesc) {
      liveOnPage = Math.max(0, Math.min(liveCount - pageStart, state.PAGE_SIZE));
      dbOnPage   = state.PAGE_SIZE - liveOnPage;
      dbOffset   = Math.max(0, pageStart - liveCount);
      liveStart  = pageStart;
    } else if (mergingAsc) {
      dbOnPage   = Math.max(0, Math.min(dbCount - pageStart, state.PAGE_SIZE));
      liveOnPage = state.PAGE_SIZE - dbOnPage;
      dbOffset   = pageStart;
      liveStart  = Math.max(0, pageStart - dbCount);
    } else if (mergingViewCount) {
      vcPage     = computeViewCountPage(rankedLive, pageStart, state.PAGE_SIZE);
      liveOnPage = vcPage.liveOnPage.length;
      dbOnPage   = vcPage.dbOnPage;
      dbOffset   = vcPage.dbOffset;
      liveStart  = 0; // unused for view_count
    } else {
      liveOnPage = 0;
      dbOnPage   = state.PAGE_SIZE;
      dbOffset   = pageStart;
      liveStart  = 0;
    }

    const dbClips = dbOnPage > 0
      ? await q(
          `SELECT c.id, c.title, c.creator_name, c.view_count,
                  c.created_at, c.duration, c.thumbnail_url, c.url,
                  COALESCE(g.name, '') AS game_name,
                  COALESCE(g.name_ja, '') AS game_name_ja
           FROM clips c
           LEFT JOIN games g ON c.game_id = g.id
           ${where}
           ORDER BY ${ORDER[state.sortBy]}
           LIMIT ${dbOnPage} OFFSET ${dbOffset}`,
          params,
        )
      : [];
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

    const liveSlice = sortedLive.slice(liveStart, liveStart + liveOnPage);
    const hasClips  = liveSlice.length > 0 || dbClips.length > 0 ||
                      (vcPage !== null && vcPage.liveOnPage.length > 0);

    if (!hasClips) {
      grid.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';

      if (mergingViewCount && vcPage !== null) {
        // Interleave live clips at their exact ranked positions within the page.
        const items = interleavePage(dbClips, vcPage.liveOnPage, pageStart, state.PAGE_SIZE);
        grid.innerHTML = items.map(item =>
          item.kind === 'live'
            ? clipCardHtml(item.clip, ' live-clip')
            : clipCardHtml({
                url:           String(item.row['url']           ?? ''),
                thumbnail_url: String(item.row['thumbnail_url'] ?? ''),
                title:         String(item.row['title']         ?? ''),
                duration:      Number(item.row['duration']      ?? 0),
                view_count:    Number(item.row['view_count']    ?? 0),
                game_name:     String(item.row['game_name']     ?? ''),
                game_name_ja:  String(item.row['game_name_ja']  ?? ''),
                creator_name:  String(item.row['creator_name']  ?? ''),
                created_at:    String(item.row['created_at']    ?? ''),
              }),
        ).join('');
      } else {
        const liveCards = liveSlice.map(c => clipCardHtml(c, ' live-clip'));
        const dbCards   = dbClips.map(c => clipCardHtml({
          url:           String(c['url']           ?? ''),
          thumbnail_url: String(c['thumbnail_url'] ?? ''),
          title:         String(c['title']         ?? ''),
          duration:      Number(c['duration']      ?? 0),
          view_count:    Number(c['view_count']    ?? 0),
          game_name:     String(c['game_name']     ?? ''),
          game_name_ja:  String(c['game_name_ja']  ?? ''),
          creator_name:  String(c['creator_name']  ?? ''),
          created_at:    String(c['created_at']    ?? ''),
        }));
        // date_desc: live (newest) first; date_asc: DB (oldest) first, live appended.
        grid.innerHTML = mergingAsc
          ? [...dbCards, ...liveCards].join('')
          : [...liveCards, ...dbCards].join('');
      }
      attachImgErrorHandlers(grid);
    }

    renderPagination();
    pushHash();
  } catch (e) {
    if (ctrl.signal.aborted) return; // expected: a newer render() preempted us
    console.error('render() failed:', e);
    document.getElementById('clips-grid')!.innerHTML =
      `<p class="error-msg">${escHtml(t().renderError)}</p>`;
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

  // Auth / login
  const loginBtn = document.getElementById('btn-login');
  if (loginBtn) loginBtn.textContent = tr.loginBtn;
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.textContent = tr.logoutBtn;
  const refreshBtnEl = document.getElementById('btn-refresh-live') as HTMLButtonElement | null;
  if (refreshBtnEl) refreshBtnEl.textContent = state.liveFetching ? tr.refreshingBtn : tr.refreshBtn;
  const dismissBtn = document.getElementById('btn-dismiss-banner');
  if (dismissBtn) dismissBtn.setAttribute('aria-label', tr.dismissBanner);

  // Settings panel — timezone label
  const tzLabelEl = document.getElementById('tz-label-text');
  if (tzLabelEl) tzLabelEl.textContent = tr.tzLabel;
  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn) {
    settingsBtn.title = tr.tzLabel;
    settingsBtn.setAttribute('aria-label', tr.tzLabel);
  }

  // Language toggle: highlight the active language in the EN/JA segmented pill.
  const optEn = document.getElementById('lang-opt-en');
  const optJa = document.getElementById('lang-opt-ja');
  if (optEn) optEn.className = lang === 'en' ? 'lang-opt active' : 'lang-opt';
  if (optJa) optJa.className = lang === 'ja' ? 'lang-opt active' : 'lang-opt';

  // Search help modal
  const helpBtn = document.getElementById('btn-search-help');
  if (helpBtn) { helpBtn.setAttribute('aria-label', tr.searchHelpBtn); helpBtn.title = tr.searchHelpBtn; }
  const helpTitle = document.getElementById('search-help-modal-title');
  if (helpTitle) helpTitle.textContent = tr.searchHelpTitle;
  const helpAnd = document.getElementById('search-help-and');
  if (helpAnd) helpAnd.textContent = tr.searchHelpAnd;
  const helpOr = document.getElementById('search-help-or');
  if (helpOr) helpOr.textContent = tr.searchHelpOr;
  const helpNot = document.getElementById('search-help-not');
  if (helpNot) helpNot.textContent = tr.searchHelpNot;
  const helpPhrase = document.getElementById('search-help-phrase');
  if (helpPhrase) helpPhrase.textContent = tr.searchHelpPhrase;
  const helpNote = document.getElementById('search-help-note');
  if (helpNote) helpNote.textContent = tr.searchHelpNote;
}

// ── Timezone label ────────────────────────────────────────────────────────

function fmtTzOffset(off: number): string {
  if (off === 0) return 'UTC';
  const absH = Math.floor(Math.abs(off) / 60);
  const absM = Math.abs(off) % 60;
  const sign = off > 0 ? '+' : '−';
  return absM === 0
    ? `UTC${sign}${absH}`
    : `UTC${sign}${absH}:${String(absM).padStart(2, '0')}`;
}

function updateTzLabel(): void {
  const el = document.getElementById('tz-label');
  if (el) el.textContent = fmtTzOffset(state.tzOffset);
}

// ── Accent colour override ─────────────────────────────────────────────────

/** Apply any VITE_COLOR_* build-time overrides to the document root.
 *  Inline styles on <html> take precedence over :root stylesheet values, so
 *  each non-empty var wins over the CSS default.  Derived variables
 *  (--accent-h, --cal-0..4, --cal-text*) are color-mix() expressions
 *  referencing --accent and cascade automatically — no extra work needed. */
function applyColorOverrides(): void {
  const env = import.meta.env as Record<string, string>;
  const overrides: Array<[string, string]> = [
    ['--accent',     env['VITE_COLOR_ACCENT']     ?? ''],
    ['--bg',         env['VITE_COLOR_BG']         ?? ''],
    ['--surface',    env['VITE_COLOR_SURFACE']    ?? ''],
    ['--surface2',   env['VITE_COLOR_SURFACE2']   ?? ''],
    ['--border',     env['VITE_COLOR_BORDER']     ?? ''],
    ['--text',       env['VITE_COLOR_TEXT']       ?? ''],
    ['--muted',      env['VITE_COLOR_MUTED']      ?? ''],
    // Calendar heat-map colour — separate from --accent so the density ramp
    // is visually distinct from interactive UI elements. Defaults to #22a84a
    // (mid-green) in calendar.css; override to match --accent if you want them
    // to track together, or to any other colour.
    ['--cal-accent', env['VITE_COLOR_CAL_ACCENT'] ?? ''],
  ];
  const root = document.documentElement;
  for (const [prop, val] of overrides) {
    if (val) root.style.setProperty(prop, val);
  }
}

// ── Settings panel ───────────────────────────────────────────────────────

/** Populate #tz-select with one option per 30-minute UTC offset, showing the
 *  current time in each zone so the user can identify the right one. */
function populateTzSelect(): void {
  const sel = document.getElementById('tz-select') as HTMLSelectElement | null;
  if (!sel) return;
  const now = Date.now();
  sel.innerHTML = '';
  for (let off = -720; off <= 840; off += 30) {
    const absH  = Math.floor(Math.abs(off) / 60);
    const absM  = Math.abs(off) % 60;
    const sign  = off >= 0 ? '+' : '-';
    const label = `UTC${sign}${String(absH).padStart(2, '0')}:${String(absM).padStart(2, '0')}`;
    const shifted = new Date(now + off * 60000);
    const timeLabel = shifted.toLocaleString(undefined, {
      timeZone: 'UTC',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const opt = document.createElement('option');
    opt.value = String(off);
    opt.textContent = `${label} — ${timeLabel}`;
    if (off === state.tzOffset) opt.selected = true;
    sel.appendChild(opt);
  }
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
    if (target.closest('.clip-prev-btn')) {
      navigateClip('prev');
      return;
    }
    if (target.closest('.clip-next-btn')) {
      navigateClip('next');
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

  document.getElementById('btn-refresh-live')?.addEventListener('click', () => {
    void fetchLiveClips();
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

  // ── Settings panel ─────────────────────────────────────────────────────────

  const settingsBtn   = document.getElementById('btn-settings');
  const settingsPanel = document.getElementById('settings-panel');

  function openSettings(): void {
    if (!settingsPanel) return;
    populateTzSelect(); // refresh "now" labels on each open
    settingsPanel.removeAttribute('hidden');
  }
  function closeSettings(): void {
    settingsPanel?.setAttribute('hidden', '');
  }

  settingsBtn?.addEventListener('click', e => {
    e.stopPropagation();
    settingsPanel?.hasAttribute('hidden') ? openSettings() : closeSettings();
  });

  document.addEventListener('click', e => {
    if (settingsPanel && !settingsPanel.hasAttribute('hidden') &&
        !settingsPanel.contains(e.target as Node) &&
        e.target !== settingsBtn) {
      closeSettings();
    }
  });

  document.getElementById('tz-select')?.addEventListener('change', e => {
    const v = parseInt((e.target as HTMLSelectElement).value, 10);
    state.setTzOffset(v);
    localStorage.setItem('tc_tz_offset', String(v));
    updateTzLabel();
    onTzChange();
    pushHash();
  });

  // ── Search help modal ────────────────────────────────────────────────────

  const searchHelpModal = document.getElementById('search-help-modal') as HTMLDialogElement | null;
  document.getElementById('btn-search-help')?.addEventListener('click', () => {
    searchHelpModal?.showModal();
  });
  document.getElementById('btn-close-search-help')?.addEventListener('click', () => {
    searchHelpModal?.close();
  });
  searchHelpModal?.addEventListener('click', e => {
    if (e.target === searchHelpModal) searchHelpModal.close();
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

export async function init(): Promise<void> {
  applyColorOverrides();
  // Language init: localStorage > browser locale detection.
  const storedLang = localStorage.getItem('tc_lang') as Lang | null;
  setLang(storedLang ?? detectLang());
  applyTranslations();

  // Bind the lang toggle immediately so it works even if DB fails to load.
  document.getElementById('lang-toggle')!.addEventListener('click', () => {
    const newLang: Lang = lang === 'en' ? 'ja' : 'en';
    localStorage.setItem('tc_lang', newLang);
    setLang(newLang);
    applyTranslations();
    syncAuthUI();
    rebuildMonthSelect();
    state.setCurrentPage(1);
    void render();
    if (state.currentView === 'calendar') void renderCalendar();
  });

  // Handle OAuth redirect before anything else. Reads the token from the URL
  // hash (implicit grant) and cleans it before applyStateHash() runs.
  await auth.handleOAuthCallback();

  // Initialise tzOffset: URL hash > localStorage > browser default (from state.ts).
  // Must run after handleOAuthCallback() so the hash is clean.
  {
    const hashPartial = (location.hash && location.hash.length > 1)
      ? deserializeHash(location.hash) : {};
    if (hashPartial.tzOffset !== undefined) {
      state.setTzOffset(hashPartial.tzOffset);
    } else {
      const stored = localStorage.getItem('tc_tz_offset');
      if (stored !== null) state.setTzOffset(parseInt(stored, 10));
      // else keep the browserTzOffset() default set in state.ts
    }
  }

  // Reflect the resolved tzOffset in the header button immediately.
  updateTzLabel();

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

    // Get the DB cutoff date for the live-clip fetch and deduplication.
    // Always use MAX(created_at) directly — clips_meta.max_date is truncated to
    // YYYY-MM-DD for calendar use, which would cause clips already in the DB to
    // be re-fetched as "new" when passed as started_at to the Twitch API.
    // The clips_created_at index makes this a single B-tree leaf read.
    const cutoffRows = await q('SELECT MAX(created_at) AS max_date FROM clips');
    _dbCutoffDate = (cutoffRows[0]?.['max_date'] as string | undefined) ?? null;

    // Get the scrape timestamp for the login banner. last_scraped_at is when
    // the scraper last ran, which is always >= MAX(created_at) and more
    // accurately reflects "archive current as of this moment".
    const scrapeRows = await q('SELECT MAX(last_scraped_at) AS scraped FROM streamers');
    _dbScrapeDate = (scrapeRows[0]?.['scraped'] as string | undefined) ?? null;

    document.getElementById('loading')!.style.display = 'none';
    document.getElementById('controls')!.style.display = 'flex';

    _broadcasterId = await setStreamerTag();
    renderFooter();
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
