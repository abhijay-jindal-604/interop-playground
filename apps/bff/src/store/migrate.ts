/**
 * Migration runner (05 §9, DoD-MIGRATION): forward-only numbered SQL files, checksum-verified,
 * `VACUUM INTO` backup before applying a pending migration to an existing DB (newest 3 kept),
 * refuses a DB newer than this build, `PRAGMA user_version` cross-check.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlDriver } from './driver.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
export const BACKUPS_KEPT = 3;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export class StoreError extends Error {
  constructor(
    readonly code:
      | 'db_newer'
      | 'migration_edited'
      | 'migration_missing'
      | 'migration_failed'
      | 'migrations_gap'
      | 'spec_too_large'
      | 'run_closed'
      | 'run_unknown',
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = /^(\d{4})_([a-z0-9_-]+)\.sql$/.exec(file);
    if (!m) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    out.push({ version: Number(m[1]), name: m[2] ?? '', sql, checksum: sha256Hex(sql) });
  }
  out.forEach((mig, i) => {
    if (mig.version !== i + 1) {
      throw new StoreError('migrations_gap', `migrations are not contiguous at ${mig.version}`);
    }
  });
  return out;
}

export interface MigrateOptions {
  migrationsDir?: string;
  appVersion?: string;
  /** directory for `VACUUM INTO` backups; null disables (in-memory DBs) */
  backupDir?: string | null;
  now?: () => Date;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
  backup: string | null;
}

export function migrate(db: SqlDriver, opts: MigrateOptions = {}): MigrateResult {
  const migrations = loadMigrations(opts.migrationsDir);
  const newest = migrations.length;
  const userVersion = Number(
    db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0,
  );
  if (userVersion > newest) {
    throw new StoreError(
      'db_newer',
      `database schema version ${userVersion} is newer than this build's newest migration ${newest}; ` +
        'run the newer image, or open a copy with it (no downgrade, 05 §9)',
    );
  }
  const hasTable = db.get(
    "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  const applied = hasTable
    ? db.all<{ version: number; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations ORDER BY version',
      )
    : [];
  for (const row of applied) {
    const mig = migrations[row.version - 1];
    if (!mig)
      throw new StoreError('migration_missing', `applied migration ${row.version} is missing`);
    if (mig.checksum !== row.checksum) {
      throw new StoreError(
        'migration_edited',
        `migration ${row.version} was edited after it was applied`,
      );
    }
  }
  const maxApplied = applied.length ? (applied[applied.length - 1]?.version ?? 0) : 0;
  if (maxApplied !== userVersion) {
    throw new StoreError(
      'migration_missing',
      `user_version ${userVersion} disagrees with schema_migrations (${maxApplied})`,
    );
  }
  const pending = migrations.slice(maxApplied);
  let backup: string | null = null;
  if (pending.length && maxApplied > 0 && opts.backupDir) {
    backup = backupBeforeMigration(
      db,
      opts.backupDir,
      pending[0]?.version ?? 0,
      opts.now ?? (() => new Date()),
    );
  }
  const now = opts.now ?? (() => new Date());
  for (const mig of pending) {
    try {
      db.transaction(() => {
        db.exec(mig.sql);
        db.run(
          'INSERT INTO schema_migrations (version, name, checksum, app_version, applied_at) VALUES (?, ?, ?, ?, ?)',
          mig.version,
          mig.name,
          mig.checksum,
          opts.appVersion ?? '0.0.0',
          now().toISOString(),
        );
        db.exec(`PRAGMA user_version = ${mig.version}`);
      });
    } catch (err) {
      throw new StoreError(
        'migration_failed',
        `migration ${mig.version} failed and was rolled back: ${(err as Error).message}`,
      );
    }
  }
  return { from: maxApplied, to: newest, applied: pending.map((m) => m.version), backup };
}

/** `VACUUM INTO '<dir>/playground-pre-<version>-<ts>.db'`, then keep the newest 3 (05 §9 item 3). */
export function backupBeforeMigration(
  db: SqlDriver,
  dir: string,
  version: number,
  now: () => Date,
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ts = now().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `playground-pre-${String(version).padStart(4, '0')}-${ts}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const backups = readdirSync(dir)
    .filter((f) => /^playground-pre-\d{4}-.*\.db$/.test(f))
    .sort((a, b) => a.slice(20).localeCompare(b.slice(20)));
  for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) {
    rmSync(path.join(dir, old), { force: true });
  }
  return file;
}
