// ── Clip HTML template functions ──────────────────────────────────────────
//
// Pure template functions — no DOM reads, no state module imports.
// Both clipCardHtml and clipListRowHtml receive tzOffset as an explicit
// parameter so they are fully unit-testable without a browser or DB.

import { escHtml, fmtDuration, fmtViews, fmtDateTime, fmtDate, fmtTime } from './format';
import { t, lang } from './i18n';

export type ClipItem = {
  url: string; thumbnail_url: string; title: string; duration: number;
  view_count: number; game_name: string; game_name_ja: string;
  game_id: string; creator_name: string; created_at: string;
  isLive: boolean;
};

// The onerror attribute is intentionally omitted — broken images are handled
// by attachImgErrorHandlers() after setting innerHTML, avoiding inline JS
// which is blocked by the Content-Security-Policy.
export function clipCardHtml(clip: {
  url: string; thumbnail_url: string; title: string; duration: number;
  view_count: number; game_name: string; game_name_ja?: string;
  game_id?: string; creator_name: string; created_at: string;
}, extraClass = '', tzOffset = 0): string {
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
          <span>${t().creatorLine(escHtml(clip.creator_name), fmtDateTime(clip.created_at, lang, tzOffset))}</span>
        </div>
      </div>
    </div>`;
}

export function clipListRowHtml(clip: ClipItem, tzOffset = 0): string {
  const displayGameName = (lang === 'ja' && clip.game_name_ja) ? clip.game_name_ja : clip.game_name;
  const gameEl = displayGameName
    ? `<button class="clip-game-link" type="button" data-game-id="${escHtml(clip.game_id)}">${escHtml(displayGameName)}</button>`
    : '';
  const dateStr = fmtDateTime(clip.created_at, lang, tzOffset);
  // Split into date-only and time-only so the meta cell can wrap between them
  // (never mid-date or mid-time) via white-space: nowrap on each span.
  const datePart = fmtDate(clip.created_at, tzOffset, lang);
  const timePart = fmtTime(clip.created_at, lang, tzOffset);
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
export function attachImgErrorHandlers(container: HTMLElement): void {
  container.querySelectorAll<HTMLImageElement>('.clip-thumb img').forEach(img => {
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
  });
}
