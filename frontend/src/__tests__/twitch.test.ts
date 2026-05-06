import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseTwitchDuration, fetchLiveAfterTimestamp } from '../twitch';

// ── parseTwitchDuration ───────────────────────────────────────────────────────

describe('parseTwitchDuration', () => {
  it('parses full h/m/s string', () => {
    expect(parseTwitchDuration('1h2m3s')).toBe(3723);
  });

  it('parses hours only', () => {
    expect(parseTwitchDuration('2h')).toBe(7200);
  });

  it('parses minutes only', () => {
    expect(parseTwitchDuration('45m')).toBe(2700);
  });

  it('parses seconds only', () => {
    expect(parseTwitchDuration('30s')).toBe(30);
  });

  it('parses hours and minutes without seconds', () => {
    expect(parseTwitchDuration('9h44m')).toBe(35040);
  });

  it('parses real-world VOD duration', () => {
    // From the test against lilimaruriri's API response.
    expect(parseTwitchDuration('9h44m42s')).toBe(35082);
  });

  it('returns 0 for empty string', () => {
    expect(parseTwitchDuration('')).toBe(0);
  });
});

// ── fetchLiveAfterTimestamp ───────────────────────────────────────────────────

const BROADCASTER = '123456';
const TOKEN = 'fake-token';

function makeStreamRes(live: boolean) {
  return {
    ok: true,
    json: async () => ({
      data: live ? [{ started_at: '2025-05-06T14:00:00Z' }] : [],
    }),
  };
}

function makeVideoRes(vods: Array<{ created_at: string; duration: string }>) {
  return {
    ok: true,
    json: async () => ({ data: vods }),
  };
}

function makeErrorRes() {
  return { ok: false };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchLiveAfterTimestamp', () => {
  it('returns null when streams API fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeErrorRes()));
    expect(await fetchLiveAfterTimestamp(BROADCASTER, TOKEN)).toBeNull();
  });

  it('returns null when videos API fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(makeStreamRes(false))
      .mockResolvedValueOnce(makeErrorRes()),
    );
    expect(await fetchLiveAfterTimestamp(BROADCASTER, TOKEN)).toBeNull();
  });

  it('returns null when offline and no VODs exist', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(makeStreamRes(false))
      .mockResolvedValueOnce(makeVideoRes([])),
    );
    expect(await fetchLiveAfterTimestamp(BROADCASTER, TOKEN)).toBeNull();
  });

  it('offline: returns end time of the first (only) VOD', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(makeStreamRes(false))
      .mockResolvedValueOnce(makeVideoRes([
        { created_at: '2025-05-05T10:00:00Z', duration: '2h0m0s' },
      ])),
    );
    // 10:00 + 2h = 12:00
    expect(await fetchLiveAfterTimestamp(BROADCASTER, TOKEN)).toBe('2025-05-05T12:00:00.000Z');
  });

  it('offline: fetches only 1 VOD', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeStreamRes(false))
      .mockResolvedValueOnce(makeVideoRes([
        { created_at: '2025-05-05T10:00:00Z', duration: '1h0m0s' },
      ]));
    vi.stubGlobal('fetch', mockFetch);
    await fetchLiveAfterTimestamp(BROADCASTER, TOKEN);
    const videoUrl = (mockFetch.mock.calls[1] as [string])[0];
    expect(videoUrl).toContain('first=1');
  });

  it('live: fetches 2 VODs and skips the ongoing one at index 0', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(makeStreamRes(true))
      .mockResolvedValueOnce(makeVideoRes([
        // index 0: ongoing (live) VOD — should be skipped
        { created_at: '2025-05-06T14:00:00Z', duration: '4h0m0s' },
        // index 1: last completed VOD — should be used
        { created_at: '2025-05-05T10:00:00Z', duration: '3h0m0s' },
      ]));
    vi.stubGlobal('fetch', mockFetch);
    // 10:00 + 3h = 13:00
    expect(await fetchLiveAfterTimestamp(BROADCASTER, TOKEN)).toBe('2025-05-05T13:00:00.000Z');
    const videoUrl = (mockFetch.mock.calls[1] as [string])[0];
    expect(videoUrl).toContain('first=2');
  });

  it('live: returns null when no previous completed VOD exists', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(makeStreamRes(true))
      // Only the ongoing VOD is returned; index 1 is absent.
      .mockResolvedValueOnce(makeVideoRes([
        { created_at: '2025-05-06T14:00:00Z', duration: '4h0m0s' },
      ])),
    );
    expect(await fetchLiveAfterTimestamp(BROADCASTER, TOKEN)).toBeNull();
  });
});
