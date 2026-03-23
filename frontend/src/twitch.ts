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
