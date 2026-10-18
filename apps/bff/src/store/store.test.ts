import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDriver } from './driver.js';
import { recordFixtureRun } from './fixture-log.js';
import { DRIVER_NAMES, MIGRATIONS_DIR, openStore, StoreError, type Store } from './index.js';

let dir: string;
const open: Store[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pg-store-'));
});
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** RISK-29: the same suite on both drivers */
describe.each(DRIVER_NAMES)('store.migrations [%s]', (driver) => {
  const dbFile = () => path.join(dir, 'playground.db');
  const openS = (o: Parameters<typeof openStore>[1] = {}) => {
    const s = openStore(dbFile(), { driver, ...o });
    open.push(s);
    return s;
  };
  const closeAll = () => {
    for (const s of open.splice(0)) s.close();
  };

  it('applies 0001 to an empty DB; integrity and foreign keys check clean; reopen is a no-op', () => {
    const s = openS();
    expect(s.migration).toMatchObject({ from: 0, to: 1, applied: [1], backup: null });
    expect(s.driver.get('PRAGMA user_version')).toEqual({ user_version: 1 });
    expect(s.driver.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' });
    expect(s.driver.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(s.driver.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    closeAll();
    expect(openS().migration.applied).toEqual([]);
  });

  it('refuses a DB newer than the build and names both versions', () => {
    openS();
    closeAll();
    const d = openDriver(dbFile(), driver);
    d.exec('PRAGMA user_version = 7');
    d.close();
    expect(() => openS()).toThrow(/version 7 is newer than this build's newest migration 1/);
  });

  it('refuses to start when an applied migration was edited (checksum)', () => {
    const migs = path.join(dir, 'migs');
    cpSync(MIGRATIONS_DIR, migs, { recursive: true });
    openS({ migrationsDir: migs });
    closeAll();
    writeFileSync(path.join(migs, '0001_init.sql'), '-- edited\n', { flag: 'a' });
    expect(() => openS({ migrationsDir: migs })).toThrow(/migration 1 was edited/);
  });

  it('VACUUM INTO backup before a pending migration; newest 3 kept', () => {
    const migs = path.join(dir, 'migs');
    cpSync(MIGRATIONS_DIR, migs, { recursive: true });
    let t = Date.parse('2026-10-13T10:00:00.000Z');
    const now = () => new Date((t += 1000));
    const first = openS({ migrationsDir: migs, now });
    recordFixtureRun(first.sink);
    closeAll();
    for (let v = 2; v <= 5; v++) {
      writeFileSync(
        path.join(migs, `000${v}_t${v}.sql`),
        `CREATE TABLE t${v} (x INTEGER) STRICT;\n`,
      );
      const s = openS({ migrationsDir: migs, now });
      expect(s.migration.applied).toEqual([v]);
      expect(s.migration.backup).toMatch(new RegExp(`playground-pre-000${v}-`));
      closeAll();
      // the backup is a complete copy taken before version v
      const b = openDriver(String(s.migration.backup), driver);
      expect(b.get('PRAGMA user_version')).toEqual({ user_version: v - 1 });
      expect(b.get('SELECT count(*) AS n FROM run_events')).toEqual({ n: 16 });
      b.close();
    }
    const backups = readdirSync(path.join(dir, 'backups')).sort();
    expect(backups).toHaveLength(3);
    expect(backups.map((f) => f.slice(15, 19))).toEqual(['0003', '0004', '0005']);
  });

  it('a failing migration rolls back its transaction and refuses to start', () => {
    const migs = path.join(dir, 'migs');
    cpSync(MIGRATIONS_DIR, migs, { recursive: true });
    openS({ migrationsDir: migs });
    closeAll();
    writeFileSync(
      path.join(migs, '0002_bad.sql'),
      'CREATE TABLE ok2 (x INTEGER); SELECT nope FROM missing;\n',
    );
    expect(() => openS({ migrationsDir: migs })).toThrow(StoreError);
    const d = openDriver(dbFile(), driver);
    expect(d.get('PRAGMA user_version')).toEqual({ user_version: 1 });
    expect(d.get("SELECT count(*) AS n FROM sqlite_master WHERE name = 'ok2'")).toEqual({ n: 0 });
    d.close();
  });
});

describe.each(DRIVER_NAMES)('store.immutability [%s]', (driver) => {
  let s: Store;
  let runId: string;
  beforeEach(() => {
    s = openStore(path.join(dir, 'playground.db'), { driver });
    open.push(s);
    runId = recordFixtureRun(s.sink);
  });

  it('run_events is append-only: UPDATE aborts', () => {
    expect(() =>
      // eslint-disable-next-line playground/sink-only-writer -- asserts the append-only trigger
      s.driver.run("UPDATE run_events SET type = 'x' WHERE run_id = ?", runId),
    ).toThrow(/run_events: append-only/);
  });

  it.each([
    ['spec_json', `'{}'`],
    ['suite_id', `'other'`],
    ['parent_run_id', 'NULL'],
    ['control_run_id', 'NULL'],
    ['knob_delta_json', 'NULL'],
    ['target_step_key', `'x'`],
  ])('runs.%s is immutable', (col, value) => {
    expect(() => s.driver.run(`UPDATE runs SET ${col} = ${value} WHERE run_id = ?`, runId)).toThrow(
      /runs: immutable column/,
    );
  });

  it('after the terminal event only pinned, note and retention columns change; cause is set once', () => {
    expect(() => s.driver.run("UPDATE runs SET state = 'running' WHERE run_id = ?", runId)).toThrow(
      /terminal state is final/,
    );
    expect(() => s.driver.run("UPDATE runs SET outcome = 'pass' WHERE run_id = ?", runId)).toThrow(
      /terminal state is final/,
    );
    expect(() =>
      s.driver.run("UPDATE runs SET cause_fingerprint_id = 'FP-01' WHERE run_id = ?", runId),
    ).toThrow(/cause is set once/);
    s.driver.run(
      "UPDATE runs SET pinned = 1, note = 'keep', retention_class = 'pinned' WHERE run_id = ?",
      runId,
    );
    expect(s.driver.get('SELECT pinned, note FROM runs WHERE run_id = ?', runId)).toEqual({
      pinned: 1,
      note: 'keep',
    });
  });

  it('the sink refuses an event after the terminal event (exactly one terminal event, 02 §4.1)', () => {
    expect(() =>
      s.sink.append(runId, { type: 'run.cancelled', payload: { reason: 'user', atStepKey: null } }),
    ).toThrow(/is closed/);
  });
});

describe.each(DRIVER_NAMES)('store.rebuild-projections [%s]', (driver) => {
  let s: Store;
  let runId: string;
  beforeEach(() => {
    s = openStore(path.join(dir, 'playground.db'), { driver });
    open.push(s);
    runId = recordFixtureRun(s.sink);
  });

  it('the live projections of the fixture log are what 05 §4 says', () => {
    expect(
      s.driver.get(
        'SELECT state, outcome, failed_step_key, cause_fingerprint_id, last_seq FROM runs',
      ),
    ).toEqual({
      state: 'completed',
      outcome: 'blocked',
      failed_step_key: 'vci.token',
      cause_fingerprint_id: 'FP-35',
      last_seq: 16,
    });
    expect(
      s.driver.all(
        'SELECT step_key, ordinal, outcome, capture, exchange_count FROM steps ORDER BY ordinal',
      ),
    ).toEqual([
      { step_key: 'vci.offer', ordinal: 1, outcome: 'pass', capture: 'full', exchange_count: 1 },
      { step_key: 'vci.token', ordinal: 2, outcome: 'fail', capture: 'full', exchange_count: 1 },
      {
        step_key: 'vp.verdict.evaluate',
        ordinal: 3,
        outcome: 'skipped',
        capture: 'none',
        exchange_count: 0,
      },
    ]);
    expect(
      s.driver.all(
        'SELECT exchange_id, status, method, req_body_state, resp_body_state FROM exchanges ORDER BY exchange_id',
      ),
    ).toEqual([
      {
        exchange_id: `${runId}:1`,
        status: 200,
        method: 'GET',
        req_body_state: 'none',
        resp_body_state: 'stored',
      },
      {
        exchange_id: `${runId}:2`,
        status: 400,
        method: 'POST',
        req_body_state: 'stored',
        resp_body_state: 'stored',
      },
    ]);
    expect(s.driver.get('SELECT check_id, outcome, code FROM checks')).toEqual({
      check_id: 'chk.vci.token.code-missing',
      outcome: 'fail',
      code: 'invalid_grant',
    });
    const fpm = s.driver.get<{ offer_json: string }>('SELECT offer_json FROM fingerprint_matches');
    expect(JSON.parse(String(fpm?.offer_json))).toMatchObject({ knobId: 'KNOB-01' });
    expect(
      s.driver.all('SELECT role, component, version_label FROM run_versions ORDER BY role'),
    ).toHaveLength(3);
  });

  it('rebuild reproduces the stored projections identically', () => {
    const r = s.sink.rebuildProjections();
    expect(r).toEqual({ runs: 1, events: 16, differences: [] });
  });

  it('rebuild restores deleted / altered projection rows and keeps the lifecycle triggers', () => {
    // eslint-disable-next-line playground/sink-only-writer -- simulates a damaged projection
    s.driver.run('DELETE FROM checks WHERE run_id = ?', runId);
    s.driver.run("UPDATE steps SET outcome = 'pass' WHERE step_key = 'vci.token'");
    const dry = s.sink.rebuildProjections({ dryRun: true });
    expect(dry.differences.length).toBeGreaterThanOrEqual(3);
    expect(s.driver.get('SELECT count(*) AS n FROM checks')).toEqual({ n: 0 });
    const r = s.sink.rebuildProjections({ runId });
    expect(r.differences.length).toBe(dry.differences.length);
    expect(s.driver.get('SELECT count(*) AS n FROM checks')).toEqual({ n: 1 });
    expect(s.sink.rebuildProjections().differences).toEqual([]);
    expect(() => s.driver.run("UPDATE runs SET state = 'running' WHERE run_id = ?", runId)).toThrow(
      /terminal state is final/,
    );
  });

  it('replay re-inlines bodies and reports the stored sequence gap-free', () => {
    const events = s.reader.readEvents(runId);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    const resp = events.find((e) => e.type === 'exchange.response');
    expect(resp?.payload).toMatchObject({
      bodyState: 'stored',
      body: { encoding: 'utf8', truncated: false },
    });
  });
});
