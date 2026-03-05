import { describe, test, expect } from 'vitest';
import { rankLiveClips, computeViewCountPage, interleavePage } from '../lib/liveRank';
import type { LiveClip } from '../twitch';
import type { Row } from '../db';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClip(view_count: number, created_at: string, id?: string): LiveClip {
  return {
    id:            id ?? `${view_count}-${created_at}`,
    title:         'Test Clip',
    creator_name:  'streamer',
    view_count,
    created_at,
    duration:      30,
    thumbnail_url: '',
    url:           'https://clips.twitch.tv/test',
    game_id:       '',
    game_name:     '',
  };
}

/** Mock queryFn: returns the count pre-set for each (view_count, created_at) pair. */
function makeQueryFn(ranks: Record<string, number>) {
  return async (_sql: string, params: Record<string, string | number | null>) => {
    const key = `${params[':_vc']}:${params[':_ca']}`;
    return [{ cnt: ranks[key] ?? 0 }] as Row[];
  };
}

function makeDbRow(view_count: number, created_at: string): Row {
  return { view_count, created_at, id: `db-${view_count}-${created_at}`, title: '', url: '', thumbnail_url: '', duration: 0, creator_name: '', game_name: '' };
}

// ── rankLiveClips ─────────────────────────────────────────────────────────────

