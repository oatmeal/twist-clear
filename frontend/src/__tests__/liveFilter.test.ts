import { describe, it, expect } from 'vitest';
import { filterLiveClips } from '../lib/liveFilter';
import type { LiveClip } from '../twitch';

function makeClip(overrides: Partial<LiveClip> = {}): LiveClip {
  return {
    id:            'clip1',
    title:         'Test Clip',
    creator_name:  'streamer',
    view_count:    100,
    created_at:    '2024-06-15T12:00:00Z',
    duration:      30,
    thumbnail_url: 'https://example.com/thumb.jpg',
    url:           'https://clips.twitch.tv/clip1',
    game_id:       'game1',
    game_name:     'Game 1',
    ...overrides,
  };
}

const base = {
  clips:        [] as LiveClip[],
  dbCutoffDate: '2024-06-01T00:00:00Z',
  calDateTo:    null,
  calDateFrom:  null,
  gameFilter:   '',
  searchQuery:  '',
};

describe('filterLiveClips', () => {
  // ── Basic cases ───────────────────────────────────────────────────────────

  it('returns empty array when clips is empty', () => {
    expect(filterLiveClips(base)).toEqual([]);
  });

  it('returns all clips when no filters are set', () => {
    const clips = [makeClip(), makeClip({ id: 'clip2', title: 'Another Clip' })];
    expect(filterLiveClips({ ...base, clips })).toHaveLength(2);
  });

  // ── DB cutoff guard ───────────────────────────────────────────────────────

  it('returns [] when calDateTo equals dbCutoffDate', () => {
    const clips = [makeClip()];
    expect(filterLiveClips({
      ...base,
      clips,
      calDateTo: '2024-06-01T00:00:00Z', // equal → still in archived range
    })).toEqual([]);
  });

  it('returns [] when calDateTo is before dbCutoffDate', () => {
    const clips = [makeClip()];
    expect(filterLiveClips({
      ...base,
      clips,
      calDateTo: '2024-05-01T00:00:00Z',
    })).toEqual([]);
  });

  it('does not hide clips when calDateTo is after dbCutoffDate', () => {
    const clips = [makeClip()];
    expect(filterLiveClips({
      ...base,
      clips,
      calDateTo: '2024-07-01T00:00:00Z',
    })).toHaveLength(1);
  });

  it('skips the cutoff guard when dbCutoffDate is null', () => {
    const clips = [makeClip()];
    // Even with a very old calDateTo, no guard fires when dbCutoffDate is null.
    const result = filterLiveClips({
      ...base,
      clips,
      dbCutoffDate: null,
      calDateTo:    '2020-01-01T00:00:00Z',
    });
    // calDateFrom is null so no further filtering; clip passes through.
    expect(result).toHaveLength(1);
  });

  it('skips the cutoff guard when calDateTo is null', () => {
    const clips = [makeClip()];
    expect(filterLiveClips({ ...base, clips })).toHaveLength(1);
  });

  // ── calDateFrom ───────────────────────────────────────────────────────────

  it('excludes clips older than calDateFrom', () => {
    const older  = makeClip({ id: 'old', created_at: '2024-06-05T00:00:00Z' });
    const newer  = makeClip({ id: 'new', created_at: '2024-06-10T00:00:00Z' });
    const result = filterLiveClips({ ...base, clips: [older, newer], calDateFrom: '2024-06-10T00:00:00Z' });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('new');
  });

  it('includes clips exactly at calDateFrom (>= boundary)', () => {
    const clip = makeClip({ created_at: '2024-06-10T00:00:00Z' });
    expect(filterLiveClips({ ...base, clips: [clip], calDateFrom: '2024-06-10T00:00:00Z' })).toHaveLength(1);
  });

  // ── gameFilter ────────────────────────────────────────────────────────────

  it('keeps only clips with matching game_id', () => {
    const g1 = makeClip({ id: 'a', game_id: 'game1' });
    const g2 = makeClip({ id: 'b', game_id: 'game2' });
    const result = filterLiveClips({ ...base, clips: [g1, g2], gameFilter: 'game2' });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('b');
  });

  it('returns [] when no clips match the game filter', () => {
    const clips = [makeClip({ game_id: 'game1' })];
    expect(filterLiveClips({ ...base, clips, gameFilter: 'game99' })).toEqual([]);
  });

  // ── searchQuery ───────────────────────────────────────────────────────────

  it('filters by search query (case-insensitive, substring)', () => {
    const a = makeClip({ id: 'a', title: 'Cool Pog Clip' });
    const b = makeClip({ id: 'b', title: 'Nothing Interesting' });
    const result = filterLiveClips({ ...base, clips: [a, b], searchQuery: 'pog' });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('a');
  });

  it('search is case-insensitive (uppercase query)', () => {
    const clip = makeClip({ title: 'pogchamp moment' });
    expect(filterLiveClips({ ...base, clips: [clip], searchQuery: 'POG' })).toHaveLength(1);
  });

  it('returns [] when no clips match the search query', () => {
    const clips = [makeClip({ title: 'Some Clip' })];
    expect(filterLiveClips({ ...base, clips, searchQuery: 'zzznomatch' })).toEqual([]);
  });

  // ── Combined filters ──────────────────────────────────────────────────────

  it('applies all filters together', () => {
    const match     = makeClip({ id: 'match',     title: 'Great Pog Clip', game_id: 'game1', created_at: '2024-06-15T00:00:00Z' });
    const wrongGame = makeClip({ id: 'wronggame', title: 'Great Pog Clip', game_id: 'game2', created_at: '2024-06-15T00:00:00Z' });
    const wrongTitle= makeClip({ id: 'wrongtitle',title: 'Boring Clip',    game_id: 'game1', created_at: '2024-06-15T00:00:00Z' });
    const tooOld    = makeClip({ id: 'tooold',    title: 'Great Pog Clip', game_id: 'game1', created_at: '2024-06-05T00:00:00Z' });

    const result = filterLiveClips({
      ...base,
      clips:       [match, wrongGame, wrongTitle, tooOld],
      gameFilter:  'game1',
      searchQuery: 'pog',
      calDateFrom: '2024-06-10T00:00:00Z',
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('match');
  });

  it('cutoff guard fires before other filters when range is in archive', () => {
    // Even if clips would pass game/search/date filters, cutoff guard returns []
    const clip = makeClip({ game_id: 'game1', title: 'Pog' });
    const result = filterLiveClips({
      ...base,
      clips:       [clip],
      calDateTo:   '2024-05-15T00:00:00Z', // before dbCutoffDate
      gameFilter:  'game1',
      searchQuery: 'pog',
    });
    expect(result).toEqual([]);
  });

  // ── Real-world mixed date formats ─────────────────────────────────────────
  // _dbCutoffDate always comes from MAX(created_at) — a full ISO timestamp.
  // calDateTo comes from the calendar — a date-only YYYY-MM-DD string.
  // The cutoff guard uses string comparison, so the formats must be compatible.

  it('cutoff guard fires when date-only calDateTo matches date portion of ISO dbCutoffDate', () => {
    // '2024-06-01' < '2024-06-01T15:30:00Z' lexicographically (prefix rule),
    // so <= holds and the guard correctly hides live clips.
    const clips = [makeClip()];
    expect(filterLiveClips({
      ...base,
      clips,
      dbCutoffDate: '2024-06-01T15:30:00Z',
      calDateTo:    '2024-06-01',
    })).toEqual([]);
  });

  it('cutoff guard does not fire when date-only calDateTo is the day after ISO dbCutoffDate', () => {
    // '2024-06-02' > '2024-06-01T15:30:00Z' (day digit differs), guard does not fire.
    const clips = [makeClip()];
    expect(filterLiveClips({
      ...base,
      clips,
      dbCutoffDate: '2024-06-01T15:30:00Z',
      calDateTo:    '2024-06-02',
    })).toHaveLength(1);
  });

  it('cutoff guard does not fire when date-only calDateTo is a month after ISO dbCutoffDate', () => {
    const clips = [makeClip()];
    expect(filterLiveClips({
      ...base,
      clips,
      dbCutoffDate: '2024-06-01T15:30:00Z',
      calDateTo:    '2024-07-01',
    })).toHaveLength(1);
  });
});
