import { describe, it, expect } from 'vitest';
import { align10min, bisectCoverage, fetchWithCoverage } from '../lib/liveCoverage';
import type { FetchWindow } from '../lib/liveCoverage';
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
    game_name:     '',
    ...overrides,
  };
}

const TEN_MIN_MS = 10 * 60_000;

// ── align10min ────────────────────────────────────────────────────────────

describe('align10min', () => {
  it('leaves already-aligned times unchanged', () => {
    const d = new Date('2024-01-01T10:00:00Z');
    expect(align10min(d).toISOString()).toBe('2024-01-01T10:00:00.000Z');
  });

  it('rounds down to nearest 10-minute boundary', () => {
    const d = new Date('2024-01-01T10:17:43Z');
    expect(align10min(d).toISOString()).toBe('2024-01-01T10:10:00.000Z');
  });

  it('handles :59 correctly', () => {
    const d = new Date('2024-01-01T12:59:59Z');
    expect(align10min(d).toISOString()).toBe('2024-01-01T12:50:00.000Z');
  });

  it('does not mutate the input date', () => {
    const d = new Date('2024-01-01T10:17:43Z');
    const original = d.getTime();
    align10min(d);
    expect(d.getTime()).toBe(original);
  });
});

// ── bisectCoverage ────────────────────────────────────────────────────────

describe('bisectCoverage', () => {
  it('makes no calls for empty range', async () => {
    let calls = 0;
    const fetchWindow: FetchWindow = async () => { calls++; return { clips: [], hasMore: false }; };
    const results: LiveClip[] = [];
    const seen = new Set<string>();

    const d = new Date('2024-01-01T00:00:00Z');
    await bisectCoverage(fetchWindow, d, d, TEN_MIN_MS, results, seen);

    expect(calls).toBe(0);
    expect(results).toHaveLength(0);
  });

  it('stops immediately on 0-clip response (proven empty)', async () => {
    let calls = 0;
    const fetchWindow: FetchWindow = async () => { calls++; return { clips: [], hasMore: false }; };
    const results: LiveClip[] = [];
    const seen = new Set<string>();

    await bisectCoverage(
      fetchWindow,
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-02-01T00:00:00Z'),
      TEN_MIN_MS, results, seen,
    );

    expect(calls).toBe(1);
    expect(results).toHaveLength(0);
  });

  it('stores clips at minimum window without further bisection', async () => {
    let calls = 0;
    const clip = makeClip({ id: 'c1', created_at: '2024-01-01T10:05:00Z' });
    const fetchWindow: FetchWindow = async () => {
      calls++;
      return { clips: [clip], hasMore: false };
    };
    const results: LiveClip[] = [];
    const seen = new Set<string>();

    await bisectCoverage(
      fetchWindow,
      new Date('2024-01-01T10:00:00Z'),
      new Date('2024-01-01T10:10:00Z'),
      TEN_MIN_MS, results, seen,
    );

    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('c1');
  });

  it('bisects when clips found in a wide window', async () => {
    let calls = 0;
    const clip = makeClip({ id: 'c1', created_at: '2024-01-01T10:05:00Z' });
    const clipTime = new Date('2024-01-01T10:05:00Z').getTime();

    const fetchWindow: FetchWindow = async (startedAt, endedAt) => {
      calls++;
      const start = new Date(startedAt).getTime();
      const end   = new Date(endedAt).getTime();
      if (start <= clipTime && clipTime < end) return { clips: [clip], hasMore: false };
      return { clips: [], hasMore: false };
    };
    const results: LiveClip[] = [];
    const seen = new Set<string>();

    await bisectCoverage(
      fetchWindow,
      new Date('2024-01-01T10:00:00Z'),
      new Date('2024-01-01T11:00:00Z'),
      TEN_MIN_MS, results, seen,
    );

    // Parent + children — must have made more than 1 call.
    expect(calls).toBeGreaterThan(1);
    // Clip is deduplicated — only 1 in results.
    expect(results).toHaveLength(1);
  });

  it('discovers a suppressed clip via bisection', async () => {
    // Clip A at 10:05, Clip B at 10:25.
    // When both are in the same query window, only A is returned (suppression).
    // Bisection separates them into [10:00,10:10] and [10:20,10:30].
    const clipA = makeClip({ id: 'clipA', created_at: '2024-01-01T10:05:00Z', view_count: 3 });
    const clipB = makeClip({ id: 'clipB', created_at: '2024-01-01T10:25:00Z', view_count: 3 });
    const timeA = new Date('2024-01-01T10:05:00Z').getTime();
    const timeB = new Date('2024-01-01T10:25:00Z').getTime();

    const fetchWindow: FetchWindow = async (startedAt, endedAt) => {
      const start = new Date(startedAt).getTime();
      const end   = new Date(endedAt).getTime();
      const aIn = start <= timeA && timeA < end;
      const bIn = start <= timeB && timeB < end;

      if (aIn && bIn) return { clips: [clipA], hasMore: false }; // suppression
      const clips: LiveClip[] = [];
      if (aIn) clips.push(clipA);
      if (bIn) clips.push(clipB);
      return { clips, hasMore: false };
    };
    const results: LiveClip[] = [];
    const seen = new Set<string>();

    await bisectCoverage(
      fetchWindow,
      new Date('2024-01-01T10:00:00Z'),
      new Date('2024-01-01T10:30:00Z'),
      TEN_MIN_MS, results, seen,
    );

    const ids = new Set(results.map(c => c.id));
    expect(ids.has('clipA')).toBe(true);
    expect(ids.has('clipB')).toBe(true);
  });

  it('bisects on overflow (hasMore=true)', async () => {
    let calls = 0;
    const fetchWindow: FetchWindow = async (startedAt, endedAt) => {
      calls++;
      const start = new Date(startedAt).getTime();
      const end   = new Date(endedAt).getTime();
      // Overflow only in windows wider than 10 minutes.
      if (end - start > TEN_MIN_MS) return { clips: [], hasMore: true };
      return { clips: [], hasMore: false };
    };
    const results: LiveClip[] = [];
    const seen = new Set<string>();

    await bisectCoverage(
      fetchWindow,
      new Date('2024-01-01T10:00:00Z'),
      new Date('2024-01-01T11:00:00Z'),
      TEN_MIN_MS, results, seen,
    );

    expect(calls).toBeGreaterThan(1);
  });

  it('deduplicates clips found at multiple bisection levels', async () => {
    const clip = makeClip({ id: 'dup', created_at: '2024-01-01T10:05:00Z' });
    const clipTime = new Date('2024-01-01T10:05:00Z').getTime();

    const fetchWindow: FetchWindow = async (startedAt, endedAt) => {
      const start = new Date(startedAt).getTime();
      const end   = new Date(endedAt).getTime();
      if (start <= clipTime && clipTime < end) return { clips: [clip], hasMore: false };
      return { clips: [], hasMore: false };
    };
    const results: LiveClip[] = [];
    const seen = new Set<string>();

    await bisectCoverage(
      fetchWindow,
      new Date('2024-01-01T10:00:00Z'),
      new Date('2024-01-01T10:30:00Z'),
      TEN_MIN_MS, results, seen,
    );

    // Parent and child both find the clip, but results should only have it once.
    expect(results.filter(c => c.id === 'dup')).toHaveLength(1);
  });
});