describe('rankLiveClips', () => {
  test('returns empty array when given no clips', async () => {
    const result = await rankLiveClips([], 'view_count_desc', '', {}, async () => []);
    expect(result).toEqual([]);
  });

  test('single clip, no DB clips before it (rank 0)', async () => {
    const clip = makeClip(100, '2024-01-01');
    const result = await rankLiveClips([clip], 'view_count_desc', '', {}, makeQueryFn({ '100:2024-01-01': 0 }));
    expect(result).toHaveLength(1);
    expect(result[0]!.dbRank).toBe(0);
    expect(result[0]!.mergedPos).toBe(0);
  });

  test('single clip with 5 DB clips before it', async () => {
    const clip = makeClip(10, '2024-01-01');
    const result = await rankLiveClips([clip], 'view_count_desc', '', {}, makeQueryFn({ '10:2024-01-01': 5 }));
    expect(result[0]!.dbRank).toBe(5);
    expect(result[0]!.mergedPos).toBe(5); // dbRank + index(0)
  });

  test('desc: clips sorted by view_count descending, tiebreak created_at descending', async () => {
    const clipA = makeClip(3, '2024-01-01'); // lower views
    const clipB = makeClip(10, '2024-01-01'); // higher views — should come first
    const result = await rankLiveClips(
      [clipA, clipB], 'view_count_desc', '', {},
      makeQueryFn({ '10:2024-01-01': 2, '3:2024-01-01': 7 }),
    );
    expect(result[0]!.clip.view_count).toBe(10);
    expect(result[1]!.clip.view_count).toBe(3);
  });

  test('desc: among equal view counts, newer created_at ranks first', async () => {
    const older = makeClip(5, '2024-01-01');
    const newer = makeClip(5, '2024-01-03');
    const result = await rankLiveClips(
      [older, newer], 'view_count_desc', '', {},
      makeQueryFn({ '5:2024-01-03': 4, '5:2024-01-01': 6 }),
    );
    expect(result[0]!.clip.created_at).toBe('2024-01-03'); // newer first
    expect(result[1]!.clip.created_at).toBe('2024-01-01');
  });

  test('asc: clips sorted by view_count ascending, tiebreak created_at ascending', async () => {
    const clipA = makeClip(10, '2024-01-01'); // higher views
    const clipB = makeClip(3, '2024-01-01');  // lower views — should come first
    const result = await rankLiveClips(
      [clipA, clipB], 'view_count_asc', '', {},
      makeQueryFn({ '3:2024-01-01': 0, '10:2024-01-01': 5 }),
    );
    expect(result[0]!.clip.view_count).toBe(3);
    expect(result[1]!.clip.view_count).toBe(10);
  });

  test('asc: among equal view counts, older created_at ranks first', async () => {
    const newer = makeClip(5, '2024-01-03');
    const older = makeClip(5, '2024-01-01');
    const result = await rankLiveClips(
      [newer, older], 'view_count_asc', '', {},
      makeQueryFn({ '5:2024-01-01': 2, '5:2024-01-03': 4 }),
    );
    expect(result[0]!.clip.created_at).toBe('2024-01-01'); // older first
    expect(result[1]!.clip.created_at).toBe('2024-01-03');
  });

  test('mergedPos = dbRank + sorted index', async () => {
    // Three clips sorted desc: views 20, 10, 5
    // DB ranks: 1, 3, 8 (1,3,8 DB clips precede each)
    const clips = [makeClip(5, '2024-01-01'), makeClip(20, '2024-01-01'), makeClip(10, '2024-01-01')];
    const result = await rankLiveClips(
      clips, 'view_count_desc', '', {},
      makeQueryFn({ '20:2024-01-01': 1, '10:2024-01-01': 3, '5:2024-01-01': 8 }),
    );
    // sorted order: 20, 10, 5 (indices 0, 1, 2)
    expect(result[0]!.mergedPos).toBe(1 + 0); // dbRank=1, index=0
    expect(result[1]!.mergedPos).toBe(3 + 1); // dbRank=3, index=1
    expect(result[2]!.mergedPos).toBe(8 + 2); // dbRank=8, index=2
  });

  test('deduplicates queries for clips with identical (view_count, created_at)', async () => {
    const clip1 = makeClip(5, '2024-01-01', 'a');
    const clip2 = makeClip(5, '2024-01-01', 'b'); // identical sort key
    let callCount = 0;
    const queryFn = async () => { callCount++; return [{ cnt: 10 }] as Row[]; };

    const result = await rankLiveClips([clip1, clip2], 'view_count_desc', '', {}, queryFn);
    expect(callCount).toBe(1); // one query despite two clips
    // Both share dbRank=10; sequential merged positions
    expect(result[0]!.dbRank).toBe(10);
    expect(result[1]!.dbRank).toBe(10);
    expect(result[0]!.mergedPos).toBe(10); // 10 + 0
    expect(result[1]!.mergedPos).toBe(11); // 10 + 1
  });

  test('deduplication across three clips: two share a key, one is unique', async () => {
    const clip1 = makeClip(5, '2024-01-01', 'a');
    const clip2 = makeClip(5, '2024-01-01', 'b');
    const clip3 = makeClip(3, '2024-01-01', 'c');
    let callCount = 0;
    const queryFn = async (_: string, p: Record<string, string | number | null>) => {
      callCount++;
      return [{ cnt: p[':_vc'] === 5 ? 10 : 15 }] as Row[];
    };

    const result = await rankLiveClips([clip1, clip2, clip3], 'view_count_desc', '', {}, queryFn);
    expect(callCount).toBe(2); // one for (5, '2024-01-01'), one for (3, '2024-01-01')
    // sorted: 5, 5, 3
    expect(result[0]!.mergedPos).toBe(10); // 10 + 0
    expect(result[1]!.mergedPos).toBe(11); // 10 + 1
    expect(result[2]!.mergedPos).toBe(17); // 15 + 2
  });

  test('passes WHERE clause filters to rank queries', async () => {
    const clip = makeClip(5, '2024-01-01');
    let capturedSql = '';
    let capturedParams: Record<string, string | number | null> = {};
    const queryFn = async (sql: string, p: Record<string, string | number | null>) => {
      capturedSql = sql;
      capturedParams = p;
      return [{ cnt: 3 }] as Row[];
    };

    await rankLiveClips(
      [clip], 'view_count_desc',
      'WHERE c.game_id = :game', { ':game': 'g123' },
      queryFn,
    );

    expect(capturedSql).toContain('WHERE c.game_id = :game AND');
    expect(capturedParams[':game']).toBe('g123');
    expect(capturedParams[':_vc']).toBe(5);
    expect(capturedParams[':_ca']).toBe('2024-01-01');
  });

  test('WHERE clause is empty string when no filters', async () => {
    const clip = makeClip(5, '2024-01-01');
    let capturedSql = '';
    const queryFn = async (sql: string) => { capturedSql = sql; return [{ cnt: 0 }] as Row[]; };

    await rankLiveClips([clip], 'view_count_desc', '', {}, queryFn);

    // Should start with WHERE (not 'AND' or empty prefix)
    expect(capturedSql).toMatch(/FROM clips c WHERE \(/);
  });

  test('desc: COUNT query uses view_count > and created_at > for precedence', async () => {
    const clip = makeClip(5, '2024-01-01');
    let capturedSql = '';
    const queryFn = async (sql: string) => { capturedSql = sql; return [{ cnt: 0 }] as Row[]; };

    await rankLiveClips([clip], 'view_count_desc', '', {}, queryFn);

    expect(capturedSql).toContain('c.view_count > :_vc');
    expect(capturedSql).toContain('c.created_at > :_ca');
  });

  test('asc: COUNT query uses view_count < and created_at < for precedence', async () => {
    const clip = makeClip(5, '2024-01-01');
    let capturedSql = '';
    const queryFn = async (sql: string) => { capturedSql = sql; return [{ cnt: 0 }] as Row[]; };

    await rankLiveClips([clip], 'view_count_asc', '', {}, queryFn);

    expect(capturedSql).toContain('c.view_count < :_vc');
    expect(capturedSql).toContain('c.created_at < :_ca');
  });

  test('all live clips rank before all DB clips (asc, all have fewest views)', async () => {
    const clips = [makeClip(1, '2024-01-01'), makeClip(1, '2024-01-02')];
    // Both have 0 DB clips before them
    const result = await rankLiveClips(
      clips, 'view_count_asc', '', {},
      makeQueryFn({ '1:2024-01-01': 0, '1:2024-01-02': 0 }),
    );
    // asc tiebreak: older created_at first → '2024-01-01' at index 0, '2024-01-02' at index 1
    expect(result[0]!.clip.created_at).toBe('2024-01-01');
    expect(result[0]!.mergedPos).toBe(0); // 0 + 0
    expect(result[1]!.clip.created_at).toBe('2024-01-02');
    expect(result[1]!.mergedPos).toBe(1); // 0 + 1
  });

  test('all live clips rank after all DB clips (desc, all have fewest views)', async () => {
    // 100 DB clips total, both live clips come last
    const clips = [makeClip(1, '2024-01-01'), makeClip(1, '2024-01-02')];
    const result = await rankLiveClips(
      clips, 'view_count_desc', '', {},
      makeQueryFn({ '1:2024-01-02': 98, '1:2024-01-01': 99 }),
    );
    // desc tiebreak: newer first → '2024-01-02' at index 0, '2024-01-01' at index 1
    expect(result[0]!.clip.created_at).toBe('2024-01-02');
    expect(result[0]!.mergedPos).toBe(98); // 98 + 0
    expect(result[1]!.clip.created_at).toBe('2024-01-01');
    expect(result[1]!.mergedPos).toBe(100); // 99 + 1
  });
});

// ── computeViewCountPage ─────────────────────────────────────────────────────

describe('computeViewCountPage', () => {
  function makeRanked(mergedPos: number): import('../lib/liveRank').RankedLiveClip {
    return { clip: makeClip(1, '2024-01-01'), dbRank: mergedPos, mergedPos };
  }

  test('no live clips — all slots go to DB', () => {
    const page = computeViewCountPage([], 0, 5);
    expect(page.liveOnPage).toHaveLength(0);
    expect(page.dbOnPage).toBe(5);
    expect(page.dbOffset).toBe(0);
  });

  test('all live clips appear on page 1', () => {
    // 2 live clips at positions 1 and 3, page 0..4
    const ranked = [makeRanked(1), makeRanked(3)];
    const page = computeViewCountPage(ranked, 0, 5);
    expect(page.liveOnPage).toHaveLength(2);
    expect(page.dbOnPage).toBe(3);
    expect(page.dbOffset).toBe(0); // 0 live clips before pageStart=0
  });

  test('all live clips appear before this page — DB offset adjusted', () => {
    // Live clips at positions 0 and 1; fetching page 2 (positions 2..6)
    const ranked = [makeRanked(0), makeRanked(1)];
    const page = computeViewCountPage(ranked, 2, 5);
    expect(page.liveOnPage).toHaveLength(0);
    expect(page.dbOnPage).toBe(5);
    expect(page.dbOffset).toBe(0); // pageStart(2) - livesBefore(2) = 0
  });

  test('all live clips appear after this page — DB offset unaffected', () => {
    // Live clips at positions 10 and 11; fetching page 0..4
    const ranked = [makeRanked(10), makeRanked(11)];
    const page = computeViewCountPage(ranked, 0, 5);
    expect(page.liveOnPage).toHaveLength(0);
    expect(page.dbOnPage).toBe(5);
    expect(page.dbOffset).toBe(0);
  });

  test('live clip exactly at page boundary (first slot)', () => {
    // Live clip at position 5; page starts at 5
    const page = computeViewCountPage([makeRanked(5)], 5, 5);
    expect(page.liveOnPage).toHaveLength(1);
    expect(page.liveOnPage[0]!.mergedPos).toBe(5);
    expect(page.dbOnPage).toBe(4);
    expect(page.dbOffset).toBe(5); // 5 - 0 livesBefore
  });

  test('live clip exactly at last slot of page', () => {
    // Live clip at position 9; page is 5..9 (size 5)
    const page = computeViewCountPage([makeRanked(9)], 5, 5);
    expect(page.liveOnPage).toHaveLength(1);
    expect(page.liveOnPage[0]!.mergedPos).toBe(9);
    expect(page.dbOnPage).toBe(4);
    expect(page.dbOffset).toBe(5);
  });

  test('live clip at position just past page end — not included', () => {
    // Live clip at position 10; page is 5..9
    const page = computeViewCountPage([makeRanked(10)], 5, 5);
    expect(page.liveOnPage).toHaveLength(0);
    expect(page.dbOnPage).toBe(5);
  });

  test('mixed: some live clips before page, some on page, some after', () => {
    // Live clips at: 1 (before), 7 (on page 5..9), 12 (after)
    const ranked = [makeRanked(1), makeRanked(7), makeRanked(12)];
    const page = computeViewCountPage(ranked, 5, 5);
    expect(page.liveOnPage).toHaveLength(1);
    expect(page.liveOnPage[0]!.mergedPos).toBe(7);
    expect(page.dbOnPage).toBe(4);
    expect(page.dbOffset).toBe(4); // pageStart(5) - livesBefore(1) = 4
  });

  test('multiple live clips on same page and before it', () => {
    // 3 live clips before (pos 0,1,2); 2 on page (pos 7,9); page 5..9
    const before = [makeRanked(0), makeRanked(1), makeRanked(2)];
    const onPage = [makeRanked(7), makeRanked(9)];
    const page = computeViewCountPage([...before, ...onPage], 5, 5);
    expect(page.liveOnPage).toHaveLength(2);
    expect(page.dbOnPage).toBe(3);
    expect(page.dbOffset).toBe(2); // pageStart(5) - livesBefore(3) = 2
  });

  test('entire page is live clips', () => {
    // Page size 3, live clips at positions 0,1,2
    const ranked = [makeRanked(0), makeRanked(1), makeRanked(2)];
    const page = computeViewCountPage(ranked, 0, 3);
    expect(page.liveOnPage).toHaveLength(3);
    expect(page.dbOnPage).toBe(0);
    expect(page.dbOffset).toBe(0);
  });
});

// ── interleavePage ────────────────────────────────────────────────────────────

describe('interleavePage', () => {
  function makeRankedAt(mergedPos: number, view_count = 1): import('../lib/liveRank').RankedLiveClip {
    return {
      clip: makeClip(view_count, `2024-01-0${mergedPos + 1}`),
      dbRank: mergedPos,
      mergedPos,
    };
  }

  test('no live clips — returns all DB rows', () => {
    const db = [makeDbRow(10, 'a'), makeDbRow(5, 'b'), makeDbRow(3, 'c')];
    const result = interleavePage(db, [], 0, 5);
    expect(result).toHaveLength(3);
    expect(result.every(r => r.kind === 'db')).toBe(true);
  });

  test('no DB clips — returns all live clips', () => {
    const live = [makeRankedAt(0), makeRankedAt(1), makeRankedAt(2)];
    const result = interleavePage([], live, 0, 3);
    expect(result).toHaveLength(3);
    expect(result.every(r => r.kind === 'live')).toBe(true);
  });

  test('live clip at start, DB clips follow', () => {
    const db = [makeDbRow(5, 'a'), makeDbRow(3, 'b')];
    const live = [makeRankedAt(0)]; // relPos = 0 - 0 = 0
    const result = interleavePage(db, live, 0, 3);
    expect(result[0]!.kind).toBe('live');
    expect(result[1]!.kind).toBe('db');
    expect(result[2]!.kind).toBe('db');
  });

  test('DB clips at start, live clip at end', () => {
    const db = [makeDbRow(10, 'a'), makeDbRow(8, 'b')];
    const live = [makeRankedAt(2)]; // relPos = 2 - 0 = 2
    const result = interleavePage(db, live, 0, 3);
    expect(result[0]!.kind).toBe('db');
    expect(result[1]!.kind).toBe('db');
    expect(result[2]!.kind).toBe('live');
  });

  test('live clip in the middle', () => {
    const db = [makeDbRow(10, 'a'), makeDbRow(3, 'b')];
    const live = [makeRankedAt(1)]; // relPos = 1
    const result = interleavePage(db, live, 0, 3);
    expect(result[0]!.kind).toBe('db');
    expect(result[1]!.kind).toBe('live');
    expect(result[2]!.kind).toBe('db');
  });

  test('non-zero pageStart: relPos computed correctly', () => {
    // pageStart = 5; live clip at mergedPos = 7 → relPos = 2
    const db = [makeDbRow(10, 'a'), makeDbRow(8, 'b'), makeDbRow(4, 'c')];
    const live = [{ ...makeRankedAt(7), mergedPos: 7 }];
    const result = interleavePage(db, live, 5, 5);
    expect(result[0]!.kind).toBe('db');
    expect(result[1]!.kind).toBe('db');
    expect(result[2]!.kind).toBe('live');
    expect(result[3]!.kind).toBe('db');
  });

  test('multiple live clips interspersed', () => {
    // relPos: live@0, db, live@2, db, live@4
    const db = [makeDbRow(8, 'a'), makeDbRow(4, 'b')];
    const live = [makeRankedAt(0), makeRankedAt(2), makeRankedAt(4)];
    const result = interleavePage(db, live, 0, 5);
    expect(result.map(r => r.kind)).toEqual(['live', 'db', 'live', 'db', 'live']);
  });

  test('last page: fewer items than pageSize stops early', () => {
    const db = [makeDbRow(3, 'a')];
    const live = [makeRankedAt(0)];
    const result = interleavePage(db, live, 0, 5); // pageSize=5 but only 2 items
    expect(result).toHaveLength(2);
  });

  test('live clip identity is preserved', () => {
    const clip = makeClip(42, '2024-06-15', 'clip-xyz');
    const ranked = [{ clip, dbRank: 0, mergedPos: 1 }];
    const db = [makeDbRow(50, 'a')];
    const result = interleavePage(db, ranked, 0, 3);
    expect(result[0]!.kind).toBe('db');
    const liveItem = result[1]!;
    expect(liveItem.kind).toBe('live');
    if (liveItem.kind === 'live') {
      expect(liveItem.clip.id).toBe('clip-xyz');
      expect(liveItem.clip.view_count).toBe(42);
    }
  });

  test('db row identity is preserved', () => {
    const row = makeDbRow(99, '2024-12-01');
    const result = interleavePage([row], [], 0, 5);
    const item = result[0]!;
    expect(item.kind).toBe('db');
    if (item.kind === 'db') {
      expect(item.row['view_count']).toBe(99);
    }
  });
});
