/**
 * T-08 acceptance (plan/12) and plan/11 `events.stream`:
 *  - reconnect with Last-Event-ID delivers every seq exactly once
 *  - the terminal event is followed by `stream.end` and the stream closes
 *  - `?format=json` pages equal the SSE sequence
 *  - events are persisted before they are published (separate connection + kill test)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ErrorEnvelope, EventEnvelope, EventPage } from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import { createServer } from '../server.js';
import { openStore } from '../store/index.js';
import { openDriver } from '../store/driver.js';
import type { Store } from '../store/index.js';
import { recordFixtureRun, sampleSpec } from '../store/fixture-log.js';
import { EventBus, attachBus } from './index.js';

const flowsDir = path.join(REPO_ROOT, 'flows');
const tmp = mkdtempSync(path.join(tmpdir(), 'bff-stream-'));
const HOST = '127.0.0.1:3100';

interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
  retry?: string;
}

class SseClient {
  readonly frames: Frame[] = [];
  status = 0;
  ended = false;
  private buf = '';
  private waiters: (() => void)[] = [];
  private req: http.ClientRequest;

  constructor(port: number, url: string, headers: Record<string, string> = {}) {
    this.req = http.get(
      { host: '127.0.0.1', port, path: url, headers: { host: HOST, ...headers } },
      (res) => {
        this.status = res.statusCode ?? 0;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          this.buf += chunk;
          let i: number;
          while ((i = this.buf.indexOf('\n\n')) >= 0) {
            const block = this.buf.slice(0, i);
            this.buf = this.buf.slice(i + 2);
            const f: Frame = {};
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) f.comment = line.slice(1).trim();
              else {
                const at = line.indexOf(': ');
                const k = line.slice(0, at) as keyof Frame;
                f[k] = line.slice(at + 2);
              }
            }
            this.frames.push(f);
          }
          this.wake();
        });
        res.on('end', () => {
          this.ended = true;
          this.wake();
        });
      },
    );
    this.req.on('error', () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  async until(pred: (c: SseClient) => boolean): Promise<void> {
    while (!pred(this)) {
      if (this.ended && !pred(this))
        throw new Error(`stream ended; frames ${JSON.stringify(this.frames)}`);
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  events(): EventEnvelope[] {
    return this.frames
      .filter((f) => f.id !== undefined)
      .map((f) => JSON.parse(f.data ?? '') as EventEnvelope);
  }

  close(): void {
    this.req.destroy();
  }
}

let app: FastifyInstance;
let store: Store;
let port = 0;
const dbFile = path.join(tmp, 'playground.db');

beforeAll(async () => {
  store = openStore(dbFile, { backupDir: null });
  app = await createServer({
    config: { flowsDir, fingerprintsDir: path.join(tmp, 'fp'), uiDistDir: path.join(tmp, 'ui') },
    probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
    store,
    bus: new EventBus(),
    heartbeatMs: 25,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await app.close();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function newRunId(): string {
  n += 1;
  return `01JZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(3, '0')}`;
}

/** an open run with `k` events (run.created, run.started, steps...) */
function openRun(k: number): string {
  const runId = newRunId();
  store.sink.createSuite({
    suiteId: `${runId}S`,
    name: 's',
    triggerKind: 'ci',
    envClass: 'local',
    appVersion: '0',
  });
  store.sink.createRun({
    runId,
    suiteId: `${runId}S`,
    triggerKind: 'ci',
    flowId: 'FLOW-30',
    spec: sampleSpec(),
    knobsAllDefault: true,
    targetStepKey: 'vp.verdict.evaluate',
    evidenceTier: 'automated',
    appVersion: '0',
  });
  if (k > 1)
    store.sink.append(runId, {
      type: 'run.started',
      payload: { startedAt: '2026-10-19T00:00:00.000Z' },
    });
  for (let i = 2; i < k; i++) addEngineCall(runId, i);
  return runId;
}

function addEngineCall(runId: string, i: number): void {
  store.sink.append(runId, {
    type: 'engine.call',
    stepKey: 'vp.request.create',
    payload: {
      engine: 'playground-ts',
      op: 'deliver-request',
      inputSummary: { i },
      outputSummary: null,
      durationMs: 0,
    },
  });
}

