// Phase 1: synchronous sql.js loaded from CDN.
// Phase 2 will replace this file with the sql.js-httpvfs async implementation.

// sql.js is loaded as a <script> tag in index.html and placed on window.
declare function initSqlJs(opts: { locateFile: (f: string) => string }): Promise<SqlJsStatic>;

interface SqlJsStatic {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Database: new (data: Uint8Array) => any;
}

export type Row = Record<string, string | number | null>;

// Accepts either named params (:name → value) or positional params ([val, ...])
type BindParams = Record<string, string | number | null> | (string | number | null)[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: any = null;

export const DB_URL = '/clips.db';

export async function initDb(dbUrl: string = DB_URL): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (f: string) =>
      `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`,
  });
  const res = await fetch(dbUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${dbUrl}`);
  const buf = await res.arrayBuffer();
  _db = new SQL.Database(new Uint8Array(buf));
}

export function q(sql: string, params?: BindParams): Row[] {
  if (!_db) throw new Error('DB not initialized');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any[] = _db.exec(sql, params);
  if (!res.length) return [];
  const cols: string[] = res[0].columns;
  return (res[0].values as (string | number | null)[][]).map(row =>
    Object.fromEntries(cols.map((c, i) => [c, row[i] ?? null])),
  );
}
