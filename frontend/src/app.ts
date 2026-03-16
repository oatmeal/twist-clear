import * as state from './state';
import { initDb, q, DB_URL } from './db';
import { escHtml, fmtDuration, fmtViews, fmtDateTime, fmtDate, fmtTime } from './lib/format';
import { buildWhere, ORDER } from './lib/query';
import type { SortKey } from './lib/query';
import { serializeHash, serializeHashExecptSearchQuery, deserializeHash, HashState } from './lib/hash';
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
import {
  initEmbed,
  setPageBoundaryTitles,
  resetIfInGrid,
  expandCard, collapseCard,
  expandRow, collapseRow,
  navigateClip, navigateRow,
  getExpandedCard, getExpandedRow,
} from './embed';
import { setUseMeta, setClipLayout } from './state';
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

function getStateForHash(): HashState {
  return {
    currentView: state.currentView,
    clipLayout: state.clipLayout,
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
  };
}

function pushHash(): void {
  const newState = getStateForHash();
  const newHash = serializeHash(newState);

  // return if URL is already what we want
  if (location.hash === '#' + newHash) return;

  // cancel any pending search updates
  clearTimeout(state.debounceTimer);

  const structuralHash = serializeHashExecptSearchQuery(newState);

  if (structuralHash === state.lastStructuralHash) {
    history.replaceState(null, '', newHash ? '#' + newHash : location.pathname + location.search);
    state.setDebounceTimer(setTimeout(() => {
      if (location.hash !== '#' + newHash)
        history.pushState(null, '', newHash ? '#' + newHash : location.pathname + location.search);
    }, 1000));
  } else {
    history.pushState(null, '', newHash ? '#' + newHash : location.pathname + location.search);
    state.setLastStructuralHash(structuralHash);
  }
}

function applyStateHash(hashStr: string): void {
  const partial = deserializeHash(hashStr);

  state.setClipLayout(partial.clipLayout ?? 'grid');
  updateLayoutButtons();

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
    void renderCalendar();
  } else {
    state.setCurrentView('grid');
    document.getElementById('btn-view-cal')!.classList.remove('active');
    document.getElementById('calendar-panel')!.style.display = 'none';
  }

  void render();
}

// ── Layout toggle helpers ──────────────────────────────────────────────────

function updateLayoutButtons(): void {
  document.getElementById('btn-view-grid')?.classList.toggle('active', state.clipLayout === 'grid');
  document.getElementById('btn-view-list')?.classList.toggle('active', state.clipLayout === 'list');
}

// ── DB query helpers ──────────────────────────────────────────────────────

// Broadcaster ID and DB metadata — set once during init, never change.
let _broadcasterId: string | null = null;
// game_id → name_ja lookup populated by updateGameFilter(); used to supply
// Japanese game names to live clips, which only carry the English name from
// the Twitch API.
const _gameNameJa = new Map<string, string>();
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
    || 'twist-clear clip viewer';

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
  const viewerRepo = env['VITE_VIEWER_REPO'] || '';
  const viewerSha  = env['VITE_VIEWER_SHA']  || '';

  if (!codeRepo) return;

  const codeShort    = codeSha    ? codeSha.slice(0, 7)    : '';
  const viewerShort = viewerSha ? viewerSha.slice(0, 7) : '';
  const codeBase    = `https://github.com/${escHtml(codeRepo)}`;
  const viewerBase = viewerRepo ? `https://github.com/${escHtml(viewerRepo)}` : '';

  let html = `Built with <a href="${codeBase}" target="_blank" rel="noopener">twist-clear</a>`;
  if (codeShort) {
    html += ` (<a href="${codeBase}/commit/${escHtml(codeSha)}" target="_blank" rel="noopener">${escHtml(codeShort)}</a>)`;
  }
  if (viewerBase) {
    html += ` · Viewer: <a href="${viewerBase}" target="_blank" rel="noopener">${escHtml(viewerRepo)}</a>`;
    if (viewerShort) {
      html += ` (<a href="${viewerBase}/commit/${escHtml(viewerSha)}" target="_blank" rel="noopener">${escHtml(viewerShort)}</a>)`;
    }
  }

  const footer = document.getElementById('site-footer');
  if (footer) footer.innerHTML = html;
}

type LiveGameEntry = { count: number; name: string };

