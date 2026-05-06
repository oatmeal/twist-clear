import { fetchWithCoverage } from './lib/liveCoverage';
import type { FetchWindow } from './lib/liveCoverage';

/** A clip fetched live from the Twitch Helix API. */
export interface LiveClip {
  id:            string;
  title:         string;
  creator_name:  string;
  view_count:    number;
  created_at:    string; // ISO 8601
  duration:      number; // seconds
  thumbnail_url: string;
  url:           string;
  game_id:       string;
  game_name:     string; // filled in after fetchGameNames()
}

const CLIENT_ID: string = (import.meta.env as Record<string, string>)['VITE_TWITCH_CLIENT_ID'] ?? '';

function authHeaders(token: string): Record<string, string> {
  return { 'Client-Id': CLIENT_ID, 'Authorization': `Bearer ${token}` };
}

/**
 * Fetch all clips created after sinceDate (ISO 8601) for the given broadcaster.
 * Paginates automatically until Twitch returns no further cursor.
 * game_name is left as '' — call fetchGameNames() to populate it.
 */
export async function fetchNewClips(
  broadcasterId: string,
  sinceDate:     string,
  token:         string,
): Promise<LiveClip[]> {
  const clips: LiveClip[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ broadcaster_id: broadcasterId, started_at: sinceDate, first: '100' });
    if (cursor) params.set('after', cursor);

    const res = await fetch(`https://api.twitch.tv/helix/clips?${params}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) break;

    const body = await res.json() as {
      data: Array<{
        id: string; title: string; creator_name: string;
        view_count: number; created_at: string; duration: number;
        thumbnail_url: string; url: string; game_id: string;
      }>;
      pagination?: { cursor?: string };
    };

    for (const c of body.data) clips.push(parseClip(c));

    cursor = body.pagination?.cursor;
  } while (cursor);

  return clips;
}

function parseClip(c: {
  id: string; title: string; creator_name: string;
  view_count: number; created_at: string; duration: number;
  thumbnail_url: string; url: string; game_id: string;
}): LiveClip {
  return {
    id: c.id, title: c.title, creator_name: c.creator_name,
    view_count: c.view_count, created_at: c.created_at, duration: c.duration,
    thumbnail_url: c.thumbnail_url, url: c.url, game_id: c.game_id, game_name: '',
  };
}

/**
 * Fetch clips in a single time window [startedAt, endedAt], max 100.
 * Returns the clips and whether there are more (cursor present = overflow).
 */
export async function fetchClipsWindow(
  broadcasterId: string,
  startedAt:     string,
  endedAt:       string,
  token:         string,
): Promise<{ clips: LiveClip[]; hasMore: boolean }> {
  const params = new URLSearchParams({
    broadcaster_id: broadcasterId,
    started_at: startedAt,
    ended_at: endedAt,
    first: '100',
  });

  const res = await fetch(`https://api.twitch.tv/helix/clips?${params}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) return { clips: [], hasMore: false };

  const body = await res.json() as {
    data: Array<{
      id: string; title: string; creator_name: string;
      view_count: number; created_at: string; duration: number;
      thumbnail_url: string; url: string; game_id: string;
    }>;
    pagination?: { cursor?: string };
  };

  return {
    clips: body.data.map(parseClip),
    hasMore: Boolean(body.pagination?.cursor),
  };
}

/**
 * Fetch all clips since sinceDate using 0-clip coverage bisection.
 *
 * Uses recursive bisection to find clips hidden by Twitch's bucket
 * quantization and same-video suppression. game_name is left as '' —
 * call fetchGameNames() to populate it.
 */
export async function fetchNewClipsWithCoverage(
  broadcasterId: string,
  sinceDate:     string,
  token:         string,
  onProgress?:   (clips: LiveClip[]) => void,
): Promise<LiveClip[]> {
  const fetchWindow: FetchWindow = (startedAt, endedAt) =>
    fetchClipsWindow(broadcasterId, startedAt, endedAt, token);

  return fetchWithCoverage(fetchWindow, sinceDate, 10, onProgress);
}

/** Parse a Twitch VOD duration string (e.g. "1h2m3s", "45m", "30s") into seconds. */
export function parseTwitchDuration(d: string): number {
  const h = /(\d+)h/.exec(d)?.[1] ?? '0';
  const m = /(\d+)m/.exec(d)?.[1] ?? '0';
  const s = /(\d+)s/.exec(d)?.[1] ?? '0';
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s);
}

/**
 * Compute the ISO 8601 timestamp to use as the "live after" cutoff.
 *
 * Returns the end time of the most recent *completed* stream (created_at +
 * duration of the last finished VOD), so clips from the current session are
 * highlighted whether the stream is live or has just ended.
 *
 * When a stream is live its VOD appears first in the /helix/videos archive
 * list, so we fetch one extra and skip index 0. Returns null if the Twitch
 * API is unavailable or no completed VOD exists (caller falls back to current
 * behaviour).
 */
export async function fetchLiveAfterTimestamp(
  broadcasterId: string,
  token:         string,
): Promise<string | null> {
  const streamRes = await fetch(
    `https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`,
    { headers: authHeaders(token) },
  );
  if (!streamRes.ok) return null;

  const streamBody = await streamRes.json() as { data: Array<unknown> };
  const isLive = streamBody.data.length > 0;

  // When live, the ongoing VOD is at index 0 — fetch one extra to reach the
  // most recent completed VOD at index 1.
  const first = isLive ? 2 : 1;
  const videoRes = await fetch(
    `https://api.twitch.tv/helix/videos?user_id=${broadcasterId}&type=archive&first=${first}`,
    { headers: authHeaders(token) },
  );
  if (!videoRes.ok) return null;

  const videoBody = await videoRes.json() as {
    data: Array<{ created_at: string; duration: string }>;
  };
  const vod = videoBody.data[isLive ? 1 : 0];
  if (!vod) return null;

  const endMs = new Date(vod.created_at).getTime() + parseTwitchDuration(vod.duration) * 1000;
  return new Date(endMs).toISOString();
}

/**
 * Batch-fetch game names for a set of game IDs (max 100 per API call).
 * Returns a map of game ID → name. Unknown IDs are omitted.
 */
export async function fetchGameNames(
  gameIds: string[],
  token:   string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const unique = [...new Set(gameIds.filter(Boolean))];

  for (let i = 0; i < unique.length; i += 100) {
    const batch  = unique.slice(i, i + 100);
    const params = new URLSearchParams(batch.map(id => ['id', id] as [string, string]));

    const res = await fetch(`https://api.twitch.tv/helix/games?${params}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) continue;

    const body = await res.json() as { data: Array<{ id: string; name: string }> };
    for (const g of body.data) result[g.id] = g.name;
  }

  return result;
}
