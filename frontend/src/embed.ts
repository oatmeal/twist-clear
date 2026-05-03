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
// Titles of the last clip on the previous page / first clip on the next page.
// Set by app.ts render() after the adjacent-page prefetch; read here by
// expandCard/expandRow to populate page-boundary nav button labels.
let _prevPageLastTitle: string | null = null;
let _nextPageFirstTitle: string | null = null;

// ── Accessors for app.ts ──────────────────────────────────────────────────

export function getExpandedCard(): HTMLElement | null { return _expandedCard; }
export function getExpandedRow():  HTMLElement | null { return _expandedRow; }

/** Called by render() after computing adjacent-page boundary titles. */
export function setPageBoundaryTitles(prev: string | null, next: string | null): void {
  _prevPageLastTitle = prev;
  _nextPageFirstTitle = next;
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
  // Restore clip-info from nav row if present
  const navRow = card.querySelector<HTMLElement>('.clip-nav-row');
  const info = navRow?.querySelector<HTMLElement>('.clip-info');
  if (navRow && info) navRow.replaceWith(info);
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
    const totalPages = Math.ceil(state.totalClips / state.PAGE_SIZE);
    // Read adjacent titles: same-page neighbour from the DOM, page-boundary from prefetch cache.
    const prevTitle =
      allCards[idx - 1]?.querySelector<HTMLElement>('.clip-title-text')?.textContent?.trim()
      ?? (idx === 0 ? _prevPageLastTitle : null)
      ?? '';
    const nextTitle =
      allCards[idx + 1]?.querySelector<HTMLElement>('.clip-title-text')?.textContent?.trim()
      ?? (idx === allCards.length - 1 ? _nextPageFirstTitle : null)
      ?? '';
    const navRow = document.createElement('div');
    navRow.className = 'clip-nav-row';
    const prevBtn = document.createElement('button');
    prevBtn.className = 'clip-nav-btn clip-prev-btn';
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', t().prevClip);
    prevBtn.disabled = idx <= 0 && state.currentPage <= 1;
    prevBtn.innerHTML = `&#8592;<span class="clip-nav-title">${escHtml(prevTitle)}</span>`;
    const nextBtn = document.createElement('button');
    nextBtn.className = 'clip-nav-btn clip-next-btn';
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', t().nextClip);
    nextBtn.disabled = idx >= allCards.length - 1 && state.currentPage >= totalPages;
    nextBtn.innerHTML = `<span class="clip-nav-title">${escHtml(nextTitle)}</span>&#8594;`;
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

  const parent = encodeURIComponent(window.location.hostname || 'localhost');
  const src = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(slug)}&parent=${parent}&autoplay=false`;

  const tbody = row.closest('tbody');
  const allRows = tbody ? Array.from(tbody.querySelectorAll<HTMLElement>('.clip-row')) : [];
  const idx = allRows.indexOf(row);

  // Read adjacent titles: same-page neighbour from the DOM, page-boundary from prefetch cache.
  const prevTitle =
    allRows[idx - 1]?.querySelector<HTMLElement>('.clip-title-text')?.textContent?.trim()
    ?? (idx === 0 ? _prevPageLastTitle : null)
    ?? '';
  const nextTitle =
    allRows[idx + 1]?.querySelector<HTMLElement>('.clip-title-text')?.textContent?.trim()
    ?? (idx === allRows.length - 1 ? _nextPageFirstTitle : null)
    ?? '';

  const totalPagesRow = Math.ceil(state.totalClips / state.PAGE_SIZE);
  const prevDisabled = idx <= 0 && state.currentPage <= 1;
  const nextDisabled = idx >= allRows.length - 1 && state.currentPage >= totalPagesRow;
  const prevArrow = idx <= 0 && state.currentPage > 1 ? '&#8592;' : '&#8593;';
  const nextArrow = idx >= allRows.length - 1 && state.currentPage < totalPagesRow ? '&#8594;' : '&#8595;';

  // Count only visible cells — hidden cells (display:none from responsive CSS) must be excluded.
  const colCount = Array.from(row.querySelectorAll('td'))
    .filter(td => getComputedStyle(td).display !== 'none').length;
  const embedRow = document.createElement('tr');
  embedRow.className = 'clip-embed-row';
  const td = document.createElement('td');
  td.colSpan = colCount;
  td.innerHTML =
    `<div class="clip-embed-wrap">` +
    `<button class="clip-close-btn" aria-label="${escHtml(t().closeEmbed)}" type="button">&#x2715;</button>` +
    `<iframe src="${escHtml(src)}" class="clip-iframe" allowfullscreen scrolling="no"></iframe>` +
    `</div>` +
    `<div class="clip-list-nav-row">` +
    `<button class="clip-nav-btn clip-prev-btn" type="button" aria-label="${escHtml(t().prevClip)}"${prevDisabled ? ' disabled' : ''}><span class="clip-nav-title">${escHtml(prevTitle)}</span>${prevArrow}</button>` +
    `<button class="clip-nav-btn clip-next-btn" type="button" aria-label="${escHtml(t().nextClip)}"${nextDisabled ? ' disabled' : ''}>${nextArrow}<span class="clip-nav-title">${escHtml(nextTitle)}</span></button>` +
    `</div>`;
  embedRow.appendChild(td);

  row.insertAdjacentElement('afterend', embedRow);
  _insertedEmbedRow = embedRow;
  row.classList.add('expanded');
  _expandedRow = row;
  if (!skipScroll) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
      if (lastRow) {
        expandRow(lastRow, true);
        // scrollIntoView on the row alone leaves the embed below the fold;
        // scroll the embed row into view instead so both row and player are visible.
        _insertedEmbedRow?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    }
  }
}
