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

export const DB_URL = '/clips.db';

export async function initDb(dbUrl: string = DB_URL): Promise<void> {
  _worker = await createDbWorker(
    [{ from: 'inline', config: { serverMode: 'full', url: dbUrl, requestChunkSize: 4096 } }],
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
