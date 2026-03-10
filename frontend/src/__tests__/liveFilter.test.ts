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
  tzOffset:     0,
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
  // calDateTo is a YYYY-MM-DD local date; the guard converts it to UTC midnight
  // before comparing with the ISO dbCutoffDate.

  it('returns [] when calDateTo (local date) converts to dbCutoffDate in UTC', () => {
    // localDateToUtcBound('2024-06-01', 0) = '2024-06-01T00:00:00.000Z' <= '2024-06-01T00:00:00Z' → guard fires
    const clips = [makeClip()];
    expect(filterLiveClips({
      ...base,
      clips,
      calDateTo: '2024-06-01',
    })).toEqual([]);
  });

  it('returns [] when calDateTo is before dbCutoffDate', () => {
    const clips = [makeClip()];
    expect(filterLiveClips({
      ...base,
      clips,
      calDateTo: '2024-05-01',
    })).toEqual([]);
  });

  it('does not hide clips when calDateTo is after dbCutoffDate', () => {
    const clips = [makeClip()];
    expect(filterLiveClips({
      ...base,
      clips,
      calDateTo: '2024-07-01',
    })).toHaveLength(1);
  });

  it('skips the cutoff guard when dbCutoffDate is null, but upper-bound filter still applies', () => {
    const clips = [makeClip()]; // created_at: '2024-06-15T12:00:00Z'
    // The cutoff guard requires dbCutoffDate, so it does not fire here.
    // However, the upper-bound date filter still excludes clips after calDateTo.
    const result = filterLiveClips({
      ...base,
      clips,
      dbCutoffDate: null,
      calDateTo:    '2020-01-01',
    });
    expect(result).toEqual([]);
  });

  it('skips the cutoff guard when dbCutoffDate is null and clip is within calDateTo', () => {
    const clips = [makeClip()]; // created_at: '2024-06-15T12:00:00Z'
    const result = filterLiveClips({
      ...base,
      clips,
      dbCutoffDate: null,
      calDateTo:    '2024-07-01',
    });
    expect(result).toHaveLength(1);
  });

  it('skips the cutoff guard when calDateTo is null', () => {
    const clips = [makeClip()];
    expect(filterLiveClips({ ...base, clips })).toHaveLength(1);
  });

  // ── DB cutoff deduplication ───────────────────────────────────────────────
  // fetchNewClips() passes started_at=dbCutoffDate (inclusive), so Twitch
  // returns the clip at exactly dbCutoffDate even though it is already in the
  // DB. filterLiveClips must strip it to prevent duplicate cards.

  it('strips a clip whose created_at equals dbCutoffDate (the already-archived newest clip)', () => {
    const atCutoff    = makeClip({ id: 'at',    created_at: '2024-06-01T00:00:00Z' });
    const afterCutoff = makeClip({ id: 'after', created_at: '2024-06-01T00:00:01Z' });
    const result = filterLiveClips({ ...base, clips: [atCutoff, afterCutoff] });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('after');
  });

  it('strips all clips at or before dbCutoffDate', () => {
    const before   = makeClip({ id: 'before', created_at: '2024-05-31T23:59:59Z' });
    const atCutoff = makeClip({ id: 'at',      created_at: '2024-06-01T00:00:00Z' });
    const after    = makeClip({ id: 'after',   created_at: '2024-06-15T12:00:00Z' });
    const result = filterLiveClips({ ...base, clips: [before, atCutoff, after] });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('after');
  });

  it('does not strip any clips when dbCutoffDate is null', () => {
    const clip = makeClip({ created_at: '2024-06-01T00:00:00Z' });
    const result = filterLiveClips({ ...base, dbCutoffDate: null, clips: [clip] });
    expect(result).toHaveLength(1);
  });

  // ── calDateFrom ───────────────────────────────────────────────────────────

  it('excludes clips older than calDateFrom', () => {
    const older  = makeClip({ id: 'old', created_at: '2024-06-05T00:00:00Z' });
    const newer  = makeClip({ id: 'new', created_at: '2024-06-10T00:00:00Z' });
    const result = filterLiveClips({ ...base, clips: [older, newer], calDateFrom: '2024-06-10' });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('new');
  });

  it('includes clips exactly at local midnight of calDateFrom (>= boundary)', () => {
    // localDateToUtcBound('2024-06-10', 0) = '2024-06-10T00:00:00.000Z'
    // '2024-06-10T00:00:00Z' > '2024-06-10T00:00:00.000Z' (Z > . at index 19) → included
    const clip = makeClip({ created_at: '2024-06-10T00:00:00Z' });
    expect(filterLiveClips({ ...base, clips: [clip], calDateFrom: '2024-06-10' })).toHaveLength(1);
  });

  // ── calDateTo upper bound ─────────────────────────────────────────────────

  it('excludes clips at local midnight of calDateTo (exclusive upper bound)', () => {
    const older  = makeClip({ id: 'old', created_at: '2024-06-05T00:00:00Z' });
    const newer  = makeClip({ id: 'new', created_at: '2024-06-20T00:00:00Z' });
    // calDateToUtc = '2024-06-20T00:00:00.000Z'; '2024-06-20T00:00:00Z' > it (Z > .) → excluded
    const result = filterLiveClips({
      ...base,
      clips: [older, newer],
      calDateTo: '2024-06-20',
      dbCutoffDate: null,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('old');
  });

  it('includes clips strictly before calDateTo', () => {
    const clip = makeClip({ created_at: '2024-06-19T23:59:59Z' });
    const result = filterLiveClips({
      ...base,
      clips: [clip],
      calDateTo: '2024-06-20',
      dbCutoffDate: null,
    });
    expect(result).toHaveLength(1);
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

  it('both calDateFrom and calDateTo applied together as a closed range', () => {
    const before  = makeClip({ id: 'before',  created_at: '2024-06-09T23:59:59Z' });
    const inside  = makeClip({ id: 'inside',  created_at: '2024-06-10T00:00:00Z' });
    const inside2 = makeClip({ id: 'inside2', created_at: '2024-06-19T23:59:59Z' });
    const after   = makeClip({ id: 'after',   created_at: '2024-06-20T00:00:00Z' });
    const result = filterLiveClips({
      ...base,
      clips:        [before, inside, inside2, after],
      calDateFrom:  '2024-06-10',
      calDateTo:    '2024-06-20',
      dbCutoffDate: null,
    });
    expect(result.map(c => c.id)).toEqual(['inside', 'inside2']);
  });

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
      calDateFrom: '2024-06-10',
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
      calDateTo:   '2024-05-15', // before dbCutoffDate
      gameFilter:  'game1',
      searchQuery: 'pog',
    });
    expect(result).toEqual([]);
  });

  // ── Cutoff guard: YYYY-MM-DD calDateTo vs full ISO dbCutoffDate ───────────
  // _dbCutoffDate is a full ISO UTC timestamp (MAX(created_at) from DB).
  // calDateTo is a YYYY-MM-DD local date; the guard converts it to UTC before
  // comparing, so comparison is always between two UTC ISO strings.

  it('cutoff guard fires when calDateTo converts to a UTC bound <= dbCutoffDate', () => {
    // localDateToUtcBound('2024-06-01', 0) = '2024-06-01T00:00:00.000Z' <= '2024-06-01T15:30:00Z' → fires
    const clips = [makeClip()];
    expect(filterLiveClips({
      ...base,
      clips,
      dbCutoffDate: '2024-06-01T15:30:00Z',
      calDateTo:    '2024-06-01',
    })).toEqual([]);
  });

  it('cutoff guard does not fire when date-only calDateTo is the day after ISO dbCutoffDate', () => {
    // localDateToUtcBound('2024-06-02', 0) = '2024-06-02T00:00:00.000Z' > '2024-06-01T15:30:00Z' → no fire
    // Use a clip created between dbCutoffDate and calDateTo so it passes both guards.
    const clips = [makeClip({ created_at: '2024-06-01T20:00:00Z' })];
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

  // ── Timezone offset ───────────────────────────────────────────────────────

  it('non-zero tzOffset shifts the UTC cutoff correctly (UTC-5)', () => {
    // UTC-5 (-300 min): local Jun 2 midnight = 2024-06-02T05:00:00Z in UTC
    // dbCutoffDate = '2024-06-02T03:00:00Z'
    // calDateTo = '2024-06-02' local → calDateToUtc = '2024-06-02T05:00:00.000Z'
    // '2024-06-02T05:00:00.000Z' > '2024-06-02T03:00:00Z' → calDateTo guard does NOT fire
    // clip at '2024-06-02T04:00:00Z' (Jun 1 11pm UTC-5): > dbCutoffDate (passes dedup)
    //   and < calDateToUtc (passes upper bound) → included
    const clip = makeClip({ created_at: '2024-06-02T04:00:00Z' });
    const result = filterLiveClips({
      ...base,
      clips:        [clip],
      dbCutoffDate: '2024-06-02T03:00:00Z',
      calDateTo:    '2024-06-02',
      tzOffset:     -300,
    });
    expect(result).toHaveLength(1);
  });
});
