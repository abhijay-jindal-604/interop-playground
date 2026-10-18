import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordFixtureRun } from '../store/fixture-log.js';
import { DRIVER_NAMES, EventSink, openStore, type Store } from '../store/index.js';
import { storeCommands } from '../cli/store-commands.js';
import { loadRegistry, marker, parseEnvFile, SecretRegistry } from './registry.js';
import { scanStore } from './scan.js';

// generated per test run, never committed (plan/11 §2 "Secrets in tests")
const TUNNEL = `tun-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const UIN = '5823749106';
const OTP = '381925';
const KEYSTORE = Buffer.from(`ks-${Date.now()}`).toString('base64url');
const registry = () =>
  new SecretRegistry()
    .add('TUNNEL_TOKEN', TUNNEL)
    .add('COLLAB_ESIGNET_MOCK_UIN', UIN)
    .add('COLLAB_ESIGNET_MOCK_OTP', OTP)
    .add('ESIGNET_KEYSTORE_PASSWORD', KEYSTORE);

describe('redact.registry', () => {
  it('replaces every registry value by «redacted:<NAME>» in its plain, URL, JSON and base64 forms', () => {
    const r = registry();
    expect(r.redactString(`a ${TUNNEL} b`)).toBe(`a ${marker('TUNNEL_TOKEN')} b`);
    expect(r.redactString(`otp=${OTP}&uin=${UIN}`)).toBe(
      `otp=${marker('COLLAB_ESIGNET_MOCK_OTP')}&uin=${marker('COLLAB_ESIGNET_MOCK_UIN')}`,
    );
    expect(r.redactString(Buffer.from(TUNNEL).toString('base64'))).toBe(marker('TUNNEL_TOKEN'));
    const bytes = r.redactBytes(Buffer.from(`\x00\x01${OTP}\x02`, 'latin1'));
    expect(bytes.includes(Buffer.from(OTP))).toBe(false);
    expect(r.redactDeep({ h: [['x', TUNNEL]], n: 3 })).toEqual({
      h: [['x', marker('TUNNEL_TOKEN')]],
      n: 3,
    });
  });

  it('leaves protocol test material untouched (REQ-24)', () => {
    const r = registry();
    const material =
      'eyJhbGciOiJFUzI1NiJ9.eyJjX25vbmNlIjoiYWJjIn0.sig pre-authorized_code=abc c_nonce=n0nce';
    expect(r.redactString(material)).toBe(material);
  });

  it('rejects registry values shorter than 4 characters', () => {
    expect(() => new SecretRegistry().add('X', 'abc')).toThrow(/shorter than 4/);
  });

  it('loads the registry from env files and the admin token file; empty values are skipped', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'pg-reg-'));
    try {
      writeFileSync(
        path.join(d, '.env'),
        `# c\nTUNNEL_TOKEN="${TUNNEL}"\nCOLLAB_ESIGNET_MOCK_OTP=\nPUBLIC_HOST=192.0.2.10\n`,
      );
      writeFileSync(path.join(d, 'tok'), `${KEYSTORE}xyz\n`);
      const r = loadRegistry({
        envFiles: [path.join(d, '.env')],
        adminTokenFile: path.join(d, 'tok'),
      });
      expect(
        r
          .values()
          .map((v) => v.name)
          .sort(),
      ).toEqual(['BFF_ADMIN_TOKEN', 'TUNNEL_TOKEN']);
      expect(parseEnvFile('export A=1\nB = "two"')).toEqual({ A: '1', B: 'two' });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe.each(DRIVER_NAMES)('redact.registry scan-store [%s]', (driver) => {
  let dir: string;
  let s: Store;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pg-scan-'));
  });
  afterEach(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('after a fixture run with registry secrets injected into bodies, URLs, headers, messages: zero hits', () => {
    s = openStore(path.join(dir, 'playground.db'), { driver, registry: registry() });
    const runId = recordFixtureRun(s.sink, {
      inject: [TUNNEL, UIN, OTP, KEYSTORE, Buffer.from(TUNNEL).toString('base64')],
    });
    s.sink.putArtifact(runId, {
      stepKey: 'vci.token',
      kind: 'token',
      contentType: 'application/json',
      bytes: JSON.stringify({ t: TUNNEL }),
    });
    expect(scanStore(s.driver, registry())).toEqual([]);
    // the markers are what is stored instead
    const body = s.driver.get<{ n: number }>(
      "SELECT count(*) AS n FROM checks WHERE message LIKE '%«redacted:TUNNEL_TOKEN»%'",
    );
    expect(body).toEqual({ n: 1 });
  });

  it('finds a secret that bypassed redaction (plain, base64, inside a gzip blob) and a PEM key', () => {
    s = openStore(path.join(dir, 'playground.db'), { driver }); // empty registry: nothing redacted
    recordFixtureRun(s.sink, { inject: [TUNNEL, Buffer.from(OTP).toString('base64')] });
    s.sink.appendEnv('env.probe', {
      upstream: 'x',
      ok: false,
      // built in memory, never a committed PEM string (plan/11 §2)
      detail: ['-----BEGIN', 'EC', 'PRIVATE', 'KEY-----'].join(' '),
      versionFingerprint: null,
    });
    const hits = scanStore(s.driver, registry());
    const where = new Set(hits.map((h) => `${h.table}.${h.column}:${h.secret}:${h.form}`));
    expect(where).toContain('run_events.payload_json:TUNNEL_TOKEN:plain');
    expect(where).toContain('blobs.data:TUNNEL_TOKEN:plain');
    expect(where).toContain('checks.message:COLLAB_ESIGNET_MOCK_OTP:base64');
    expect(where).toContain('env_events.payload_json:PEM_PRIVATE_KEY:pem');
    expect(JSON.stringify(hits)).not.toContain(TUNNEL);
  });

  it('`playground store scan-store` exits 0 on a clean DB and 1 with hits', async () => {
    const db = path.join(dir, 'playground.db');
    s = openStore(db, { driver, registry: registry() });
    recordFixtureRun(s.sink, { inject: [TUNNEL] });
    const env = path.join(dir, '.env');
    writeFileSync(env, `TUNNEL_TOKEN=${TUNNEL}\n`);
    const scan = storeCommands['store scan-store'];
    expect(scan).toBeDefined();
    const out: string[] = [];
    const write = (c: string | Uint8Array) => (out.push(String(c)), true);
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = write;
    // one SQLite copy per process: two libraries in one process do not share POSIX locks
    const prevDriver = process.env.PLAYGROUND_DB_DRIVER;
    process.env.PLAYGROUND_DB_DRIVER = driver;
    try {
      expect(await scan!(['--db', db, '--registry-env', env, '--no-process-env'])).toBe(0);
      // a sink without the registry writes the secret in clear
      recordFixtureRun(new EventSink(s.driver), {
        runId: '01JZZZZZZZZZZZZZZZZZZZZZZ2',
        inject: [TUNNEL],
      });
      expect(await scan!(['--db', db, '--registry-env', env, '--no-process-env'])).toBe(1);
    } finally {
      process.stdout.write = orig;
      if (prevDriver === undefined) delete process.env.PLAYGROUND_DB_DRIVER;
      else process.env.PLAYGROUND_DB_DRIVER = prevDriver;
    }
    expect(out.join('')).not.toContain(TUNNEL);
  });
});
