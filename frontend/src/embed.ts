// ── Clip embed, expand/collapse, and prev/next navigation ─────────────────
//
// All DOM state for the currently-open embed lives here so app.ts only needs
// to call the exported functions — it never touches the embed vars directly.
//
// Circular-dependency note: navigateClip/navigateRow need to trigger a full
// render() when crossing a page boundary.  Importing render() directly from
// app.ts would create a cycle (app.ts → embed.ts → app.ts).  We break it with
// the same callback-injection pattern used by calendar.ts: initEmbed(render)
// is called once during app startup and stores the function in _render.

import { escHtml } from './lib/format';
import { t } from './lib/i18n';
import * as state from './state';

// Injected by initEmbed() to avoid a circular import with app.ts.
let _render: (() => Promise<void>) | null = null;
let _onCloseRender: (() => void) | null = null;

export function initEmbed(render: () => Promise<void>, onCloseRender?: () => void): void {
  _render = render;
  _onCloseRender = onCloseRender ?? null;
}

// ── Module state ──────────────────────────────────────────────────────────

// Grid-view expand state: the playing card (left in place, highlighted) and
// the full-width player panel shown in the grid row below it.
let _expandedCard: HTMLElement | null = null;
let _panel: HTMLElement | null = null;
// Re-places the panel when the grid's width (and so its column count) changes.
let _panelObserver: ResizeObserver | null = null;
let _panelGridWidth = 0;
// List-view expand state: the expanded <tr> row and the embed <tr> inserted after it.
let _expandedRow: HTMLElement | null = null;
// Set while expandRow is in progress so collapseRow knows it's a row swap,
// not a standalone close, and skips the post-collapse render. (Switching grid
// cards never collapses: expandCard just repoints the panel.)
let _expanding = false;
let _insertedEmbedRow: HTMLElement | null = null;

/** What a prev/next peek button needs to show for a neighbouring clip. */
export type PeekClip = { title: string; thumbnail_url: string };

// The last clip on the previous page / first clip on the next page.
// Set by app.ts render() after the adjacent-page prefetch; read here by
// expandCard/expandRow to populate the page-boundary peek buttons.
let _prevPageLast: PeekClip | null = null;
let _nextPageFirst: PeekClip | null = null;

// ── Accessors for app.ts ──────────────────────────────────────────────────

export function getExpandedCard(): HTMLElement | null { return _expandedCard; }
export function getExpandedRow():  HTMLElement | null { return _expandedRow; }

/** Called by render() after prefetching the adjacent-page boundary clips. */
export function setPageBoundaryClips(prev: PeekClip | null, next: PeekClip | null): void {
  _prevPageLast = prev;
  _nextPageFirst = next;
}

/**
 * Reset any expanded embed that lives inside `#clips-grid`.
 * Must be called by render() before it replaces the grid's innerHTML.
 */