function closeRun(runId: string): void {
  store.sink.append(runId, { type: 'run.cancelled', payload: { reason: 'user', atStepKey: null } });
}

const seqs = (evs: EventEnvelope[]): number[] => evs.map((e) => e.seq);
const range = (a: number, b: number): number[] =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('events.stream SSE (API-15, API-74)', () => {
  it('history replay of a closed run: retry, every event, then stream.end and close', async () => {
    const runId = recordFixtureRun(store.sink, { runId: newRunId() });
    const last = (store.reader.getRunRow(runId) as { last_seq: number }).last_seq;
    const c = new SseClient(port, `/api/v1/streams/${runId}/events`);
    await c.until((x) => x.ended);
    expect(c.status).toBe(200);
    expect(c.frames[0]).toEqual({ retry: '3000' });
    expect(seqs(c.events())).toEqual(range(1, last));
    expect(c.events().at(-1)?.type).toBe('run.completed');
    const end = c.frames.at(-1) as Frame;
    expect(end.event).toBe('stream.end');
    expect(end.id).toBeUndefined();
    expect(JSON.parse(end.data ?? '')).toEqual({ reason: 'terminal', lastSeq: last });
    // frame ids equal the envelope seq; event names equal the type
    for (const f of c.frames.filter((x) => x.id)) {
      const ev = JSON.parse(f.data ?? '') as EventEnvelope;
      expect(f.id).toBe(String(ev.seq));
      expect(f.event).toBe(ev.type);
    }
  });

  it('resume with Last-Event-ID or ?after= starts strictly after that seq; at the end only stream.end', async () => {
    const runId = recordFixtureRun(store.sink, { runId: newRunId() });
    const last = (store.reader.getRunRow(runId) as { last_seq: number }).last_seq;
    const a = new SseClient(port, `/api/v1/streams/${runId}/events`, { 'last-event-id': '5' });
    const b = new SseClient(port, `/api/v1/streams/${runId}/events?after=7`);
    const z = new SseClient(port, `/api/v1/streams/${runId}/events`, {
      'last-event-id': String(last),
    });
    await Promise.all([a, b, z].map((c) => c.until((x) => x.ended)));
    expect(seqs(a.events())).toEqual(range(6, last));
    expect(seqs(b.events())).toEqual(range(8, last));
    expect(z.events()).toEqual([]);
    expect(JSON.parse(z.frames.at(-1)?.data ?? '')).toEqual({ reason: 'terminal', lastSeq: last });
  });

  it('live tail with reconnects delivers every seq exactly once, then stream.end', async () => {
    const runId = openRun(3);
    const got: EventEnvelope[] = [];
    let c = new SseClient(port, `/api/v1/streams/${runId}/events`);
    await c.until((x) => x.events().length === 3);
    for (let i = 3; i < 6; i++) addEngineCall(runId, i);
    await c.until((x) => x.events().length === 6);
    got.push(...c.events());
    c.close();
    // events written while no client is connected, and while the next one connects
    for (let i = 6; i < 9; i++) addEngineCall(runId, i);
    c = new SseClient(port, `/api/v1/streams/${runId}/events`, {
      'last-event-id': String(got.at(-1)?.seq),
    });
    for (let i = 9; i < 12; i++) addEngineCall(runId, i);
    await c.until((x) => x.events().length === 6);
    got.push(...c.events());
    c.close();
    c = new SseClient(port, `/api/v1/streams/${runId}/events`, {
      'last-event-id': String(got.at(-1)?.seq),
    });
    await c.until((x) => x.frames.length >= 1);
    closeRun(runId);
    await c.until((x) => x.ended);
    got.push(...c.events());
    expect(seqs(got)).toEqual(range(1, 13));
    expect(got.at(-1)?.type).toBe('run.cancelled');
    expect(c.frames.at(-1)?.event).toBe('stream.end');
  });

  it('sends a heartbeat comment on an idle stream', async () => {
    const runId = openRun(2);
    const c = new SseClient(port, `/api/v1/streams/${runId}/events`);
    await c.until((x) => x.frames.some((f) => f.comment === 'hb'));
    c.close();
    closeRun(runId);
  });

  it('errors: unknown run 404, bad id / query 400 (envelope, not SSE)', async () => {
    const H = { host: HOST };
    const nf = await app.inject({
      method: 'GET',
      url: '/api/v1/streams/01JZZZZZZZZZZZZZZZZZZZZZZZ/events',
      headers: H,
    });
    expect(nf.json<ErrorEnvelope>().error.code).toBe('not_found');
    for (const url of [
      '/api/v1/streams/nope/events',
      `/api/v1/streams/env/events?after=-1`,
      '/api/v1/streams/env/events?bogus=1',
      '/api/v1/streams/env/events?format=json&limit=1001',
    ]) {
      const r = await app.inject({ method: 'GET', url, headers: H });
      expect(r.statusCode, url).toBe(400);
      expect(r.json<ErrorEnvelope>().error.code).toBe('validation_failed');
    }
  });
});

