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

const _thumbCache = new WeakMap<HTMLElement, HTMLElement>();
let _expandedCard: HTMLElement | null = null;
// List-view expand state: the expanded <tr> row and the embed <tr> inserted after it.
let _expandedRow: HTMLElement | null = null;
// Set while expandCard/expandRow is in progress so collapseCard/collapseRow
// knows it's a card swap, not a standalone close, and skips the post-collapse render.
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

/**
 * Scroll (if needed) so everything from the top of `top` to the bottom of
 * `bottom` is in view — or, when that span is taller than the viewport, so
 * `top` sits at the top. List view needs this because the clicked row and its
 * player live in separate <tr>s, so scrollIntoView on either alone can leave
 * the player or the peeks below the fold.
 */
function scrollSpanIntoView(top: HTMLElement, bottom: HTMLElement): void {
  const MARGIN = 8;
  const t = top.getBoundingClientRect().top - MARGIN;
  const b = bottom.getBoundingClientRect().bottom + MARGIN;
  const vh = window.innerHeight;
  const delta = (b - t > vh || t < 0) ? t : (b > vh ? b - vh : 0);
  if (delta !== 0) window.scrollBy({ top: delta, behavior: 'smooth' });
}

function hideBrokenPeekImages(container: HTMLElement): void {
  container.querySelectorAll<HTMLImageElement>('.clip-peek-thumb img').forEach(img => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

function _onDocClickOutside(e: MouseEvent): void {
  const target = e.target as Node;
  if (_expandedCard && !_expandedCard.contains(target)) {
    collapseCard(_expandedCard);
  } else if (_expandedRow) {
    const inRow   = _expandedRow.contains(target);
    const inEmbed = _insertedEmbedRow !== null && _insertedEmbedRow.contains(target);
    if (!inRow && !inEmbed) collapseRow(_expandedRow);
  }
}

// ── Grid card expand/collapse ─────────────────────────────────────────────

export function collapseCard(card: HTMLElement): void {
  const savedThumb = _thumbCache.get(card);
  const embedWrap = card.querySelector<HTMLElement>('.clip-embed-wrap');
  if (embedWrap && savedThumb) embedWrap.replaceWith(savedThumb);
  _thumbCache.delete(card);
  card.querySelectorAll('.clip-peek').forEach(el => el.remove());
  card.classList.remove('expanded');
  document.removeEventListener('click', _onDocClickOutside);
  _expandedCard = null;
  if (!_expanding) _onCloseRender?.();
}

export function expandCard(card: HTMLElement, skipScroll = false): void {
  if (_expandedCard && _expandedCard !== card) {
    _expanding = true;
    collapseCard(_expandedCard);
    _expanding = false;
  }

  const clipUrl = card.dataset['clipUrl'] ?? '';
  const slug = extractClipSlug(clipUrl);
  if (!slug) {
    window.open(clipUrl, '_blank', 'noopener,noreferrer');
    return;
  }

  const thumb = card.querySelector<HTMLElement>('.clip-thumb');
  if (!thumb) return;

  _thumbCache.set(card, thumb);

  // Replace the thumbnail with [prev peek][player][next peek]; the expanded
  // card is a CSS grid that places these (and .clip-info) responsively.
  const allCards = Array.from(card.parentElement?.querySelectorAll<HTMLElement>('.clip-card') ?? []);
  const n = neighbours(allCards, allCards.indexOf(card));
  const tmp = document.createElement('div');
  tmp.innerHTML =
    peekButtonHtml('prev', n.prev, n.prevDisabled) +
    embedWrapHtml(slug) +
    peekButtonHtml('next', n.next, n.nextDisabled);
  hideBrokenPeekImages(tmp);
  thumb.replaceWith(...Array.from(tmp.children));

  card.classList.add('expanded');
  _expandedCard = card;
  if (!skipScroll) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // Add click-outside listener on the next tick so the current click
  // doesn't immediately trigger it and collapse the card.
  setTimeout(() => document.addEventListener('click', _onDocClickOutside), 0);
}

// ── List-view row expand/collapse ─────────────────────────────────────────

export function collapseRow(row: HTMLElement): void {
  _insertedEmbedRow?.remove();
  _insertedEmbedRow = null;
  row.classList.remove('expanded');
  document.removeEventListener('click', _onDocClickOutside);
  _expandedRow = null;
  if (!_expanding) _onCloseRender?.();
}

export function expandRow(row: HTMLElement, skipScroll = false): void {
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
  const n = neighbours(allRows, allRows.indexOf(row));

  // Count only visible cells — hidden cells (display:none from responsive CSS) must be excluded.
  const colCount = Array.from(row.querySelectorAll('td'))
    .filter(td => getComputedStyle(td).display !== 'none').length;
  const embedRow = document.createElement('tr');
  embedRow.className = 'clip-embed-row';
  const td = document.createElement('td');
  td.colSpan = colCount;
  td.innerHTML =
    `<div class="clip-stage">` +
    peekButtonHtml('prev', n.prev, n.prevDisabled) +
    embedWrapHtml(slug) +
    peekButtonHtml('next', n.next, n.nextDisabled) +
    `</div>`;
  hideBrokenPeekImages(td);
  embedRow.appendChild(td);

  row.insertAdjacentElement('afterend', embedRow);
  _insertedEmbedRow = embedRow;
  row.classList.add('expanded');
  _expandedRow = row;
  if (!skipScroll) scrollSpanIntoView(row, embedRow);
  setTimeout(() => document.addEventListener('click', _onDocClickOutside), 0);
}

// ── Navigation ────────────────────────────────────────────────────────────

export async function navigateClip(direction: 'prev' | 'next'): Promise<void> {
  if (!_expandedCard) return;
  const allCards = Array.from(_expandedCard.parentElement?.querySelectorAll<HTMLElement>('.clip-card') ?? []);
  const idx = allCards.indexOf(_expandedCard);
  const target = allCards[direction === 'prev' ? idx - 1 : idx + 1];
  if (target) {
    // Capture the embed's current screen position before the DOM changes,
    // then instantly correct scroll so it stays at the same vertical position.
    const topBefore = _expandedCard.getBoundingClientRect().top;
    expandCard(target, true);
    const topAfter = target.getBoundingClientRect().top;
    window.scrollBy({ top: topAfter - topBefore, behavior: 'instant' });
  } else {
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
  }
}
