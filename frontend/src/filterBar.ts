// ── Collapsible filter bar ─────────────────────────────────────────────────
//
// The filter bar (#sticky-bar) sits in normal document flow and scrolls away
// with the page, so it costs no vertical space while browsing. Once it has
// scrolled out of view, a small tab (#filter-tab) hangs from the top edge of
// the viewport. Clicking the tab "pins" the bar (position: sticky) so it
// slides back in; the tab then hangs below the bar and collapses it again.
//
// The bar unpins automatically when:
//   - the user clicks anywhere outside it,
//   - its natural position scrolls back into view (nothing left to pin), or
//   - a filter is changed from the pinned bar — we jump to the top of the
//     results so the new result set is seen from the start, which also brings
//     the bar back to its natural position.

import { t } from './lib/i18n';

let _bar: HTMLElement | null = null;
let _tab: HTMLButtonElement | null = null;
let _sentinel: HTMLElement | null = null;

function isPinned(): boolean {
  return _bar?.classList.contains('pinned') ?? false;
}

function setPinned(pinned: boolean): void {
  if (!_bar || !_tab) return;
  _bar.classList.toggle('pinned', pinned);
  _tab.setAttribute('aria-expanded', String(pinned));
  _tab.setAttribute('aria-label', pinned ? t().controlsCollapse : t().controlsExpand);
}

/** Scroll so the bar's natural (un-pinned) position is at the viewport top. */
function revealResults(): void {
  if (!isPinned() || !_bar || !_sentinel) return;
  // The sentinel sits directly after the bar in flow, so its document offset
  // minus the bar height is where the bar would be if it weren't stuck.
  const naturalTop = _sentinel.getBoundingClientRect().top + window.scrollY - _bar.offsetHeight;
  window.scrollTo({ top: Math.max(0, naturalTop), behavior: 'instant' });
}

export function initFilterBar(): void {
  _bar      = document.getElementById('sticky-bar');
  _tab      = document.getElementById('filter-tab') as HTMLButtonElement | null;
  _sentinel = document.getElementById('sticky-bar-sentinel');
  if (!_bar || !_tab || !_sentinel) return;
  const bar = _bar;

  new IntersectionObserver(([entry]) => {
    if (!entry) return;
    // Only "offscreen" when the bar has scrolled *above* the viewport — not
    // when the page is short and the sentinel is below the fold.
    const offscreen = !entry.isIntersecting && entry.boundingClientRect.top < 0;
    bar.classList.toggle('offscreen', offscreen);
    if (!offscreen) setPinned(false);
  }).observe(_sentinel);

  _tab.addEventListener('click', () => setPinned(!isPinned()));

  document.addEventListener('click', e => {
    if (isPinned() && !bar.contains(e.target as Node)) setPinned(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isPinned()) setPinned(false);
  });

  // Any filter change made from the pinned bar: show the results from the top.
  const controls = document.getElementById('controls');
  controls?.addEventListener('change', revealResults);
  controls?.addEventListener('input', revealResults);
  controls?.addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('button')) revealResults();
  });
}

/**
 * Refresh the tab's label: a compact summary of the active filters (search,
 * game, date range) so they stay visible while the bar is scrolled away, or
 * the generic "Filters" label when nothing is filtered.
 * Reads the controls' current DOM values; call after each render.
 */
export function updateFilterTab(): void {
  const label = document.getElementById('filter-tab-label');
  if (!label || !_bar) return;
  const parts: string[] = [];

  const search = (document.getElementById('search') as HTMLInputElement | null)?.value.trim();
  if (search) parts.push(`“${search}”`);

  const game = document.getElementById('game-filter') as HTMLSelectElement | null;
  if (game?.value) {
    // Option text is "Name (1,234)" — drop the count.
    const text = game.selectedOptions[0]?.textContent ?? '';
    parts.push(text.replace(/\s*\([\d,]+\)\s*$/, ''));
  }

  const from = (document.getElementById('date-from-input') as HTMLInputElement | null)?.value;
  const to   = (document.getElementById('date-to-input')   as HTMLInputElement | null)?.value;
  if (from || to) {
    const fmt = (d: string | undefined): string => (d ? d.replace(/-/g, '/') : '');
    parts.push(from === to ? fmt(from) : `${fmt(from)}–${fmt(to)}`);
  }

  label.textContent = parts.length > 0 ? parts.join(' · ') : t().filtersTab;
  _bar.classList.toggle('has-filters', parts.length > 0);
  if (_tab && !isPinned()) _tab.setAttribute('aria-label', t().controlsExpand);
}
