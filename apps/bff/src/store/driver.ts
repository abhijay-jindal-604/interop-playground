/**
 * The SQLite driver seam behind `Store` (ADR-35, RISK-29): `better-sqlite3` by default, `node:sqlite`
 * as the one-file fallback. Both expose the same tiny synchronous surface; positional `?` parameters
 * only, so the two drivers bind identically.
 */
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import type { DatabaseSync as NodeSqlite } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;
export type DriverName = 'better-sqlite3' | 'node:sqlite';
export const DRIVER_NAMES: readonly DriverName[] = ['better-sqlite3', 'node:sqlite'];

export interface SqlDriver {
  readonly name: DriverName;
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number };
  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[];
  /** `BEGIN IMMEDIATE` … `COMMIT` (05 §1); nested calls become savepoints */
  transaction<T>(fn: () => T): T;
  readonly inTransaction: boolean;
  close(): void;
}

interface Stmt {
  run(...p: unknown[]): { changes: number | bigint };
  get(...p: unknown[]): unknown;
  all(...p: unknown[]): unknown[];
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

/** Buffers are bound as-is; a plain Uint8Array becomes a Buffer view (better-sqlite3 wants Buffers). */
function bind(params: SqlValue[]): unknown[] {
  return params.map((p) =>
    p instanceof Uint8Array && !Buffer.isBuffer(p)
      ? Buffer.from(p.buffer, p.byteOffset, p.byteLength)
      : p,
  );
}
/** node:sqlite returns null-prototype rows and Uint8Array blobs; normalise to plain objects + Buffers. */
function norm<T>(row: unknown): T {
  const out: Row = {};
  for (const [k, v] of Object.entries(row as Row)) {
    out[k] =
      v instanceof Uint8Array && !Buffer.isBuffer(v)
        ? Buffer.from(v.buffer, v.byteOffset, v.byteLength)
        : v;
  }
  return out as T;
}

class Driver implements SqlDriver {
  private readonly cache = new Map<string, Stmt>();
  private depth = 0;
  constructor(
    readonly name: DriverName,
    private readonly db: RawDb,
  ) {}
  get inTransaction(): boolean {
    return this.depth > 0;
  }
  private stmt(sql: string): Stmt {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  run(sql: string, ...params: SqlValue[]): { changes: number } {
    return { changes: Number(this.stmt(sql).run(...bind(params)).changes) };
  }
  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    const r = this.stmt(sql).get(...bind(params));
    return r === undefined || r === null ? undefined : norm<T>(r);
  }
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql)
      .all(...bind(params))
      .map((r) => norm<T>(r));
  }
  transaction<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.depth--;
      this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }
  close(): void {
    this.cache.clear();
    this.db.close();
  }
}

/** Connection setup of 05 §1, run on every connection. */
const PRAGMAS = [
  'PRAGMA journal_mode=WAL',
  'PRAGMA synchronous=FULL',
  'PRAGMA foreign_keys=ON',
  'PRAGMA busy_timeout=5000',
  'PRAGMA trusted_schema=OFF',
];

export function openDriver(file: string, name: DriverName = defaultDriverName()): SqlDriver {
  let raw: RawDb;
  if (name === 'better-sqlite3') {
    raw = new Database(file);
  } else {
    // loaded lazily so the default driver never triggers node:sqlite's ExperimentalWarning
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof NodeSqlite };
    raw = new DatabaseSync(file);
  }
  for (const p of PRAGMAS) raw.exec(p);
  return new Driver(name, raw);
}

/** `PLAYGROUND_DB_DRIVER=node:sqlite` switches the driver (RISK-29 fallback). */
export function defaultDriverName(env: NodeJS.ProcessEnv = process.env): DriverName {
  const v = env.PLAYGROUND_DB_DRIVER;
  return v === 'node:sqlite' || v === 'node-sqlite' ? 'node:sqlite' : 'better-sqlite3';
}