async function updateGameFilter(liveGameCounts: Map<string, LiveGameEntry>): Promise<void> {
  let rows: Awaited<ReturnType<typeof q>>;

  if (state.useMeta && state.calDateFrom === null && state.calDateTo === null) {
    // Fast path: precomputed table — single page read, no aggregate scan.
    rows = await q('SELECT id, name, name_ja, cnt FROM game_clip_counts ORDER BY cnt DESC');
  } else {
    // Slow path: live aggregate (needed when a date filter is active, or
    // when running against the raw dev-symlink DB without clips_meta).
    const params: Record<string, string> = {};
    const dateParts: string[] = [];
    if (state.calDateFrom !== null) {
      dateParts.push('c.created_at >= :dateFrom');
      params[':dateFrom'] = localDateToUtcBound(state.calDateFrom, state.tzOffset);
    }
    if (state.calDateTo !== null) {
      dateParts.push('c.created_at < :dateTo');
      params[':dateTo'] = localDateToUtcBound(state.calDateTo, state.tzOffset);
    }
    const dateClause = dateParts.length ? `WHERE ${dateParts.join(' AND ')}` : '';
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

  // Refresh the game_id → name_ja lookup used by live clip rendering.
  for (const row of rows) {
    const nameJa = row['name_ja'];
    if (nameJa) _gameNameJa.set(String(row['id']), String(nameJa));
  }

  const sel = document.getElementById('game-filter') as HTMLSelectElement;
  const validIds = new Set(rows.map(r => String(r['id'])));

  sel.innerHTML = `<option value="">${escHtml(t().allGames)}</option>`;
  // Hide counts when a search is active — they reflect total clips, not the
  // search-filtered subset, so displaying them would be misleading.
  const showCounts = !state.searchQuery;
  for (const row of rows) {
    const opt = document.createElement('option');
    const id = String(row['id']);
    opt.value = id;
    const displayName = (lang === 'ja' && row['name_ja']) ? String(row['name_ja']) : String(row['name']);
    const totalCnt = Number(row['cnt']) + (liveGameCounts.get(id)?.count ?? 0);
    opt.textContent = showCounts ? `${displayName} (${totalCnt.toLocaleString()})` : displayName;
    sel.appendChild(opt);
  }

  // Append options for live-only games (not yet present in the DB games table).
  const liveOnlyEntries = [...liveGameCounts.entries()]
    .filter(([id]) => !validIds.has(id))
    .sort((a, b) => b[1].count - a[1].count);
  for (const [id, entry] of liveOnlyEntries) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = showCounts ? `${entry.name} (${entry.count.toLocaleString()})` : entry.name;
    sel.appendChild(opt);
    validIds.add(id);
  }

  if (state.gameFilter && !validIds.has(String(state.gameFilter))) {
    state.setGameFilter('');
  }
  sel.value = state.gameFilter;
}

// ── Clip card HTML helper ─────────────────────────────────────────────────

// Shared template for DB clips (render) and live clips (renderLiveSection).
// Shared clip data shape used by both grid cards and list rows.
type ClipItem = {
  url: string; thumbnail_url: string; title: string; duration: number;
  view_count: number; game_name: string; game_name_ja: string;
  game_id: string; creator_name: string; created_at: string;
  isLive: boolean;
};