// ── fetchWithCoverage ─────────────────────────────────────────────────────

describe('fetchWithCoverage', () => {
  it('returns empty array when no clips exist', async () => {
    const fetchWindow: FetchWindow = async () => ({ clips: [], hasMore: false });
    // Use a sinceDate 1 hour ago to create a small range.
    const sinceDate = new Date(Date.now() - 3_600_000).toISOString();

    const result = await fetchWithCoverage(fetchWindow, sinceDate);

    expect(result).toEqual([]);
  });

  it('finds suppressed clips across the full range', async () => {
    const now = Date.now();
    const clipA = makeClip({
      id: 'A', created_at: new Date(now - 25 * 60_000).toISOString(), view_count: 2,
    });
    const clipB = makeClip({
      id: 'B', created_at: new Date(now - 5 * 60_000).toISOString(), view_count: 2,
    });
    const timeA = new Date(clipA.created_at).getTime();
    const timeB = new Date(clipB.created_at).getTime();

    const fetchWindow: FetchWindow = async (startedAt, endedAt) => {
      const start = new Date(startedAt).getTime();
      const end   = new Date(endedAt).getTime();
      const aIn = start <= timeA && timeA < end;
      const bIn = start <= timeB && timeB < end;

      if (aIn && bIn) return { clips: [clipA], hasMore: false };
      const clips: LiveClip[] = [];
      if (aIn) clips.push(clipA);
      if (bIn) clips.push(clipB);
      return { clips, hasMore: false };
    };

    const sinceDate = new Date(now - 30 * 60_000).toISOString();
    const result = await fetchWithCoverage(fetchWindow, sinceDate);

    const ids = new Set(result.map(c => c.id));
    expect(ids.has('A')).toBe(true);
    expect(ids.has('B')).toBe(true);
  });
});
