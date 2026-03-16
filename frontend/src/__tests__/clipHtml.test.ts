import { describe, it, expect, beforeEach } from 'vitest';
import { setLang } from '../lib/i18n';
import { clipCardHtml, clipListRowHtml } from '../lib/clipHtml';
import type { ClipItem } from '../lib/clipHtml';

function baseClip(overrides: Partial<ClipItem> = {}): ClipItem {
  return {
    url: 'https://www.twitch.tv/streamer/clip/SomeSlug',
    thumbnail_url: 'https://example.com/thumb.jpg',
    title: 'My Test Clip',
    duration: 90,
    view_count: 1234,
    game_name: 'Minecraft',
    game_name_ja: 'マインクラフト',
    game_id: 'game42',
    creator_name: 'SomeStreamer',
    created_at: '2024-03-15T12:00:00Z',
    isLive: false,
    ...overrides,
  };
}

beforeEach(() => {
  setLang('en');
});

describe('clipCardHtml', () => {
  it('contains the clip title', () => {
    const html = clipCardHtml(baseClip());
    expect(html).toContain('My Test Clip');
  });

  it('contains the clip URL', () => {
    const html = clipCardHtml(baseClip());
    expect(html).toContain('https://www.twitch.tv/streamer/clip/SomeSlug');
  });

  it('contains the creator name', () => {
    const html = clipCardHtml(baseClip());
    expect(html).toContain('SomeStreamer');
  });

  it('contains the English game name when lang=en', () => {
    setLang('en');
    const html = clipCardHtml(baseClip());
    expect(html).toContain('Minecraft');
    expect(html).not.toContain('マインクラフト');
  });

  it('contains the Japanese game name when lang=ja', () => {
    setLang('ja');
    const html = clipCardHtml(baseClip());
    expect(html).toContain('マインクラフト');
    expect(html).not.toContain('>Minecraft<');
  });

  it('falls back to English name when lang=ja but game_name_ja is empty', () => {
    setLang('ja');
    const html = clipCardHtml(baseClip({ game_name_ja: '' }));
    expect(html).toContain('Minecraft');
  });

  it('adds extraClass to the card element', () => {
    const html = clipCardHtml(baseClip(), ' live-clip');
    expect(html).toContain('clip-card live-clip');
  });

  it('escapes XSS in title', () => {
    const html = clipCardHtml(baseClip({ title: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes XSS in URL', () => {
    const html = clipCardHtml(baseClip({ url: '"onmouseover="evil()"' }));
    expect(html).not.toContain('"onmouseover=');
    expect(html).toContain('&quot;');
  });

  it('escapes XSS in creator_name', () => {
    const html = clipCardHtml(baseClip({ creator_name: '<b>Bad</b>' }));
    expect(html).not.toContain('<b>Bad</b>');
    expect(html).toContain('&lt;b&gt;Bad&lt;/b&gt;');
  });

  it('includes a duration span', () => {
    const html = clipCardHtml(baseClip({ duration: 90 }));
    expect(html).toContain('1:30');
  });

  it('shows no game button when game_name is empty', () => {
    const html = clipCardHtml(baseClip({ game_name: '', game_name_ja: '' }));
    expect(html).not.toContain('clip-game-link');
  });
});

describe('clipListRowHtml', () => {
  it('contains the clip title', () => {
    const html = clipListRowHtml(baseClip());
    expect(html).toContain('My Test Clip');
  });

  it('contains the clip URL', () => {
    const html = clipListRowHtml(baseClip());
    expect(html).toContain('https://www.twitch.tv/streamer/clip/SomeSlug');
  });

  it('contains the creator name', () => {
    const html = clipListRowHtml(baseClip());
    expect(html).toContain('SomeStreamer');
  });

  it('adds live-clip class for live clips', () => {
    const html = clipListRowHtml(baseClip({ isLive: true }));
    expect(html).toContain('clip-row live-clip');
  });

  it('does not add live-clip class for non-live clips', () => {
    const html = clipListRowHtml(baseClip({ isLive: false }));
    expect(html).toContain('clip-row"');
    expect(html).not.toContain('live-clip');
  });

  it('uses English game name when lang=en', () => {
    setLang('en');
    const html = clipListRowHtml(baseClip());
    expect(html).toContain('Minecraft');
    expect(html).not.toContain('マインクラフト');
  });

  it('uses Japanese game name when lang=ja', () => {
    setLang('ja');
    const html = clipListRowHtml(baseClip());
    expect(html).toContain('マインクラフト');
  });

  it('escapes XSS in title', () => {
    const html = clipListRowHtml(baseClip({ title: '<img src=x onerror=evil()>' }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('escapes XSS in creator_name', () => {
    const html = clipListRowHtml(baseClip({ creator_name: '"><script>evil()</script>' }));
    expect(html).not.toContain('<script>');
  });

  it('includes the view count', () => {
    const html = clipListRowHtml(baseClip({ view_count: 2500 }));
    expect(html).toContain('2.5K');
  });
});
