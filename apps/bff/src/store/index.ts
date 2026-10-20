/**
 * Store module (05, ADR-35/36): `openStore(path)` opens the SQLite file with the chosen driver,
 * applies pending migrations (backup first) before anything else touches it, and returns the
 * EventSink (the only writer of the event tables) and the reader.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { SecretRegistry } from '../redact/registry.js';
import { openDriver, type DriverName, type SqlDriver } from './driver.js';
import { migrate, type MigrateResult } from './migrate.js';
import { StoreReader } from './reader.js';
import { EventSink } from './sink.js';

export { DRIVER_NAMES, defaultDriverName, type DriverName, type SqlDriver } from './driver.js';
export {
  StoreError,
  loadMigrations,
  migrate,
  MIGRATIONS_DIR,
  type MigrateResult,
} from './migrate.js';
export { EventSink, type NewRun, type NewSuite, type NewArtifact, type SinkEvent } from './sink.js';
export { StoreReader } from './reader.js';
export { LIMITS } from './limits.js';
export type { RawBody } from './bodies.js';

export interface OpenStoreOptions {
  driver?: DriverName;
  registry?: SecretRegistry;
  appVersion?: string;
  migrationsDir?: string;
  /** default `<db dir>/backups` (05 §9: `/data/backups`) */
  backupDir?: string | null;
  now?: () => Date;
}

export interface Store {
  readonly path: string;
  readonly driver: SqlDriver;
  readonly sink: EventSink;
  readonly reader: StoreReader;
  readonly migration: MigrateResult;
  close(): void;
}

/** the DB file under `DATA_DIR` (10 §8.3, 05: `/data/playground.db`) */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.DATA_DIR ?? '/data', 'playground.db');
}

/**
 * Opens (creating if needed) the SQLite store, applies migrations and returns the writer (sink),
 * reader and raw driver. File mode is restrictive because the holder keys live in this file.
 */
export function openStore(file: string, opts: OpenStoreOptions = {}): Store {
  const memory = file === ':memory:';
  if (!memory) {
    // holder keys live in this file: dir 0700, file 0600 (05 §1, 02 §6.2)
    const dir = path.dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const driver = openDriver(file, opts.driver);
  try {
    if (!memory) chmodSync(file, 0o600);
    const migration = migrate(driver, {
      ...(opts.migrationsDir ? { migrationsDir: opts.migrationsDir } : {}),
      appVersion: opts.appVersion ?? '0.0.0',
      backupDir:
        opts.backupDir === undefined
          ? memory
            ? null
            : path.join(path.dirname(file), 'backups')
          : opts.backupDir,
      ...(opts.now ? { now: opts.now } : {}),
    });
    const sink = new EventSink(driver, {
      registry: opts.registry ?? new SecretRegistry(),
      ...(opts.now ? { now: opts.now } : {}),
    });
    return {
      path: file,
      driver,
      sink,
      reader: new StoreReader(driver),
      migration,
      close: () => driver.close(),
    };
  } catch (err) {
    driver.close();
    throw err;
  }
}