describe('events.stream JSON pages (?format=json)', () => {
  it('pages equal the SSE sequence; the last page is closed', async () => {
    const runId = recordFixtureRun(store.sink, { runId: newRunId() });
    const c = new SseClient(port, `/api/v1/streams/${runId}/events`);
    await c.until((x) => x.ended);
    const paged: EventEnvelope[] = [];
    let after = 0;
    let closed = false;
    for (let i = 0; i < 50 && !closed; i++) {
      const r = await app.inject({
        method: 'GET',
        url: `/api/v1/streams/${runId}/events?format=json&limit=3&after=${after}`,
        headers: { host: HOST },
      });
      const page = r.json<EventPage>();
      expect(page.streamId).toBe(runId);
      paged.push(...page.events);
      closed = page.closed;
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    expect(closed).toBe(true);
    expect(paged).toEqual(c.events());
  });

  it('an open run pages to nextAfter null and closed false; ?type filters', async () => {
    const runId = openRun(4);
    const page = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/streams/${runId}/events?format=json`,
        headers: { host: HOST },
      })
    ).json<EventPage>();
    expect(seqs(page.events)).toEqual([1, 2, 3, 4]);
    expect(page).toMatchObject({ nextAfter: null, closed: false });
    const only = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/streams/${runId}/events?format=json&type=engine.call`,
        headers: { host: HOST },
      })
    ).json<EventPage>();
    expect(only.events.map((e) => e.type)).toEqual(['engine.call', 'engine.call']);
    closeRun(runId);
  });
});

describe('events.stream env and unattributed streams', () => {
  it('env events and unattributed exchanges are replayed and published', async () => {
    const env = new SseClient(port, '/api/v1/streams/env/events');
    const un = new SseClient(port, '/api/v1/streams/unattributed/events');
    await Promise.all([env, un].map((c) => c.until((x) => x.frames.length >= 1)));
    store.sink.appendEnv('env.ready', { upstreams: ['certify-preauth'] });
    store.sink.appendUnattributed({
      port: 443,
      actor: 'unknown',
      counterpart: 'certify-preauth',
      method: 'GET',
      url: 'https://h/.well-known/did.json',
      status: 200,
      requestHeaders: [['accept', '*/*']],
      responseHeaders: [['content-type', 'application/json']],
      requestBody: null,
      responseBody: { bytes: '{"id":"did:web:h"}', contentType: 'application/json' },
      durationMs: 3,
    });
    await env.until((x) => x.events().length >= 1);
    await un.until((x) => x.events().length >= 2);
    expect(env.events().at(-1)).toMatchObject({
      runId: 'env',
      type: 'env.ready',
      payload: { upstreams: ['certify-preauth'] },
    });
    const [rq, rs] = un.events().slice(-2);
    expect(rq).toMatchObject({
      type: 'exchange.request',
      payload: { direction: 'inbound', method: 'GET' },
    });
    expect(rs).toMatchObject({
      type: 'exchange.response',
      seq: (rq?.seq ?? 0) + 1,
      payload: { status: 200, body: { text: '{"id":"did:web:h"}' } },
    });
    env.close();
    un.close();
    const page = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/streams/unattributed/events?format=json',
        headers: { host: HOST },
      })
    ).json<EventPage>();
    expect(page.events.slice(-2)).toEqual([rq, rs]);
  });
});

