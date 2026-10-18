import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleSpec } from './fixture-log.js';
import { DRIVER_NAMES, LIMITS, openStore, type SinkEvent, type Store } from './index.js';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
let dir: string;
let s: Store;
const RUN = '01JZZZZZZZZZZZZZZZZZZZZZZ9';

function newRun(store: Store, runId = RUN): void {
  store.sink.createSuite({
    suiteId: 'S',
    name: 's',
    triggerKind: 'ci',
    envClass: 'local',
    appVersion: '0',
  });
  store.sink.createRun({
    runId,
    suiteId: 'S',
    triggerKind: 'ci',
    flowId: 'FLOW-01',
    spec: sampleSpec(),
    knobsAllDefault: true,
    targetStepKey: 'vci.credential',
    evidenceTier: 'automated',
    appVersion: '0',
  });
}
function req(
  body: string | Buffer | null,
  over: Partial<{ url: string; headers: [string, string][]; ct: string }> = {},
): SinkEvent {
  return {
    type: 'exchange.request',
    stepKey: 'vci.credential',
    payload: {
      exchangeId: s.sink.nextExchangeId(RUN),
      direction: 'outbound',
      actor: 'wallet.playground-ts',
      counterpart: 'certify-preauth',
      method: 'POST',
      url: over.url ?? 'https://192.0.2.10/credential',
      headers: over.headers ?? [['Content-Type', over.ct ?? 'application/json']],
      body: body === null ? null : { bytes: body, contentType: over.ct ?? 'application/json' },
      poll: null,
    },
  };
}
const startStep = () =>
  s.sink.append(RUN, {
    type: 'step.started',
    stepKey: 'vci.credential',
    payload: { flowId: 'FLOW-01', order: 1, kind: 'http', label: 'credential' },
  });
const completeStep = () =>
  s.sink.append(RUN, {
    type: 'step.completed',
    stepKey: 'vci.credential',
    payload: {
      outcome: 'pass',
      capture: 'full',
      skipReason: null,
      coverageNote: null,
      durationMs: 1,
    },
  });

