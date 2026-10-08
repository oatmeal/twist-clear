import { describe, it, expect } from 'vitest';
import { extractClipSlug, panelSlot } from '../embed';

describe('extractClipSlug', () => {
  it('extracts slug from twitch.tv clip URL', () => {
    expect(extractClipSlug('https://www.twitch.tv/streamer/clip/MyClugSlug123'))
      .toBe('MyClugSlug123');
  });

  it('extracts slug from clips.twitch.tv URL', () => {
    expect(extractClipSlug('https://clips.twitch.tv/FunnySlugHere'))
      .toBe('FunnySlugHere');
  });

  it('extracts slug from clips.twitch.tv URL with trailing slash', () => {
    expect(extractClipSlug('https://clips.twitch.tv/SomeClip/'))
      .toBe('SomeClip');
  });

  it('returns null when no slug follows /clip/', () => {
    expect(extractClipSlug('https://www.twitch.tv/streamer/clip/')).toBeNull();
  });

  it('returns null for a generic twitch.tv URL without /clip/', () => {
    expect(extractClipSlug('https://www.twitch.tv/streamer')).toBeNull();
  });

  it('returns null for an invalid URL', () => {
    expect(extractClipSlug('not-a-url')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractClipSlug('')).toBeNull();
  });
});

describe('panelSlot', () => {
  it('places the panel after the row of a card at the start of a row', () => {
    expect(panelSlot(0, 4, 20)).toEqual({ gridRow: 2, after: 3 });
  });

  it('places the panel after the row of a card at the end of a row', () => {
    expect(panelSlot(3, 4, 20)).toEqual({ gridRow: 2, after: 3 });
  });

  it('places the panel after a later row', () => {
    expect(panelSlot(5, 4, 20)).toEqual({ gridRow: 3, after: 7 });
  });

  it('follows the last card when the final row is not full', () => {
    expect(panelSlot(9, 4, 10)).toEqual({ gridRow: 4, after: 9 });
  });

  it('follows the card itself in a one-column grid', () => {
    expect(panelSlot(5, 1, 10)).toEqual({ gridRow: 7, after: 5 });
  });

  it('follows the last card when there are fewer cards than columns', () => {
    expect(panelSlot(1, 4, 3)).toEqual({ gridRow: 2, after: 2 });
  });
});
