import { describe, it, expect } from 'vitest';
import { extractClipSlug } from '../embed';

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
