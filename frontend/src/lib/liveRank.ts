import type { LiveClip } from '../twitch';
import type { Row } from '../db';

export type ViewCountSortKey = 'view_count_desc' | 'view_count_asc';

export interface RankedLiveClip {
  clip: LiveClip;
  /** Number of DB clips (matching active filters) that sort before this clip. */
  dbRank: number;
  /** Position in the merged (DB + live) sequence: dbRank + index among live clips. */
  mergedPos: number;
}

export interface ViewCountPage {
  /** Live clips that fall on this page, in merged-position order. */
  liveOnPage: RankedLiveClip[];
  /** Number of DB clips to fetch for this page (= PAGE_SIZE - liveOnPage.length). */
  dbOnPage: number;
  /** OFFSET to use in the DB query. */
  dbOffset: number;
}

export type PageItem =
  | { kind: 'live'; clip: LiveClip }
  | { kind: 'db';   row: Row };

/**
 * Compute DB ranks for each live clip under a view_count sort order, then
 * assign merged positions in the combined (DB + live) sequence.
 *
 * For each unique (view_count, created_at) pair, one COUNT(*) query is run
 * against the DB to determine how many DB clips sort before that pair. The
 * composite index clips_view_count(view_count DESC, created_at DESC) makes
 * each COUNT an index range scan — O(log N).
 *
 * Merged position assignment: after sorting live clips by the same key the
 * DB uses, mergedPos(i) = dbRank(i) + i, where i is the 0-based index in
 * that sorted order. The +i accounts for all live clips that precede clip i.
 *
 * @param clips    Filtered live clips.
 * @param sortBy   'view_count_desc' or 'view_count_asc'.
 * @param where    WHERE clause from buildWhere (empty string if no filters).
 * @param params   Bind params from buildWhere.
 * @param queryFn  Execute a SQL query; receives named params including :_vc and :_ca.
 */
export async function rankLiveClips(
  clips: LiveClip[],
  sortBy: ViewCountSortKey,
  where: string,
  params: Record<string, string>,
  queryFn: (sql: string, p: Record<string, string | number | null>) => Promise<Row[]>,
): Promise<RankedLiveClip[]> {
  if (clips.length === 0) return [];

  const isDesc = sortBy === 'view_count_desc';

  // Sort live clips by the same key as the DB (view_count then created_at).
  // ISO 8601 created_at strings are lexicographically ordered.
  const sorted = [...clips].sort((a, b) => {
    const vcCmp = isDesc ? b.view_count - a.view_count : a.view_count - b.view_count;
    if (vcCmp !== 0) return vcCmp;
    const tsCmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    return isDesc ? -tsCmp : tsCmp;
  });

  // Deduplicate: clips with the same (view_count, created_at) share a DB rank.
  const seen = new Set<string>();
  const uniquePairs: Array<{ view_count: number; created_at: string; key: string }> = [];
  for (const clip of sorted) {
    const key = `${clip.view_count}\x00${clip.created_at}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniquePairs.push({ view_count: clip.view_count, created_at: clip.created_at, key });
    }
  }

  // One COUNT query per unique pair.
  // :_vc and :_ca are chosen to avoid collisions with buildWhere param names.
  const prefix = where ? `${where} AND` : 'WHERE';
  const rankCache = new Map<string, number>();

  for (const { view_count, created_at, key } of uniquePairs) {
    // Count DB clips that strictly precede this (view_count, created_at) in sort order.
    const condition = isDesc
      // desc: higher view_count first; among ties, newer created_at first
      ? `(c.view_count > :_vc OR (c.view_count = :_vc AND c.created_at > :_ca))`
      // asc: lower view_count first; among ties, older created_at first
      : `(c.view_count < :_vc OR (c.view_count = :_vc AND c.created_at < :_ca))`;

    const sql = `SELECT COUNT(*) AS cnt FROM clips c ${prefix} ${condition}`;
    const rows = await queryFn(sql, { ...params, ':_vc': view_count, ':_ca': created_at });
    rankCache.set(key, (rows[0]?.['cnt'] as number | undefined) ?? 0);
  }

  // mergedPos(i) = dbRank(i) + i
  // The +i term counts the i live clips that sort before clip i.
  return sorted.map((clip, i) => {
    const key = `${clip.view_count}\x00${clip.created_at}`;
    const dbRank = rankCache.get(key)!;
    return { clip, dbRank, mergedPos: dbRank + i };
  });
}

/**
 * Given ranked live clips and the current page bounds, compute which live
 * clips appear on this page and the DB query parameters needed to fill it.
 */
export function computeViewCountPage(
  ranked: RankedLiveClip[],
  pageStart: number,
  pageSize: number,
): ViewCountPage {
  const pageEnd = pageStart + pageSize;
  const liveOnPage = ranked.filter(r => r.mergedPos >= pageStart && r.mergedPos < pageEnd);
  const livesBefore = ranked.filter(r => r.mergedPos < pageStart).length;
  return {
    liveOnPage,
    dbOnPage: pageSize - liveOnPage.length,
    dbOffset: pageStart - livesBefore,
  };
}

/**
 * Interleave DB rows and live clips into a single page sequence, placing each
 * live clip at its correct relative position within the page.
 *
 * @param dbClips    DB rows for this page (in sort order, as returned by the query).
 * @param liveOnPage Ranked live clips that fall on this page.
 * @param pageStart  Absolute merged-sequence index of the first slot on this page.
 * @param pageSize   Maximum number of items on the page.
 */
export function interleavePage(
  dbClips: Row[],
  liveOnPage: RankedLiveClip[],
  pageStart: number,
  pageSize: number,
): PageItem[] {
  // Map each live clip to its relative slot on the page.
  const liveByRelPos = new Map(
    liveOnPage.map(({ clip, mergedPos }) => [mergedPos - pageStart, clip]),
  );

  const result: PageItem[] = [];
  let dbIdx = 0;

  for (let relPos = 0; relPos < pageSize; relPos++) {
    const live = liveByRelPos.get(relPos);
    if (live !== undefined) {
      result.push({ kind: 'live', clip: live });
    } else if (dbIdx < dbClips.length) {
      result.push({ kind: 'db', row: dbClips[dbIdx++]! });
    } else {
      break; // last page — fewer items than pageSize
    }
  }

  return result;
}
