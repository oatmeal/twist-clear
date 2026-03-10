// Phase 2: sql.js-httpvfs — HTTP Range request VFS.
// Only the SQLite B-tree pages needed for each query are fetched over the
// network; the rest of the file is never downloaded.
// Requires the DB to be in DELETE journal mode (not WAL).

import { createDbWorker } from 'sql.js-httpvfs';
import workerUrl from 'sql.js-httpvfs/dist/sqlite.worker.js?url';
import wasmUrl from 'sql.js-httpvfs/dist/sql-wasm.wasm?url';
import type { WorkerHttpvfs } from 'sql.js-httpvfs';

export type Row = Record<string, string | number | null>;

// Accepts either named params (:name → value) or positional params ([val, ...]).
// Both are passed directly to sql.js exec() inside the worker:
//   worker.db.query = (...args) => toObjects(exec(...args))
type BindParams = Record<string, string | number | null> | (string | number | null)[];

let _worker: WorkerHttpvfs | null = null;

export const DB_URL = import.meta.env.BASE_URL + 'clips.db';

/**
 * Probe the DB URL with a Range request to learn the true (uncompressed) file
 * size from the Content-Range response header.
 *
 * GitHub Pages / Fastly gzip-compresses the DB file for full GET/HEAD
 * requests and reports the *compressed* size in Content-Length. However, per
 * RFC 7233, partial-content (206) responses must report the actual resource
 * size in Content-Range ("bytes 0-0/<totalBytes>"), so we can extract the
 * real size without being misled by the gzip Content-Length.
 */
async function probeDbSize(url: string): Promise<number | null> {
  try {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const cr = resp.headers.get('Content-Range'); // "bytes 0-0/23384064"
    const m = cr ? /\/(\d+)$/.exec(cr) : null;
    return m ? parseInt(m[1]!, 10) : null;
  } catch {
    return null;
  }
}

export async function initDb(dbUrl: string = DB_URL): Promise<void> {
  // Probe the true file size before handing off to sql.js-httpvfs.
  //
  // In `serverMode: 'full'`, the worker issues a synchronous XHR HEAD request
  // and uses the Content-Length as the total file size. On GitHub Pages,
  // Fastly returns the *gzip-compressed* Content-Length (~8 MB for a ~22 MB
  // DB), causing the worker to treat pages beyond ~8 MB as out-of-range and
  // fail every B-tree lookup into the upper part of the file.
  //
  // In `serverMode: 'chunked'`, the worker uses `databaseLengthBytes` from
  // the config and never issues a HEAD request. We use the single-"chunk"
  // variant (serverChunkSize = databaseLengthBytes, the whole file as one
  // chunk) to retain the same behaviour as `full` mode for Range requests.
  //
  // The `urlPrefix + suffixLength` scheme appends the chunk index as a string,
  // so chunk 0 becomes `<dbUrl>?chunked=0`. GitHub Pages ignores query strings
  // for static-file lookups; the Vite dev/preview dbRangePlugin already strips
  // the query string before matching, so this works in all environments.
  const fileSize = await probeDbSize(dbUrl);

  _worker = await createDbWorker(
    [{
      from: 'inline',
      config: fileSize != null
        ? {
            serverMode: 'chunked',
            urlPrefix: dbUrl + '?chunked=',
            serverChunkSize: fileSize,
            databaseLengthBytes: fileSize,
            suffixLength: 1,
            requestChunkSize: 4096,
          }
        : {
            // Fallback for servers that don't return Content-Range (unusual).
            // Will produce incorrect results on GitHub Pages due to the
            // gzip Content-Length issue described above.
            serverMode: 'full',
            url: dbUrl,
            requestChunkSize: 4096,
          },
    }],
    workerUrl,
    wasmUrl,
  );
}

export async function q(sql: string, params?: BindParams): Promise<Row[]> {
  if (!_worker) throw new Error('DB not initialized');
  // Cast through any to avoid fighting Comlink.Remote<T>'s complex generic types.
  // At runtime, query(...args) delegates to exec(...args) which accepts both
  // positional arrays and named-param objects, same as Phase 1.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = _worker.db as any;
  return params !== undefined
    ? (db.query(sql, params) as Promise<Row[]>)
    : (db.query(sql) as Promise<Row[]>);
}