export function resetIfInGrid(): void {
  if (_expandedCard?.closest('#clips-grid')) {
    _expandedCard = null;
    _panel = null; // will be destroyed by innerHTML replacement
    _panelObserver?.disconnect();
    _panelObserver = null;
    document.removeEventListener('click', _onDocClickOutside);
  }
  if (_expandedRow?.closest('#clips-grid')) {
    _insertedEmbedRow = null; // will be destroyed by innerHTML replacement
    _expandedRow = null;
    document.removeEventListener('click', _onDocClickOutside);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────

export function extractClipSlug(url: string): string | null {
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

function embedSrc(slug: string): string {
  const parent = encodeURIComponent(window.location.hostname || 'localhost');
  return `https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${parent}&autoplay=false`;
}

function embedWrapHtml(slug: string): string {
  return `<div class="clip-embed-wrap">` +
    `<button class="clip-close-btn" aria-label="${escHtml(t().closeEmbed)}" type="button">&#x2715;</button>` +
    `<iframe src="${escHtml(embedSrc(slug))}" class="clip-iframe" allowfullscreen scrolling="no"></iframe>` +
    `</div>`;
}

/** Read a rendered card/row's title and thumbnail for use in a peek button. */
function peekFromEl(el: HTMLElement | undefined): PeekClip | null {
  if (!el) return null;
  return {
    title: el.querySelector('.clip-title-text')?.textContent?.trim() ?? '',
    thumbnail_url: el.querySelector('.clip-thumb img')?.getAttribute('src') ?? '',
  };
}

/** Neighbouring clips of item `idx` in `items`, falling back to the
 *  prefetched page-boundary clips at either end of the page. */
function neighbours(items: HTMLElement[], idx: number): {
  prev: PeekClip | null; next: PeekClip | null;
  prevDisabled: boolean; nextDisabled: boolean;
} {
  const totalPages = Math.ceil(state.totalClips / state.PAGE_SIZE);
  return {
    prev: peekFromEl(items[idx - 1]) ?? (idx === 0 ? _prevPageLast : null),
    next: peekFromEl(items[idx + 1]) ?? (idx === items.length - 1 ? _nextPageFirst : null),
    prevDisabled: idx <= 0 && state.currentPage <= 1,
    nextDisabled: idx >= items.length - 1 && state.currentPage >= totalPages,
  };
}

const CHEVRON_LEFT  = '<svg viewBox="0 0 12 12" aria-hidden="true"><polyline points="7.5 2 3.5 6 7.5 10"/></svg>';
const CHEVRON_RIGHT = '<svg viewBox="0 0 12 12" aria-hidden="true"><polyline points="4.5 2 8.5 6 4.5 10"/></svg>';

/**
 * Prev/next "peek" button: a mini clip card (direction label, thumbnail with
 * an arrow badge, title) so it reads as "the clip you'll go to" rather than
 * an abstract arrow. Laid out beside the player on wide screens and below it
 * on narrow ones (see .clip-peek in style.css). A disabled button stays in
 * the DOM (visibility: hidden) so the player remains centred.
 */
function peekButtonHtml(dir: 'prev' | 'next', clip: PeekClip | null, disabled: boolean): string {
  const tr = t();
  const label = dir === 'prev' ? tr.prevClip : tr.nextClip;
  const chevron = dir === 'prev' ? CHEVRON_LEFT : CHEVRON_RIGHT;
  const aria = clip?.title ? `${label}: ${clip.title}` : label;
  const img = clip?.thumbnail_url
    ? `<img src="${escHtml(clip.thumbnail_url)}" alt="" loading="lazy">`
    : '';
  const dirLabel = dir === 'prev'
    ? `${chevron}<span>${escHtml(label)}</span>`
    : `<span>${escHtml(label)}</span>${chevron}`;
  return `<button class="clip-peek clip-${dir}-btn" type="button" aria-label="${escHtml(aria)}"${disabled ? ' disabled' : ''}>` +
    `<span class="clip-peek-dir">${dirLabel}</span>` +
    `<span class="clip-peek-thumb">${img}<span class="clip-peek-arrow">${chevron}</span></span>` +
    `<span class="clip-peek-title">${escHtml(clip?.title ?? '')}</span>` +
    `</button>`;
}

/** [prev peek][player][next peek], laid out by .clip-stage in style.css. */
function stageHtml(slug: string, n: ReturnType<typeof neighbours>): string {
  return `<div class="clip-stage">` +
    peekButtonHtml('prev', n.prev, n.prevDisabled) +
    embedWrapHtml(slug) +
    peekButtonHtml('next', n.next, n.nextDisabled) +
    `</div>`;
}

/**
 * Scroll (if needed) so everything from the top of `top` to the bottom of
 * `bottom` is in view. The clicked clip and its player are separate elements
 * (list: two <tr>s; grid: the card and the panel a row below), so
 * scrollIntoView on either alone can leave the player or peeks off-screen.
 *
 * When the span is taller than the viewport, `prefer` picks the end to keep:
 * 'top' puts `top` at the top (list view: the row is the clip's title);
 * 'bottom' shows all of `bottom` and as much of `top` as fits above it (grid
 * view: the card's title sits at its bottom edge, above a thumbnail that just
 * repeats the player).
 */
function scrollSpanIntoView(top: HTMLElement, bottom: HTMLElement, prefer: 'top' | 'bottom' = 'top'): void {
  const MARGIN = 8;
  const t = top.getBoundingClientRect().top - MARGIN;
  const bRect = bottom.getBoundingClientRect();
  const b = bRect.bottom + MARGIN;
  const vh = window.innerHeight;
  let delta: number;
  if (b - t <= vh) {
    delta = t < 0 ? t : (b > vh ? b - vh : 0);
  } else if (prefer === 'bottom') {
    const bt = bRect.top - MARGIN;
    delta = b - bt > vh ? bt : b - vh;
  } else {
    delta = t;
  }
  if (delta !== 0) window.scrollBy({ top: delta, behavior: 'smooth' });
}

function hideBrokenPeekImages(container: HTMLElement): void {
  container.querySelectorAll<HTMLImageElement>('.clip-peek-thumb img').forEach(img => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

// ── Keyboard focus ────────────────────────────────────────────────────────
//
// Stepping to another clip rebuilds the player's buttons and closing removes
// them. If one had focus, keyboard users would be dropped back to <body>, so
// focus moves to the same button in the new player, or to the clip's
// thumbnail (its play button) when the player closes.

const STAGE_CONTROLS = ['.clip-prev-btn', '.clip-next-btn', '.clip-close-btn'];

/** The selector of the player button in `stage` that has focus, if any. */
function focusedControl(stage: HTMLElement | null): string | null {
  const el = document.activeElement;
  if (!stage || !el || !stage.contains(el)) return null;
  return STAGE_CONTROLS.find(sel => el.matches(sel)) ?? null;
}

/** Focus the `sel` button in `stage`, or its close button if that one's
 *  disabled (no clip that way). */
function refocus(stage: HTMLElement | null, sel: string | null): void {
  if (!stage || !sel) return;
  const btn = stage.querySelector<HTMLButtonElement>(sel);
  const target = btn && !btn.disabled ? btn : stage.querySelector<HTMLElement>('.clip-close-btn');
  target?.focus({ preventScroll: true });
}

function thumbOf(clip: HTMLElement): HTMLElement | null {
  return clip.querySelector<HTMLElement>('.clip-thumb');
}

/** Mark `clip`'s play button as having its player open or closed. */
function setExpanded(clip: HTMLElement, expanded: boolean): void {
  thumbOf(clip)?.setAttribute('aria-expanded', String(expanded));
}

function _onDocClickOutside(e: MouseEvent): void {
  const target = e.target as Node;
  if (_expandedCard) {
    const inPanel = _panel !== null && _panel.contains(target);
    if (!_expandedCard.contains(target) && !inPanel) collapseCard(_expandedCard);
  } else if (_expandedRow) {
    const inRow   = _expandedRow.contains(target);
    const inEmbed = _insertedEmbedRow !== null && _insertedEmbedRow.contains(target);
    if (!inRow && !inEmbed) collapseRow(_expandedRow);
  }
}

// ── Grid card expand/collapse ─────────────────────────────────────────────
//
// Google Images style: the clicked card stays where it is, highlighted as
// now playing, and the player opens in a full-width panel in the grid row
// below the card's row — so no card is orphaned, and stepping to a neighbour
// in the same row just swaps the panel's contents.

/**
 * Where the player panel goes for the card at `idx` (of `count`) in a
 * `cols`-column grid: the 1-based grid line it starts on (the row below the
 * card's) and the index of the card it follows in the DOM (the row's last).
 */
export function panelSlot(idx: number, cols: number, count: number): { gridRow: number; after: number } {
  const row = Math.floor(idx / cols);
  return { gridRow: row + 2, after: Math.min(count - 1, (row + 1) * cols - 1) };
}

function gridCards(grid: HTMLElement): HTMLElement[] {
  return Array.from(grid.querySelectorAll<HTMLElement>(':scope > .clip-card'));
}

/**
 * Where `el`'s layout box sits in the viewport, give or take a constant: only
 * for before/after comparisons. It sees any scrolling the browser did in
 * between (scroll anchoring, clamping) as well as `el`'s move, so correcting
 * by the difference holds `el` still on screen. Unlike getBoundingClientRect
 * it ignores transforms, i.e. a card's hover lift.
 */
function viewportTop(el: HTMLElement): number {
  return el.offsetTop - window.scrollY; // offsetTop first: it forces the layout
}

/** The grid's column count (a grid container's computed track list has one size per track). */
function gridColumnCount(grid: HTMLElement): number {
  return getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
}

/**
 * Put the panel in the row below the playing card's and point its notch at
 * the card. The row is set with an explicit grid-row, not implied by DOM
 * order, so when a resize changes the column count the panel can move without
 * being re-inserted — re-inserting it would reload the iframe and restart the
 * clip. (Its DOM position, which sets the reading/tab order, is updated only
 * when expandCard refills it.)
 */
function placePanel(): void {
  const card = _expandedCard;
  const panel = _panel;
  const grid = card?.parentElement;
  if (!card || !panel || !grid) return;
  const cards = gridCards(grid);
  const cols = gridColumnCount(grid);
  panel.style.gridRow = String(panelSlot(cards.indexOf(card), cols, cards.length).gridRow);
  // One column: the player sits right under the card, so its thumbnail would
  // just repeat it — hide it and leave the title/meta as the player's header.
  card.classList.toggle('single-col', cols === 1);
  // That hides the play button; if it had focus, pass focus to the player.
  if (cols === 1 && document.activeElement === thumbOf(card)) {
    panel.querySelector<HTMLElement>('.clip-close-btn')?.focus({ preventScroll: true });
  }
  const c = card.getBoundingClientRect();
  panel.style.setProperty('--notch-x', `${c.left + c.width / 2 - panel.getBoundingClientRect().left}px`);
  _panelGridWidth = grid.clientWidth;
}

export function collapseCard(card: HTMLElement): void {
  const hadFocus = !!_panel?.contains(document.activeElement);
  card.classList.remove('playing', 'single-col');
  card.removeAttribute('aria-current');
  setExpanded(card, false);
  _panel?.remove();
  _panel = null;
  _panelObserver?.disconnect();
  _panelObserver = null;
  document.removeEventListener('click', _onDocClickOutside);
  _expandedCard = null;
  if (hadFocus) thumbOf(card)?.focus({ preventScroll: true });
  _onCloseRender?.();
}

export function expandCard(card: HTMLElement, skipScroll = false): void {
  const clipUrl = card.dataset['clipUrl'] ?? '';
  const slug = extractClipSlug(clipUrl);
  if (!slug) {
    window.open(clipUrl, '_blank', 'noopener,noreferrer');
    return;
  }
  const grid = card.parentElement;
  if (!grid) return;

  // Read layout up front: from the detach below until the panel is back in,
  // nothing may force a layout. One would lay out a page a panel shorter
  // and, near the bottom of the page, clamp the scroll position upwards.
  const cardTopBefore = viewportTop(card);
  const cards = gridCards(grid);
  const idx = cards.indexOf(card);
  const slot = panelSlot(idx, gridColumnCount(grid), cards.length);

  const focused = focusedControl(_panel);
  if (_expandedCard) {
    _expandedCard.classList.remove('playing', 'single-col');
    _expandedCard.removeAttribute('aria-current');
    setExpanded(_expandedCard, false);
  }
  if (!_panel) {
    _panel = document.createElement('div');
    _panel.className = 'clip-panel';
    // The rAF defers the re-placement (which changes the grid's height) out of
    // the observer callback, avoiding a ResizeObserver loop error.
    _panelObserver = new ResizeObserver(() => {
      if (grid.clientWidth !== _panelGridWidth) requestAnimationFrame(placePanel);
    });
    _panelObserver.observe(grid);
  }
  // Refill the panel while detached so the new iframe loads once, at its
  // final position: after the last card of the playing card's row, which
  // keeps the reading/tab order in step with the layout.
  _panel.remove();
  _panel.innerHTML = stageHtml(slug, neighbours(cards, idx));
  hideBrokenPeekImages(_panel);
  _panel.style.gridRow = String(slot.gridRow);
  cards[slot.after]?.after(_panel);

  card.classList.add('playing');
  card.setAttribute('aria-current', 'true');
  setExpanded(card, true);
  _expandedCard = card;
  placePanel();
  refocus(_panel, focused);

  if (!skipScroll) {
    // Clicking a card below an open panel pulls that card up by the panel's
    // height as the panel moves down past it; undo the jump, then scroll.
    const jump = viewportTop(card) - cardTopBefore;
    if (jump !== 0) window.scrollBy({ top: jump, behavior: 'instant' });
    scrollSpanIntoView(card, _panel, 'bottom');
  }
  // (Re-)add the click-outside listener on the next tick so the current
  // click — on this card, or on a peek the panel just replaced — doesn't
  // reach it and collapse the panel.
  document.removeEventListener('click', _onDocClickOutside);
  setTimeout(() => document.addEventListener('click', _onDocClickOutside), 0);
}

// ── List-view row expand/collapse ─────────────────────────────────────────

export function collapseRow(row: HTMLElement): void {
  const hadFocus = !!_insertedEmbedRow?.contains(document.activeElement);
  _insertedEmbedRow?.remove();
  _insertedEmbedRow = null;
  row.classList.remove('expanded');
  setExpanded(row, false);
  document.removeEventListener('click', _onDocClickOutside);
  _expandedRow = null;
  if (_expanding) return; // expandRow refocuses the new embed row
  if (hadFocus) thumbOf(row)?.focus({ preventScroll: true });
  _onCloseRender?.();
}

export function expandRow(row: HTMLElement, skipScroll = false): void {
  const focused = focusedControl(_insertedEmbedRow);
  if (_expandedRow && _expandedRow !== row) {
    _expanding = true;
    collapseRow(_expandedRow);
    _expanding = false;
  }

  const clipUrl = row.dataset['clipUrl'] ?? '';
  const slug = extractClipSlug(clipUrl);
  if (!slug) {
    window.open(clipUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  const tbody = row.closest('tbody');
  const allRows = tbody ? Array.from(tbody.querySelectorAll<HTMLElement>('.clip-row')) : [];

  // Count only visible cells — hidden cells (display:none from responsive CSS) must be excluded.
  const colCount = Array.from(row.querySelectorAll('td'))
    .filter(td => getComputedStyle(td).display !== 'none').length;
  const embedRow = document.createElement('tr');
  embedRow.className = 'clip-embed-row';
  const td = document.createElement('td');
  td.colSpan = colCount;
  td.innerHTML = stageHtml(slug, neighbours(allRows, allRows.indexOf(row)));
  hideBrokenPeekImages(td);
  embedRow.appendChild(td);

  row.insertAdjacentElement('afterend', embedRow);
  _insertedEmbedRow = embedRow;
  row.classList.add('expanded');
  setExpanded(row, true);
  _expandedRow = row;
  refocus(embedRow, focused);
  if (!skipScroll) scrollSpanIntoView(row, embedRow);
  setTimeout(() => document.addEventListener('click', _onDocClickOutside), 0);
}

// ── Navigation ────────────────────────────────────────────────────────────

export async function navigateClip(direction: 'prev' | 'next'): Promise<void> {
  if (!_expandedCard || !_panel) return;
  const allCards = _expandedCard.parentElement ? gridCards(_expandedCard.parentElement) : [];
  const idx = allCards.indexOf(_expandedCard);
  const target = allCards[direction === 'prev' ? idx - 1 : idx + 1];
  if (target) {
    // Keep the player where it is on screen. Within a row the panel doesn't
    // move; stepping into the next/previous row it hops over a row of cards.
    // Measure on screen, not in the page: near the bottom the browser's scroll
    // anchoring also scrolls as the panel hops (it anchors on the row the
    // panel passes), and this undoes that too.
    const panel = _panel;
    const topBefore = viewportTop(panel);
    expandCard(target, true);
    const shift = viewportTop(panel) - topBefore;
    if (shift !== 0) window.scrollBy({ top: shift, behavior: 'instant' });
  } else {
    // render() replaces the whole grid, player included: note which of its
    // buttons had focus so the new page's player can take it over.
    const focused = focusedControl(_panel);
    const totalPages = Math.ceil(state.totalClips / state.PAGE_SIZE);
    if (direction === 'next' && state.currentPage < totalPages) {
      state.setCurrentPage(state.currentPage + 1);
      await _render?.();
      const firstCard = document.querySelector<HTMLElement>('#clips-grid .clip-card');
      if (firstCard) expandCard(firstCard);
    } else if (direction === 'prev' && state.currentPage > 1) {
      state.setCurrentPage(state.currentPage - 1);
      await _render?.();
      const allNewCards = Array.from(document.querySelectorAll<HTMLElement>('#clips-grid .clip-card'));
      const lastCard = allNewCards[allNewCards.length - 1];
      if (lastCard) expandCard(lastCard);
    }
    refocus(_panel, focused);
  }
}

export async function navigateRow(direction: 'prev' | 'next'): Promise<void> {
  if (!_expandedRow) return;
  const tbody = _expandedRow.closest('tbody');
  const allRows = tbody ? Array.from(tbody.querySelectorAll<HTMLElement>('.clip-row')) : [];
  const idx = allRows.indexOf(_expandedRow);
  const target = allRows[direction === 'prev' ? idx - 1 : idx + 1];
  if (target) {
    const topBefore = _expandedRow.getBoundingClientRect().top;
    expandRow(target, true);
    const topAfter = target.getBoundingClientRect().top;
    window.scrollBy({ top: topAfter - topBefore, behavior: 'instant' });
  } else {
    const focused = focusedControl(_insertedEmbedRow); // see navigateClip
    const totalPages = Math.ceil(state.totalClips / state.PAGE_SIZE);
    if (direction === 'next' && state.currentPage < totalPages) {
      state.setCurrentPage(state.currentPage + 1);
      await _render?.();
      const firstRow = document.querySelector<HTMLElement>('#clips-grid .clip-row');
      if (firstRow) expandRow(firstRow);
    } else if (direction === 'prev' && state.currentPage > 1) {
      state.setCurrentPage(state.currentPage - 1);
      await _render?.();
      const allNewRows = Array.from(document.querySelectorAll<HTMLElement>('#clips-grid .clip-row'));
      const lastRow = allNewRows[allNewRows.length - 1];
      if (lastRow) expandRow(lastRow);
    }
    refocus(_insertedEmbedRow, focused);
  }
}