describe('events.stream persist-before-publish', () => {
  it('every published event is already committed (seen by a second connection)', async () => {
    const reader = openDriver(dbFile);
    try {
      const runId = openRun(2);
      const bus = new EventBus();
      const s2 = openStore(dbFile, { backupDir: null });
      attachBus(s2, bus);
      const sub = bus.subscribe(`run:${runId}`, 2);
      const seen: number[] = [];
      const reading = (async () => {
        for await (const ev of sub) {
          const row = reader.get(
            'SELECT seq FROM run_events WHERE run_id = ? AND seq = ?',
            runId,
            ev.seq,
          );
          expect(row).toBeDefined();
          seen.push(ev.seq);
          if (seen.length === 5) sub.close();
        }
      })();
      for (let i = 0; i < 5; i++)
        s2.sink.append(runId, {
          type: 'engine.call',
          stepKey: 'x',
          payload: {
            engine: 'playground-ts',
            op: 'cancelled',
            inputSummary: i,
            outputSummary: null,
            durationMs: 0,
          },
        });
      await reading;
      expect(seen).toEqual([3, 4, 5, 6, 7]);
      // a write that fails (closed log) publishes nothing
      s2.sink.append(runId, {
        type: 'run.cancelled',
        payload: { reason: 'user', atStepKey: null },
      });
      const late = bus.subscribe(`run:${runId}`, 8);
      expect(() =>
        s2.sink.append(runId, { type: 'run.started', payload: { startedAt: 'x' } }),
      ).toThrow();
      late.close();
      expect(bus.subscriberCount()).toBe(0);
      s2.close();
    } finally {
      reader.close();
    }
  });

  it('kill test: a SIGKILLed writer never published an event the file does not hold', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bff-kill-'));
    const file = path.join(dir, 'kill.db');
    const src = path.join(REPO_ROOT, 'apps/bff/src');
    const script = path.join(dir, 'writer.ts');
    writeFileSync(
      script,
      `import { openStore } from ${JSON.stringify(pathToFileURL(path.join(src, 'store/index.ts')).href)};
import { sampleSpec } from ${JSON.stringify(pathToFileURL(path.join(src, 'store/fixture-log.ts')).href)};
import { EventBus, attachBus } from ${JSON.stringify(pathToFileURL(path.join(src, 'stream/index.ts')).href)};
const store = openStore(${JSON.stringify(file)}, { backupDir: null });
const bus = new EventBus();
attachBus(store, bus);
const runId = '01JZZZZZZZZZZZZZZZZZZZZKIL';
store.sink.createSuite({ suiteId: 'S', name: 's', triggerKind: 'ci', envClass: 'local', appVersion: '0' });
const sub = bus.subscribe('run:' + runId, 0);
void (async () => { for await (const ev of sub) process.stdout.write(ev.seq + '\\n'); })();
store.sink.createRun({ runId, suiteId: 'S', triggerKind: 'ci', flowId: 'FLOW-30', spec: sampleSpec(), knobsAllDefault: true, targetStepKey: 'vp.verdict.evaluate', evidenceTier: 'automated', appVersion: '0' });
let i = 0;
const tick = () => {
  for (let k = 0; k < 20; k++) store.sink.append(runId, { type: 'engine.call', stepKey: 'x', payload: { engine: 'playground-ts', op: 'cancelled', inputSummary: i++, outputSummary: null, durationMs: 0 } });
  setImmediate(tick);
};
tick();
`,
    );
    try {
      const child = spawn(process.execPath, ['--import', 'tsx', script], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const published: number[] = [];
      let err = '';
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      await new Promise<void>((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (d: Buffer) => {
          buf += d.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const l of lines) published.push(Number(l));
          if (published.length >= 200 && !child.killed) {
            child.kill('SIGKILL');
            resolve();
          }
        });
        child.on('exit', (code) =>
          code === null ? resolve() : reject(new Error(`writer exited ${code}: ${err}`)),
        );
      });
      await new Promise<void>((r) =>
        child.exitCode !== null || child.signalCode !== null ? r() : child.on('exit', () => r()),
      );
      const db = openDriver(file);
      try {
        const max =
          db.get<{ m: number }>(
            "SELECT max(seq) AS m FROM run_events WHERE run_id = '01JZZZZZZZZZZZZZZZZZZZZKIL'",
          )?.m ?? 0;
        expect(published.length).toBeGreaterThanOrEqual(200);
        expect(Math.max(...published)).toBeLessThanOrEqual(max);
        expect(published).toEqual(range(1, published.length));
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