// The onerror attribute is intentionally omitted — broken images are handled
// by attachImgErrorHandlers() after setting innerHTML, avoiding inline JS
// which is blocked by the Content-Security-Policy.
function clipCardHtml(clip: {
  url: string; thumbnail_url: string; title: string; duration: number;
  view_count: number; game_name: string; game_name_ja?: string;
  game_id?: string; creator_name: string; created_at: string;
}, extraClass = ''): string {
  // Show the Japanese name when the UI language is Japanese and one is available;
  // otherwise fall back to the English name from the games table.
  const displayGameName = (lang === 'ja' && clip.game_name_ja) ? clip.game_name_ja : clip.game_name;
  const gameEl = displayGameName
    ? `<button class="clip-game-link" type="button" data-game-id="${escHtml(clip.game_id ?? '')}">${escHtml(displayGameName)}</button>`
    : '';
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
            <svg class="clip-ext-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 1H1v10h10V8.5M7 1h4m0 0v4m0-4L5 7"/></svg>
          </a>
          <span class="clip-title-text">${escHtml(clip.title)}</span>
        </div>
        <div class="clip-meta">
          <span class="views">${t().views(fmtViews(clip.view_count, lang))}</span>
          ${gameEl}
          <span>${t().creatorLine(escHtml(clip.creator_name), fmtDateTime(clip.created_at, lang, state.tzOffset))}</span>
        </div>
      </div>
    </div>`;
}

function clipListRowHtml(clip: ClipItem): string {
  const displayGameName = (lang === 'ja' && clip.game_name_ja) ? clip.game_name_ja : clip.game_name;
  const gameEl = displayGameName
    ? `<button class="clip-game-link" type="button" data-game-id="${escHtml(clip.game_id)}">${escHtml(displayGameName)}</button>`
    : '';
  const dateStr = fmtDateTime(clip.created_at, lang, state.tzOffset);
  // Split into date-only and time-only so the meta cell can wrap between them
  // (never mid-date or mid-time) via white-space: nowrap on each span.
  const datePart = fmtDate(clip.created_at, state.tzOffset, lang);
  const timePart = fmtTime(clip.created_at, lang, state.tzOffset);
  const liveClass = clip.isLive ? ' live-clip' : '';
  return `
    <tr class="clip-row${liveClass}" data-clip-url="${escHtml(clip.url)}">
      <td class="clip-col-title">
        <div class="clip-list-title-cell">
          <div class="clip-thumb clip-list-thumb">
            <img src="${escHtml(clip.thumbnail_url)}" alt="${escHtml(clip.title)}" loading="lazy">
            <span class="clip-duration">${fmtDuration(clip.duration)}</span>
          </div>
          <a href="${escHtml(clip.url)}" target="_blank" rel="noopener noreferrer"><svg class="clip-ext-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 1H1v10h10V8.5M7 1h4m0 0v4m0-4L5 7"/></svg></a>
          <span class="clip-title-text">${escHtml(clip.title)}</span>
        </div>
      </td>
      <td class="clip-col-game">${gameEl}</td>
      <td class="clip-col-creator">${escHtml(clip.creator_name)}</td>
      <td class="clip-col-date">${dateStr}</td>
      <td class="clip-col-meta">
        <div class="clip-meta-game">${gameEl}</div>
        <div class="clip-meta-creator">${escHtml(clip.creator_name)}</div>
        <div class="clip-meta-date">
          <span class="clip-meta-date-part">${escHtml(datePart)}</span>
          <span class="clip-meta-date-part">${escHtml(timePart)}</span>
        </div>
      </td>
      <td class="clip-col-views">${fmtViews(clip.view_count, lang)}</td>
    </tr>`;
}

// Attach img error handlers after innerHTML is set (avoids inline onerror
// attributes which are blocked by the Content-Security-Policy).
function attachImgErrorHandlers(container: HTMLElement): void {
  container.querySelectorAll<HTMLImageElement>('.clip-thumb img').forEach(img => {
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
  });
}

// ── Live clips ────────────────────────────────────────────────────────────

/** Fetch clips newer than the DB cutoff and store in state. */
async function fetchLiveClips(): Promise<void> {
  if (!_broadcasterId || !_dbCutoffDate) return;

  const token = await auth.getValidToken();
  if (!token) { auth.logout(); syncAuthUI(); return; }

  const refreshBtnEl = document.getElementById('btn-refresh-live') as HTMLButtonElement | null;
  state.setLiveFetching(true);
  if (refreshBtnEl) {
    refreshBtnEl.disabled = true;
    refreshBtnEl.classList.add('refreshing');
    refreshBtnEl.title = t().refreshingBtn;
    refreshBtnEl.setAttribute('aria-label', t().refreshingBtn);
  }

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
  if (refreshBtnEl) {
    refreshBtnEl.disabled = false;
    refreshBtnEl.classList.remove('refreshing');
    refreshBtnEl.title = t().refreshBtn;
    refreshBtnEl.setAttribute('aria-label', t().refreshBtn);
  }
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

// ── Auth UI ───────────────────────────────────────────────────────────────

/**
 * Update the login banner and auth indicator to match current auth state.
 * Must be called after _dbCutoffDate and _dbScrapeDate are set.
 */
function syncAuthUI(): void {
  const banner      = document.getElementById('login-banner')!;
  const indicator   = document.getElementById('auth-indicator')!;
  const headerLogin = document.getElementById('header-login')!;
  const usernameEl  = document.getElementById('auth-username')!;
  const bannerText  = document.getElementById('banner-text')!;

  if (!auth.hasClientId) {
    // No Client ID configured at build time — hide auth UI entirely.
    banner.style.display      = 'none';
    indicator.style.display   = 'none';
    headerLogin.style.display = 'none';
    return;
  }

  if (auth.isLoggedIn()) {
    banner.style.display      = 'none';
    indicator.style.display   = 'flex';
    usernameEl.textContent    = state.twitchUsername ?? auth.getUsername() ?? '';
    headerLogin.style.display = 'none';
  } else {
    indicator.style.display = 'none';

    const dismissed = localStorage.getItem('tc_banner_dismissed') === '1';
    if (dismissed) {
      banner.style.display      = 'none';
      headerLogin.style.display = 'flex';
    } else {
      const displayDate = _dbScrapeDate ?? _dbCutoffDate;
      const dateLabel = displayDate ? fmtDateTime(displayDate, lang, state.tzOffset) : '';
      bannerText.textContent = dateLabel
        ? t().loginBannerWithDate(dateLabel)
        : t().loginBannerNoDate;
      banner.style.display = 'flex';
      headerLogin.style.display = 'none';
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
  // Adjacent-page boundary titles — computed below during the prefetch phase
  // and passed to embed.ts so nav buttons can show a title hint.
  let prevPageLastTitle: string | null = null;
  let nextPageLastTitle: string | null = null;

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

    if (ctrl.signal.aborted) return;

    // Compute per-game live clip counts (date-filtered, no game/search filter)
    // to add to the game dropdown counts alongside the DB totals. Built even
    // when a search is active so live-only game options remain visible.
    const liveGameCounts = new Map<string, LiveGameEntry>();
    if (state.liveClips.length > 0) {
      const dateLive = filterLiveClips({
        clips:        state.liveClips,
        dbCutoffDate: _dbCutoffDate,
        calDateFrom:  state.calDateFrom,
        calDateTo:    state.calDateTo,
        gameFilter:   '',
        searchQuery:  '',
        tzOffset:     state.tzOffset,
      });
      for (const c of dateLive) {
        const id = c.game_id ?? '';
        if (!id) continue;
        const entry = liveGameCounts.get(id);
        if (entry) {
          entry.count++;
        } else {
          liveGameCounts.set(id, { count: 1, name: c.game_name });
        }
      }
    }

    await updateGameFilter(liveGameCounts);
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
      && state.calDateFrom === null
      && state.calDateTo === null;
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
                  c.game_id,
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

    // ── Adjacent-page boundary title prefetch ───────────────────────────────
    // Fetch the title of the one clip just before / after the current page so
    // page-boundary nav buttons can show a title hint.  We already know enough
    // from the pagination math to avoid touching extra DB rows in most cases:
    // for date sorts, live clips in sortedLive may cover the boundary; for
    // view_count sorts, check rankedLive.  When it really is a DB row we need,
    // a LIMIT 1 OFFSET n query fetches exactly one row.
    const totalPages = Math.ceil(state.totalClips / state.PAGE_SIZE);
    if (state.currentPage > 1) {
      const prevPos = pageStart - 1;
      if (mergingDesc && prevPos < liveCount) {
        prevPageLastTitle =sortedLive[prevPos]?.title ?? null;
      } else if (mergingAsc && prevPos >= dbCount) {
        prevPageLastTitle =sortedLive[prevPos - dbCount]?.title ?? null;
      } else if (mergingViewCount) {
        const live = rankedLive.find(r => r.mergedPos === prevPos);
        if (live) {
          prevPageLastTitle =live.clip.title;
        } else if (vcPage!.dbOffset > 0) {
          const rows = await q(
            `SELECT c.title FROM clips c ${where} ORDER BY ${ORDER[state.sortBy]} LIMIT 1 OFFSET ${vcPage!.dbOffset - 1}`,
            params,
          );
          if (ctrl.signal.aborted) return;
          prevPageLastTitle =(rows[0]?.['title'] as string | undefined) ?? null;
        }
      } else {
        // Non-merging or date sorts where the prev boundary is a DB clip.
        // For mergingDesc (prevPos >= liveCount): DB offset = prevPos - liveCount = dbOffset - 1.
        // For mergingAsc (prevPos < dbCount):    DB offset = prevPos = dbOffset - 1.
        // For non-merging:                       DB offset = prevPos = dbOffset - 1.
        if (dbOffset > 0) {
          const rows = await q(
            `SELECT c.title FROM clips c ${where} ORDER BY ${ORDER[state.sortBy]} LIMIT 1 OFFSET ${dbOffset - 1}`,
            params,
          );
          if (ctrl.signal.aborted) return;
          prevPageLastTitle =(rows[0]?.['title'] as string | undefined) ?? null;
        }
      }
    }
    if (state.currentPage < totalPages) {
      const nextPos = pageStart + state.PAGE_SIZE;
      if (mergingDesc && nextPos < liveCount) {
        nextPageLastTitle =sortedLive[nextPos]?.title ?? null;
      } else if (mergingAsc && nextPos >= dbCount) {
        nextPageLastTitle =sortedLive[nextPos - dbCount]?.title ?? null;
      } else if (mergingViewCount) {
        const live = rankedLive.find(r => r.mergedPos === nextPos);
        if (live) {
          nextPageLastTitle =live.clip.title;
        } else {
          const nextDbOffset = vcPage!.dbOffset + vcPage!.dbOnPage;
          const rows = await q(
            `SELECT c.title FROM clips c ${where} ORDER BY ${ORDER[state.sortBy]} LIMIT 1 OFFSET ${nextDbOffset}`,
            params,
          );
          if (ctrl.signal.aborted) return;
          nextPageLastTitle =(rows[0]?.['title'] as string | undefined) ?? null;
        }
      } else {
        // Non-merging or date sorts where the next boundary is a DB clip.
        // For mergingDesc (nextPos >= liveCount): DB offset = nextPos - liveCount = dbOffset + dbOnPage.
        // For mergingAsc (nextPos < dbCount):    DB offset = nextPos = dbOffset + dbOnPage.
        // For non-merging:                       DB offset = nextPos = dbOffset + dbOnPage.
        const nextDbOffset = dbOffset + dbOnPage;
        const rows = await q(
          `SELECT c.title FROM clips c ${where} ORDER BY ${ORDER[state.sortBy]} LIMIT 1 OFFSET ${nextDbOffset}`,
          params,
        );
        if (ctrl.signal.aborted) return;
        nextPageLastTitle =(rows[0]?.['title'] as string | undefined) ?? null;
      }
    }
    // ────────────────────────────────────────────────────────────────────────
    setPageBoundaryTitles(prevPageLastTitle, nextPageLastTitle);

    document.getElementById('result-count')!.textContent = t().resultCount(state.totalClips);

    const grid  = document.getElementById('clips-grid')!;
    const empty = document.getElementById('empty')!;

    // Reset any expanded embed from the previous render — the DOM is about
    // to be replaced entirely.
    resetIfInGrid();

    const liveSlice = sortedLive.slice(liveStart, liveStart + liveOnPage);
    const hasClips  = liveSlice.length > 0 || dbClips.length > 0 ||
                      (vcPage !== null && vcPage.liveOnPage.length > 0);

    if (!hasClips) {
      grid.innerHTML = '';
      grid.classList.remove('is-list');
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';

      // Build a flat ClipItem array regardless of layout, then render as grid
      // cards or a list table.
      const clipItems: ClipItem[] = [];

      const toItem = (c: Record<string, unknown>, isLive: boolean): ClipItem => ({
        url:           String(c['url']           ?? ''),
        thumbnail_url: String(c['thumbnail_url'] ?? ''),
        title:         String(c['title']         ?? ''),
        duration:      Number(c['duration']      ?? 0),
        view_count:    Number(c['view_count']    ?? 0),
        game_id:       String(c['game_id']       ?? ''),
        game_name:     String(c['game_name']     ?? ''),
        game_name_ja:  String(c['game_name_ja']  ?? ''),
        creator_name:  String(c['creator_name']  ?? ''),
        created_at:    String(c['created_at']    ?? ''),
        isLive,
      });

      if (mergingViewCount && vcPage !== null) {
        for (const item of interleavePage(dbClips, vcPage.liveOnPage, pageStart, state.PAGE_SIZE)) {
          if (item.kind === 'live') {
            clipItems.push({
              url: item.clip.url, thumbnail_url: item.clip.thumbnail_url,
              title: item.clip.title, duration: item.clip.duration,
              view_count: item.clip.view_count, game_id: item.clip.game_id ?? '',
              game_name: item.clip.game_name, game_name_ja: _gameNameJa.get(item.clip.game_id ?? '') ?? '',
              creator_name: item.clip.creator_name, created_at: item.clip.created_at,
              isLive: true,
            });
          } else {
            clipItems.push(toItem(item.row, false));
          }
        }
      } else {
        const liveItems = liveSlice.map(c => ({
          url: c.url, thumbnail_url: c.thumbnail_url, title: c.title,
          duration: c.duration, view_count: c.view_count, game_id: c.game_id ?? '',
          game_name: c.game_name, game_name_ja: _gameNameJa.get(c.game_id ?? '') ?? '',
          creator_name: c.creator_name, created_at: c.created_at, isLive: true,
        }));
        const dbItems = dbClips.map(c => toItem(c, false));
        // date_desc: live (newest) first; date_asc: DB (oldest) first, live appended.
        clipItems.push(...(mergingAsc ? [...dbItems, ...liveItems] : [...liveItems, ...dbItems]));
      }

      if (state.clipLayout === 'list') {
        const tr = t();
        const thead =
          `<thead><tr>` +
          `<th class="clip-col-title">${escHtml(tr.listColTitle)}</th>` +
          `<th class="clip-col-game">${escHtml(tr.listColGame)}</th>` +
          `<th class="clip-col-creator">${escHtml(tr.listColCreator)}</th>` +
          `<th class="clip-col-date">${escHtml(tr.listColDate)}</th>` +
          `<th class="clip-col-meta">${escHtml(tr.listColGame)} / ${escHtml(tr.listColCreator)} / ${escHtml(tr.listColDate)}</th>` +
          `<th class="clip-col-views">${escHtml(tr.listColViews)}</th>` +
          `</tr></thead>`;
        const tbody = clipItems.map(clip => clipListRowHtml(clip)).join('');
        grid.innerHTML = `<table class="clips-table">${thead}<tbody>${tbody}</tbody></table>`;
        grid.classList.add('is-list');
        attachImgErrorHandlers(grid);
      } else {
        grid.innerHTML = clipItems.map(clip => clipCardHtml(clip, clip.isLive ? ' live-clip' : '')).join('');
        grid.classList.remove('is-list');
        attachImgErrorHandlers(grid);
      }
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

  const calBtn = document.getElementById('btn-view-cal') as HTMLButtonElement;
  calBtn.title = tr.viewCalendar;
  calBtn.setAttribute('aria-label', tr.viewCalendar);
  (document.getElementById('btn-clear-dates')    as HTMLButtonElement).setAttribute('aria-label', tr.clearDates);

  const btnGrid = document.getElementById('btn-view-grid') as HTMLButtonElement | null;
  if (btnGrid) { btnGrid.setAttribute('aria-label', tr.viewGrid); btnGrid.title = tr.viewGrid; }
  const btnList = document.getElementById('btn-view-list') as HTMLButtonElement | null;
  if (btnList) { btnList.setAttribute('aria-label', tr.viewList); btnList.title = tr.viewList; }
  // Short labels shown next to the active icon on narrow screens
  const gridLabel = btnGrid?.querySelector('.view-btn-label') as HTMLElement | null;
  if (gridLabel) gridLabel.textContent = tr.viewGridLabel;
  const listLabel = btnList?.querySelector('.view-btn-label') as HTMLElement | null;
  if (listLabel) listLabel.textContent = tr.viewListLabel;

  // Controls collapse toggle: keep aria-label in sync with current state.
  const controlsToggleBtn = document.getElementById('btn-controls-toggle') as HTMLButtonElement | null;
  if (controlsToggleBtn) {
    const isCollapsed = document.getElementById('controls')?.classList.contains('controls-collapsed') ?? false;
    controlsToggleBtn.setAttribute('aria-label', isCollapsed ? tr.controlsExpand : tr.controlsCollapse);
  }

  const loadingText = document.getElementById('loading-text');
  if (loadingText) loadingText.textContent = tr.loading;
  (document.getElementById('empty') as HTMLElement).textContent = tr.noClips;

  // Auth / login
  const loginBtn = document.getElementById('btn-login');
  if (loginBtn) loginBtn.textContent = tr.loginBtn;
  const headerLoginBtn = document.getElementById('header-btn-login');
  if (headerLoginBtn) headerLoginBtn.textContent = tr.loginBtn;
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) { logoutBtn.title = tr.logoutBtn; logoutBtn.setAttribute('aria-label', tr.logoutBtn); }
  const refreshBtnEl = document.getElementById('btn-refresh-live') as HTMLButtonElement | null;
  if (refreshBtnEl) {
    const lbl = state.liveFetching ? tr.refreshingBtn : tr.refreshBtn;
    refreshBtnEl.title = lbl;
    refreshBtnEl.setAttribute('aria-label', lbl);
  }
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

  // Help modal (general "How to use")
  const helpBtn = document.getElementById('btn-help');
  if (helpBtn) { helpBtn.setAttribute('aria-label', tr.searchHelpBtn); helpBtn.title = tr.searchHelpBtn; }
  const helpModalTitle = document.getElementById('search-help-modal-title');
  if (helpModalTitle) helpModalTitle.textContent = tr.helpTitle;
  // Browsing section
  const helpBrowseH = document.getElementById('help-browse-heading');
  if (helpBrowseH) helpBrowseH.textContent = tr.helpBrowse;
  const helpBrowseD = document.getElementById('help-browse-desc');
  if (helpBrowseD) helpBrowseD.textContent = tr.helpBrowseDesc;
  // Timezone section
  const helpTzH = document.getElementById('help-tz-heading');
  if (helpTzH) helpTzH.textContent = tr.helpTimezone;
  const helpTzD = document.getElementById('help-tz-desc');
  if (helpTzD) helpTzD.textContent = tr.helpTimezoneDesc;
  // Layout section
  const helpLayoutH = document.getElementById('help-layout-heading');
  if (helpLayoutH) helpLayoutH.textContent = tr.helpLayout;
  const helpLayoutD = document.getElementById('help-layout-desc');
  if (helpLayoutD) helpLayoutD.textContent = tr.helpLayoutDesc;
  // Sort section
  const helpSortH = document.getElementById('help-sort-heading');
  if (helpSortH) helpSortH.textContent = tr.helpSort;
  const helpSortD = document.getElementById('help-sort-desc');
  if (helpSortD) helpSortD.textContent = tr.helpSortDesc;
  // Game section
  const helpGameH = document.getElementById('help-game-heading');
  if (helpGameH) helpGameH.textContent = tr.helpGame;
  const helpGameD = document.getElementById('help-game-desc');
  if (helpGameD) helpGameD.textContent = tr.helpGameDesc;
  // Search section
  const helpSearchH = document.getElementById('help-search-heading');
  if (helpSearchH) helpSearchH.textContent = tr.helpSearch;
  const helpSearchD = document.getElementById('help-search-desc');
  if (helpSearchD) helpSearchD.textContent = tr.helpSearchDesc;
  const helpSyntaxH = document.getElementById('help-search-syntax-heading');
  if (helpSyntaxH) helpSyntaxH.textContent = tr.searchHelpTitle;
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
  // Date section
  const helpDateH = document.getElementById('help-date-heading');
  if (helpDateH) helpDateH.textContent = tr.helpDate;
  const helpDateD = document.getElementById('help-date-desc');
  if (helpDateD) helpDateD.textContent = tr.helpDateDesc;
  // Login section — use the precise archive date when available
  const helpLoginH = document.getElementById('help-login-heading');
  if (helpLoginH) helpLoginH.textContent = tr.helpLogin;
  updateHelpLoginDesc();
  // Share section
  const helpShareH = document.getElementById('help-share-heading');
  if (helpShareH) helpShareH.textContent = tr.helpShare;
  const helpShareD = document.getElementById('help-share-desc');
  if (helpShareD) helpShareD.textContent = tr.helpShareDesc;
  const closeModalBtn = document.getElementById('btn-close-search-help');
  if (closeModalBtn) closeModalBtn.setAttribute('aria-label', tr.closeModal);
  // Calendar legend
  const calLegendFewer = document.getElementById('cal-legend-fewer');
  if (calLegendFewer) calLegendFewer.textContent = tr.calLegendFewer;
  const calLegendMore = document.getElementById('cal-legend-more');
  if (calLegendMore) calLegendMore.textContent = tr.calLegendMore;
}

/**
 * Update the login section in the help modal
 * Must be called after _dbCutoffDate and _dbScrapeDate are set.
 */
function updateHelpLoginDesc(): void {
  const tr = t();
  const helpLoginD = document.getElementById('help-login-desc');
  if (helpLoginD) {
    const loginDate = _dbScrapeDate ?? _dbCutoffDate;
    const dateLabel = loginDate ? fmtDateTime(loginDate, lang, state.tzOffset) : null;
    helpLoginD.textContent = dateLabel
      ? tr.helpLoginDescWithDate(dateLabel)
      : tr.helpLoginDescNoDate;
  }
}

// ── Timezone label ────────────────────────────────────────────────────────

function fmtTzOffset(off: number): string {
  const absH = Math.floor(Math.abs(off) / 60);
  const absM = Math.abs(off) % 60;
  const sign = off < 0 ? '−' : '+';
  return `UTC${sign}${absH}:${String(absM).padStart(2, '0')}`;
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

  // ── Layout toggle ─────────────────────────────────────────────────────────

  document.getElementById('btn-view-grid')?.addEventListener('click', () => {
    setClipLayout('grid');
    state.setCurrentPage(1);
    updateLayoutButtons();
    void render();
  });

  document.getElementById('btn-view-list')?.addEventListener('click', () => {
    setClipLayout('list');
    state.setCurrentPage(1);
    updateLayoutButtons();
    void render();
  });

  // Clip embed: delegated click handler on <main> (cards are re-created on
  // every render so per-element listeners would be lost).
  document.querySelector('main')!.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    if (target.closest('.clip-close-btn')) {
      const card = target.closest<HTMLElement>('.clip-card');
      if (card) { collapseCard(card); return; }
      const er = getExpandedRow();
      if (er) { collapseRow(er); return; }
      return;
    }
    if (target.closest('.clip-prev-btn')) {
      if (getExpandedRow()) navigateRow('prev'); else navigateClip('prev');
      return;
    }
    if (target.closest('.clip-next-btn')) {
      if (getExpandedRow()) navigateRow('next'); else navigateClip('next');
      return;
    }
    if (target.closest('.clip-game-link')) {
      const btn = target.closest<HTMLElement>('.clip-game-link');
      const gameId = btn?.dataset['gameId'] ?? '';
      if (gameId) {
        state.setGameFilter(gameId);
        state.setCurrentPage(1);
        void render();
      }
      return;
    }
    // List-view row: expand embed row below on click (except title link or game filter).
    const row = target.closest<HTMLElement>('.clip-row');
    if (row && !target.closest('a') && !target.closest('.clip-game-link')) {
      if (row === getExpandedRow()) collapseRow(row); else expandRow(row);
      return;
    }
    // Grid-view card: expand embed on click anywhere except title link.
    const card = target.closest<HTMLElement>('.clip-card');
    if (card && !target.closest('a')) {
      expandCard(card);
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const ec = getExpandedCard();
      if (ec) collapseCard(ec);
      else { const er = getExpandedRow(); if (er) collapseRow(er); }
    }
  });

  // ── Auth buttons ──────────────────────────────────────────────────────────

  document.getElementById('btn-login')?.addEventListener('click', () => {
    void auth.initiateLogin();
  });

  document.getElementById('header-btn-login')?.addEventListener('click', () => {
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
    document.getElementById('header-login')!.style.display = 'flex';
  });

  // ── Controls bar collapse toggle ────────────────────────────────────────────
  {
    const toggleBtn  = document.getElementById('btn-controls-toggle') as HTMLButtonElement | null;
    const controlsEl = document.getElementById('controls')!;
    // No cross-session persistence: always start expanded so filters are
    // visible on first load regardless of screen width or prior sessions.
    toggleBtn?.addEventListener('click', () => {
      const isCollapsed = controlsEl.classList.toggle('controls-collapsed');
      toggleBtn.setAttribute('aria-label', isCollapsed ? t().controlsExpand : t().controlsCollapse);
    });
  }

  // ── Site description toggle (mobile) ────────────────────────────────────────
  {
    const desc    = document.getElementById('site-desc');
    const btn     = document.getElementById('btn-site-desc') as HTMLButtonElement | null;
    const titleEl = document.querySelector('.header-title') as HTMLElement | null;
    if (desc && btn && titleEl && desc.textContent?.trim()) {
      titleEl.classList.add('has-desc');
      btn.addEventListener('click', () => {
        const expanded = titleEl.classList.toggle('desc-expanded');
        btn.setAttribute('aria-expanded', String(expanded));
      });
    }
  }

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

  // ── Help modal (general "How to use") ────────────────────────────────────

  const searchHelpModal = document.getElementById('search-help-modal') as HTMLDialogElement | null;
  document.getElementById('btn-help')?.addEventListener('click', () => {
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
    updateLayoutButtons();

    _broadcasterId = await setStreamerTag();
    renderFooter();
    bindEvents();
    syncAuthUI();
    // called in applyTranslations() above, but need to update after _dbScrapeDate and
    // _dbCutoffDate are available
    updateHelpLoginDesc();
    initEmbed(render);
    await initCalendar(render); // must await: queries clip date range for nav bounds

    // Fetch live clips in the background; render() is called again when done.
    if (auth.isLoggedIn()) void fetchLiveClips();

    if (location.hash && location.hash.length > 1) {
      applyStateHash(location.hash);
      // initialize structuralHash
      state.setLastStructuralHash(serializeHashExecptSearchQuery(getStateForHash()));
    } else {
      void render();
    }

    window.addEventListener('popstate', () => {
      if (location.hash && location.hash.length > 1) {
        applyStateHash(location.hash);
        state.setLastStructuralHash(serializeHashExecptSearchQuery(getStateForHash()));
      } else {
        // Empty hash → reset to default state
        state.setSearchQuery('');
        state.setSortBy('date_desc');
        state.setGameFilter('');
        state.setCurrentPage(1);
        state.setCurrentView('grid');
        setClipLayout('grid');
        updateLayoutButtons();
        clearCalDateFilter();
        (document.getElementById('search') as HTMLInputElement).value       = '';
        (document.getElementById('sort') as HTMLSelectElement).value        = 'date_desc';
        (document.getElementById('game-filter') as HTMLSelectElement).value = '';
        document.getElementById('btn-view-cal')!.classList.remove('active');
        document.getElementById('calendar-panel')!.style.display = 'none';
        state.setLastStructuralHash(serializeHashExecptSearchQuery(getStateForHash()));
        void render();
      }
      syncAuthUI();
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