/** 05 §5: one test per limit; ADR-37 */
describe.each(DRIVER_NAMES)('capture.caps [%s]', (driver) => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pg-sink-'));
    s = openStore(path.join(dir, 'playground.db'), { driver });
    s.driver.exec('PRAGMA synchronous=OFF'); // test speed only; production keeps FULL (05 §1)
    newRun(s);
    startStep();
  });
  afterEach(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a body over 256 KiB is truncated; the original size and the full-body SHA-256 are kept', () => {
    const body = 'a'.repeat(300 * 1024);
    const ev = s.sink.append(RUN, req(body));
    const row = s.driver.get<{
      req_size: number;
      req_truncated: number;
      req_body_state: string;
      req_blob_sha: string;
      req_headers_json: string;
    }>(
      'SELECT req_size, req_truncated, req_body_state, req_blob_sha, req_headers_json FROM exchanges',
    );
    expect(row).toMatchObject({
      req_size: 300 * 1024,
      req_truncated: 1,
      req_body_state: 'truncated',
    });
    expect(JSON.parse(String(row?.req_headers_json))).toContainEqual([
      'x-playground-body-sha256',
      sha(body),
    ]);
    expect(s.reader.getBlob(String(row?.req_blob_sha))?.length).toBe(LIMITS.bodyBytes);
    expect(ev?.payload).toMatchObject({
      bodyState: 'stored',
      body: { size: 300 * 1024, truncated: true, sha256: sha(body) },
    });
  });

  it('a body inlined in an event is cut at 64 KiB; the stored body is untouched', () => {
    const body = 'b'.repeat(100 * 1024);
    const live = s.sink.append(RUN, req(body))?.payload as {
      body: { text: string; truncated: boolean; size: number };
    };
    expect(live.body.text.length).toBe(LIMITS.wireInlineBytes);
    expect(live.body).toMatchObject({ truncated: true, size: 100 * 1024 });
    const replayed = s.reader.readEvents(RUN).find((e) => e.type === 'exchange.request')
      ?.payload as typeof live;
    expect(replayed.body).toEqual(live.body);
    const row = s.driver.get<{ req_blob_sha: string; req_truncated: number }>(
      'SELECT req_blob_sha, req_truncated FROM exchanges',
    );
    expect(row?.req_truncated).toBe(0);
    expect(s.reader.getBlob(String(row?.req_blob_sha))?.length).toBe(100 * 1024);
  });

  it('bodies of 2 KiB and more are never inline in run_events; blobs ≥ 1 KiB are gzip, smaller identity', () => {
    s.sink.append(RUN, req('c'.repeat(4096)));
    s.sink.append(RUN, req('{"small":true}'));
    const payloads = s.driver.all<{ payload_json: string }>(
      "SELECT payload_json FROM run_events WHERE type = 'exchange.request'",
    );
    for (const p of payloads) {
      expect(p.payload_json.length).toBeLessThan(2048);
      expect((JSON.parse(p.payload_json) as { body: unknown }).body).toHaveProperty('$blob');
    }
    expect(s.driver.all('SELECT enc, raw_size FROM blobs ORDER BY raw_size')).toEqual([
      { enc: 'identity', raw_size: 14 },
      { enc: 'gzip', raw_size: 4096 },
    ]);
  });

  it('4,000 events per run: further exchange.* dropped, lifecycle/step/check events still written, step partial', () => {
    let seq = Number(s.driver.get<{ n: number }>('SELECT last_seq AS n FROM runs')?.n);
    while (seq < LIMITS.eventsPerRun) {
      seq = Number(
        s.sink.append(RUN, {
          type: 'engine.call',
          stepKey: 'vci.credential',
          payload: {
            engine: 'playground-ts',
            op: 'sign-proof',
            inputSummary: null,
            outputSummary: null,
            durationMs: 0,
          },
        })?.seq,
      );
    }
    expect(s.sink.append(RUN, req('{}'))).toBeNull();
    const check = s.sink.append(RUN, {
      type: 'verdict.check',
      stepKey: 'vci.credential',
      payload: { check: { checkId: 'x', outcome: 'pass', source: 'engine', exchangeIds: [] } },
    });
    expect(check?.seq).toBe(LIMITS.eventsPerRun + 1);
    const done = completeStep();
    expect(done?.payload).toMatchObject({ capture: 'partial' });
    expect(s.driver.get('SELECT capture FROM steps')).toEqual({ capture: 'partial' });
    expect(s.driver.get('SELECT capture_limited FROM runs')).toEqual({ capture_limited: 1 });
    expect(s.driver.get('SELECT count(*) AS n FROM exchanges')).toEqual({ n: 0 });
    expect(s.sink.rebuildProjections().differences).toEqual([]);
  });

  it('24 MiB of bodies per run: further bodies dropped_run_cap, metadata kept, step partial', () => {
    const per = LIMITS.bodyBytes;
    const fit = LIMITS.bodyBytesPerRun / per;
    const body = Buffer.alloc(per, 7);
    for (let i = 0; i < fit; i++) s.sink.append(RUN, req(body, { ct: 'application/octet-stream' }));
    const over = s.sink.append(RUN, req(body, { ct: 'application/octet-stream' }));
    expect(over?.payload).toMatchObject({ body: null, bodyState: 'dropped_run_cap' });
    expect(
      s.driver.get("SELECT count(*) AS n FROM exchanges WHERE req_body_state = 'dropped_run_cap'"),
    ).toEqual({ n: 1 });
    expect(s.driver.get('SELECT count(*) AS n FROM exchanges')).toEqual({ n: fit + 1 });
    completeStep();
    expect(s.driver.get('SELECT capture FROM steps')).toEqual({ capture: 'partial' });
    expect(s.driver.get('SELECT capture_limited FROM runs')).toEqual({ capture_limited: 1 });
    expect(s.driver.get('SELECT count(*) AS n FROM blobs')).toEqual({ n: 1 }); // content-addressed
  });

  it('header value 8 KiB, headers 32 KiB, URL 8 KiB: cut with …, names lowercased', () => {
    const long = 'h'.repeat(10_000);
    const many: [string, string][] = Array.from({ length: 10 }, (_, i) => [`X-H${i}`, long]);
    s.sink.append(
      RUN,
      req(null, { url: `https://192.0.2.10/p?q=${'u'.repeat(10_000)}`, headers: many }),
    );
    const row = s.driver.get<{ url: string; req_headers_json: string }>(
      'SELECT url, req_headers_json FROM exchanges',
    );
    expect(row?.url.length).toBe(LIMITS.urlChars);
    expect(row?.url.startsWith('https://192.0.2.10/p?q=')).toBe(true);
    expect(row?.url.endsWith('…')).toBe(true);
    const headers = JSON.parse(String(row?.req_headers_json)) as [string, string][];
    expect(String(row?.req_headers_json).length).toBeLessThanOrEqual(LIMITS.headersTotalChars);
    expect(headers[0]?.[0]).toBe('x-h0');
    expect(headers[0]?.[1].length).toBe(LIMITS.headerValueChars);
    expect(headers[0]?.[1].endsWith('…')).toBe(true);
  });

  it('checks.message is cut at 4 KiB; payload JSON over 64 KiB is cut and flagged', () => {
    s.sink.append(RUN, {
      type: 'verdict.check',
      stepKey: 'vci.credential',
      payload: {
        check: {
          checkId: 'm',
          outcome: 'fail',
          source: 'engine',
          message: 'm'.repeat(5000),
          exchangeIds: [],
        },
      },
    });
    const msg = s.driver.get<{ message: string }>('SELECT message FROM checks');
    expect(msg?.message.length).toBe(LIMITS.checkMessageChars);
    const ex = s.sink.append(RUN, {
      type: 'engine.exception',
      stepKey: 'vci.credential',
      payload: {
        engine: 'credo',
        exceptionClass: 'E',
        message: 'e'.repeat(100_000),
        endedStep: true,
      },
    });
    const stored = s.driver.get<{ payload_json: string }>(
      'SELECT payload_json FROM run_events WHERE seq = ?',
      Number(ex?.seq),
    );
    expect(stored?.payload_json.length).toBeLessThanOrEqual(LIMITS.payloadJsonChars);
    expect(JSON.parse(String(stored?.payload_json))).toMatchObject({
      truncated: true,
      exceptionClass: 'E',
    });
  });

  it('engine.call summaries are cut to 16 KiB of JSON text', () => {
    const ev = s.sink.append(RUN, {
      type: 'engine.call',
      stepKey: 'vci.credential',
      payload: {
        engine: 'credo',
        op: 'verify',
        inputSummary: { big: 's'.repeat(20_000) },
        outputSummary: { ok: true },
        durationMs: 1,
      },
    });
    const p = ev?.payload as { inputSummary: string; outputSummary: unknown };
    expect(typeof p.inputSummary).toBe('string');
    expect(p.inputSummary.length).toBe(LIMITS.summaryJsonChars);
    expect(p.outputSummary).toEqual({ ok: true });
  });

  it('an artifact over 1 MiB is not stored and downgrades the step to partial', () => {
    expect(
      s.sink.putArtifact(RUN, {
        stepKey: 'vci.credential',
        kind: 'credential',
        contentType: 'application/json',
        bytes: 'x'.repeat(LIMITS.artifactBytes + 1),
      }),
    ).toBeNull();
    const ok = s.sink.putArtifact(RUN, {
      stepKey: 'vci.credential',
      kind: 'tamper-before',
      contentType: 'application/jwt',
      bytes: 'eyJ.x.y',
      tmpId: 'TMP-04',
    });
    expect(ok).toBe(`${RUN}:a1`);
    expect(s.driver.get('SELECT tier, size FROM artifacts')).toEqual({ tier: 'light', size: 7 });
    completeStep();
    expect(s.driver.get('SELECT capture FROM steps')).toEqual({ capture: 'partial' });
  });

  it('a RunSpec over 16 KiB is refused (spec_too_large)', () => {
    expect(() =>
      s.sink.createRun({
        runId: '01JZZZZZZZZZZZZZZZZZZZZZZ8',
        suiteId: 'S',
        triggerKind: 'ci',
        flowId: 'FLOW-01',
        spec: sampleSpec({ configurationId: 'c'.repeat(17_000) }),
        knobsAllDefault: true,
        targetStepKey: 'x',
        evidenceTier: 'automated',
        appVersion: '0',
      }),
    ).toThrow(/cap 16 KiB/);
  });

  it('binary bodies are stored raw and inlined as base64', () => {
    const bin = Buffer.from([0xff, 0x00, 0xa1, 0x18]);
    const ev = s.sink.append(RUN, req(bin, { ct: 'application/cbor' }));
    expect(ev?.payload).toMatchObject({
      body: { encoding: 'base64', text: bin.toString('base64'), size: 4 },
    });
  });
});
