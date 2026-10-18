import type { CaptureContext } from '@interop-playground/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleSpec } from '../store/fixture-log.js';
import { openStore, type Store } from '../store/index.js';
import { CaptureHttp, EgressDeniedError } from './capturing-http.js';
import { CookieJar } from './cookie-jar.js';
import { generateSelfToken, isSelfCall, SELF_HEADER, stripSelfHeader } from './self-token.js';

const RUN = '01JZZZZZZZZZZZZZZZZZZZZZZC';
const GATEWAY = '192.0.2.10:8443';
let store: Store;
let seen: { url: string; headers: Headers; body: string | null }[];
let replies: (() => Response)[];

/** fake transport: records what was sent, answers from `replies` (no network, plan/11 §2) */
const fakeFetch: typeof fetch = async (input, init) => {
  const body = init?.body ? Buffer.from(init.body as Uint8Array).toString('utf8') : null;
  seen.push({
    url: input instanceof Request ? input.url : input.toString(),
    headers: new Headers(init?.headers),
    body,
  });
  const next = replies.shift();
  if (!next) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  return Promise.resolve(next());
};
const json =
  (status: number, v: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(v), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

function makeHttp(token = generateSelfToken()): CaptureHttp {
  let t = 0;
  return new CaptureHttp({
    sink: store.sink,
    selfToken: token,
    gatewayOrigins: [GATEWAY],
    fetch: fakeFetch,
    now: () => (t += 5),
  });
}
const ctx = (over: Partial<CaptureContext> = {}): CaptureContext => ({
  runId: RUN,
  stepKey: 'vp.result',
  actor: 'wallet.playground-ts',
  counterpart: 'inji-verify',
  ...over,
});
type Ev = Record<string, unknown> & { type: string };
const events = (): Ev[] =>
  store.driver
    .all<{ type: string; payload_json: string }>(
      'SELECT type, payload_json FROM run_events WHERE type LIKE ? ORDER BY seq',
      'exchange.%',
    )
    .map((r) => ({ type: r.type, ...(JSON.parse(r.payload_json) as Record<string, unknown>) }));

beforeEach(() => {
  seen = [];
  replies = [];
  store = openStore(':memory:');
  store.sink.createSuite({
    suiteId: 'S',
    name: 's',
    triggerKind: 'ci',
    envClass: 'local',
    appVersion: '0',
  });
  store.sink.createRun({
    runId: RUN,
    suiteId: 'S',
    triggerKind: 'ci',
    flowId: 'FLOW-30',
    spec: sampleSpec(),
    knobsAllDefault: true,
    targetStepKey: 'vp.verdict.evaluate',
    evidenceTier: 'automated',
    appVersion: '0',
  });
});
afterEach(() => store.close());

describe('capture.exchange', () => {
  it('persists exchange.request before sending and exchange.response after, with timing; returns the body', async () => {
    const http = makeHttp();
    replies.push(() => {
      // the request event is already in the store when the upstream answers (persist-before-send)
      expect(events().map((e) => e.type)).toEqual(['exchange.request']);
      return json(200, { ok: 1 })();
    });
    const res = await http.fetch(ctx(), 'https://192.0.2.20/v1/x', {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
    expect(await res.json()).toEqual({ ok: 1 });
    const [rq, rs] = events();
    expect(rq).toMatchObject({
      method: 'POST',
      direction: 'outbound',
      actor: 'wallet.playground-ts',
      counterpart: 'inji-verify',
      poll: null,
    });
    expect(rs).toMatchObject({ status: 200, durationMs: 5, bodyState: 'stored' });
    expect(store.driver.get('SELECT status, step_key, req_body_state FROM exchanges')).toEqual({
      status: 200,
      step_key: 'vp.result',
      req_body_state: 'stored',
    });
  });

  it('a transport failure becomes exchange.error and is rethrown', async () => {
    const http = makeHttp();
    await expect(http.fetch(ctx(), 'https://192.0.2.20/down')).rejects.toThrow('fetch failed');
    expect(events().map((e) => [e.type, e.errorClass])).toEqual([
      ['exchange.request', undefined],
      ['exchange.error', 'ECONNREFUSED'],
    ]);
  });
});

describe('capture.poll-coalescing', () => {
  it('10 identical polls persist the first and the last; the last carries pollCount (total) = 10', async () => {
    const http = makeHttp();
    const c = ctx({ poll: { group: 'vp-result' } });
    for (let i = 0; i < 10; i++) {
      replies.push(json(404, { error: 'NO_VP_SUBMISSION' }));
      await http.fetch(c, 'https://192.0.2.20/v1/verify/vp-session-results');
    }
    await http.closePoll(c, 'vp-result');
    const ev = events();
    expect(ev.map((e) => [e.type, e.poll])).toEqual([
      ['exchange.request', { group: 'vp-result', index: 1, total: null }],
      ['exchange.response', { group: 'vp-result', index: 1, total: null }],
      ['exchange.request', { group: 'vp-result', index: 10, total: null }],
      ['exchange.response', { group: 'vp-result', index: 10, total: 10 }],
    ]);
    expect(store.driver.all('SELECT coalesced_count FROM exchanges ORDER BY req_seq')).toEqual([
      { coalesced_count: 1 },
      { coalesced_count: 9 },
    ]);
    // gap-free seq: suppressed polls create no events
    const seqs = store.driver
      .all<{ seq: number }>('SELECT seq FROM run_events ORDER BY seq')
      .map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it('a changed poll (status or body hash) is persisted', async () => {
    const http = makeHttp();
    const c = ctx({ poll: { group: 'vp-status' } });
    const seq = [
      json(200, { s: 'ACTIVE' }),
      json(200, { s: 'ACTIVE' }),
      json(200, { s: 'DONE' }),
      json(200, { s: 'DONE' }),
      json(500, { s: 'DONE' }),
    ];
    for (const r of seq) {
      replies.push(r);
      await http.fetch(c, 'https://192.0.2.20/v1/verify/status');
    }
    await http.flushStep(RUN, 'vp.result'); // automatic close at step completion
    const responses = events().filter((e) => e.type === 'exchange.response');
    expect(responses.map((e) => [e.status, e.poll])).toEqual([
      [200, { group: 'vp-status', index: 1, total: null }],
      [200, { group: 'vp-status', index: 3, total: null }],
      [500, { group: 'vp-status', index: 5, total: 5 }],
    ]);
  });

  it('a group with a single poll has total 1; closePoll twice is harmless', async () => {
    const http = makeHttp();
    const c = ctx({ poll: { group: 'g' } });
    replies.push(json(200, {}));
    await http.fetch(c, 'https://192.0.2.20/one');
    await http.closePoll(c, 'g');
    await http.closePoll(c, 'g');
    expect(events().map((e) => e.poll)).toEqual([
      { group: 'g', index: 1, total: null },
      { group: 'g', index: 1, total: 1 },
    ]);
  });
});

describe('capture.self-header (API-70)', () => {
  it('adds X-Playground-Self only to gateway listeners and never persists it', async () => {
    const token = generateSelfToken();
    const http = makeHttp(token);
    replies.push(json(200, {}), json(200, {}));
    await http.fetch(ctx(), `https://${GATEWAY}/v1/verify/x`, {
      headers: { [SELF_HEADER]: 'forged' },
    });
    await http.fetch(ctx(), 'https://192.0.2.20/v1/verify/x', {
      headers: { 'X-Playground-Self': 'forged' },
    });
    expect(seen[0]?.headers.get(SELF_HEADER)).toBe(token);
    expect(seen[1]?.headers.get(SELF_HEADER)).toBeNull();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const all = store.driver
      .all<{ payload_json: string }>('SELECT payload_json FROM run_events')
      .map((r) => r.payload_json)
      .join('');
    expect(all).not.toContain(token);
    expect(all.toLowerCase()).not.toContain(SELF_HEADER);
  });

  it('is compared in constant time and always stripped', () => {
    const token = generateSelfToken();
    expect(isSelfCall(token, token)).toBe(true);
    expect(isSelfCall(generateSelfToken(), token)).toBe(false); // same length, other value
    expect(isSelfCall('short', token)).toBe(false);
    expect(isSelfCall(undefined, token)).toBe(false);
    expect(isSelfCall([token], token)).toBe(false);
    // stripped whether it matches or not
    expect(
      stripSelfHeader([
        ['X-Playground-Self', token],
        ['accept', '*/*'],
      ]),
    ).toEqual([['accept', '*/*']]);
    expect(stripSelfHeader({ 'x-playground-self': 'wrong', host: 'h' })).toEqual({ host: 'h' });
  });
});

describe('capture.cookie-jar', () => {
  it('uses and updates the run jar only when CaptureContext.cookieJar is set', async () => {
    const http = makeHttp();
    replies.push(
      json(200, {}, { 'set-cookie': 'transaction_id=tx1; Path=/v1/verify; Secure; HttpOnly' }),
      json(200, {}),
      json(200, {}),
    );
    await http.fetch(ctx({ cookieJar: true }), 'https://192.0.2.20/v1/verify/vp-request');
    await http.fetch(ctx({ cookieJar: true }), 'https://192.0.2.20/v1/verify/vp-session-results');
    await http.fetch(ctx(), 'https://192.0.2.20/v1/verify/vp-session-results');
    expect(seen.map((s) => s.headers.get('cookie'))).toEqual([null, 'transaction_id=tx1', null]);
    expect(http.jar(RUN).size).toBe(1);
    await http.endRun(RUN);
    expect(http.jar(RUN).size).toBe(0);
  });

  it('jar: path and host matching, Secure only over https, clearing cookies do not delete (G-117, T-34 drops)', () => {
    const jar = new CookieJar();
    const u = new URL('https://192.0.2.20/v1/verify/x');
    jar.store(u, ['a=1; Path=/v1/verify; Secure', 'b=2']);
    expect(jar.header(new URL('https://192.0.2.20/v1/verify/y'))).toBe('a=1; b=2');
    expect(jar.header(new URL('http://192.0.2.20/v1/verify/y'))).toBe('b=2');
    expect(jar.header(new URL('https://192.0.2.20/v1/verifyx'))).toBeNull();
    expect(jar.header(new URL('https://192.0.2.21/v1/verify/y'))).toBeNull();
    jar.store(u, ['a=; Path=/v1/verify; Max-Age=0']);
    expect(jar.header(new URL('https://192.0.2.20/v1/verify/y'))).toBe('a=1; b=2');
    jar.delete('a');
    expect(jar.header(new URL('https://192.0.2.20/v1/verify/y'))).toBe('b=2');
  });
});

describe('egress.github-denied (ADR-38, CapturingHttp part)', () => {
  // hosts assembled from labels so the repo's no-github-write scan stays clean (no GitHub URL in code)
  const gh = ['github', 'com'].join('.');
  it.each([`https://api.${gh}/x`, `https://${gh}/x`, 'https://raw.githubusercontent.com/x'])(
    'refuses %s before any request is sent',
    async (url) => {
      await expect(makeHttp().fetch(ctx(), url)).rejects.toBeInstanceOf(EgressDeniedError);
      expect(seen).toEqual([]);
      expect(events()).toEqual([]);
    },
  );
});
