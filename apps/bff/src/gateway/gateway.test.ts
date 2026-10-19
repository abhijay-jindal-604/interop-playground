import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureHttp } from '../capture/capturing-http.js';
import { generateSelfToken, SELF_HEADER } from '../capture/self-token.js';
import { sampleSpec } from '../store/fixture-log.js';
import { openStore, type Store } from '../store/index.js';
import { advertisedRules, Allowlists, hardDenyRule, normalisePath } from './allowlist.js';
import { CorrelationIndex, tokenKey } from './correlation.js';
import { startGateway, type Gateway, type UnattributedItem } from './index.js';
import {
  LISTENERS,
  listenerFor,
  PROXY_UPSTREAM_TIMEOUT_MS,
  type ListenerSpec,
} from './listeners.js';

const RUN = '01JZZZZZZZZZZZZZZZZZZZZZZG';
const LOOP = '127.0.0.1';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
let upstream: http.Server;
let upstreamBase: string;
let seen: Seen[];
let store: Store;
let gw: Gateway | null;
let items: UnattributedItem[];
let hold: boolean;

beforeEach(async () => {
  seen = [];
  items = [];
  hold = false;
  gw = null;
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (hold) return; // never answers (timeout test)
      const md = '/.well-known/openid-credential-issuer';
      if (req.url === md || req.url === `/v1/certify${md}`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            credential_issuer: 'https://192.0.2.1',
            credential_endpoint: 'https://192.0.2.1/v1/certify/issuance/credential',
            nonce_endpoint: 'https://192.0.2.1/v1/certify/nonce',
          }),
        );
        return;
      }
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ token_endpoint: 'https://192.0.2.1/v1/certify/oauth/token' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, LOOP, r));
  upstreamBase = `http://${LOOP}:${(upstream.address() as AddressInfo).port}`;
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
    flowId: 'FLOW-01',
    spec: sampleSpec(),
    knobsAllDefault: true,
    targetStepKey: 'vci.credential.request',
    evidenceTier: 'automated',
    appVersion: '0',
  });
});

afterEach(async () => {
  await gw?.close();
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
  store.close();
});

/** the real table, every upstream pointed at the loopback fake (paths and rules unchanged) */
function table(): ListenerSpec[] {
  return LISTENERS.map((l) => ({
    ...l,
    upstream: upstreamBase,
    routes: l.routes?.map((r) => ({ ...r, upstream: upstreamBase })),
  }));
}

async function start(
  opts: { token?: string; timeoutMs?: number; correlation?: CorrelationIndex } = {},
): Promise<Gateway> {
  gw = await startGateway({
    sink: store.sink,
    selfToken: opts.token ?? generateSelfToken(),
    onUnattributed: (i) => items.push(i),
    host: LOOP,
    listeners: table(),
    bindPort: () => 0,
    tls: null,
    ...(opts.timeoutMs ? { upstreamTimeoutMs: opts.timeoutMs } : {}),
    ...(opts.correlation ? { correlation: opts.correlation } : {}),
    log: { info: () => undefined, warn: () => undefined },
  });
  return gw;
}
function url(g: Gateway, port: number, path: string): string {
  const b = g.listening.find((l) => l.port === port);
  if (!b) throw new Error(`listener ${port} not bound`);
  return `http://${LOOP}:${b.boundPort}${path}`;
}
const unattributedRows = (): number =>
  store.driver.get<{ n: number }>('SELECT count(*) AS n FROM unattributed_exchanges')?.n ?? 0;
const runExchanges = (): { type: string; payload_json: string }[] =>
  store.driver.all<{ type: string; payload_json: string }>(
    "SELECT type, payload_json FROM run_events WHERE run_id = ? AND type LIKE 'exchange.%' ORDER BY seq",
    RUN,
  );

describe('gateway listeners (02 §2.3)', () => {
  it('the table has one entry per 02 §2.3 port, peers included, and the 65 000 ms constant', () => {
    expect(LISTENERS.map((l) => l.port).sort((a, b) => a - b)).toEqual([
      443, 3004, 3005, 8093, 8095, 8096, 8097, 8098, 8099, 8443, 18103, 18443, 18444, 18445,
    ]);
    expect(PROXY_UPSTREAM_TIMEOUT_MS).toBe(65000);
    expect(listenerFor(18445).upstream).toBe('http://waltid-verifier-api2-signed:8080');
    expect(listenerFor(443).routes?.map((r) => r.path)).toEqual([
      '/authcode/did.json',
      '/iae/did.json',
    ]);
    expect(listenerFor(8443).scheme).toBe('https');
  });

  it('http listeners all bind; https listeners need the TLS leaf', async () => {
    const g = await start();
    expect(g.failed.map((f) => f.port).sort((a, b) => a - b)).toEqual([
      443, 8443, 18443, 18444, 18445,
    ]);
    expect(g.listening).toHaveLength(LISTENERS.length - 5);
  });
});

describe('allowlist (02 §2.3, §6.3, API-71)', () => {
  const al = new Allowlists(LISTENERS, () => Promise.resolve(null));

  it('normalises paths and refuses traversal and encoded slashes', () => {
    expect(normalisePath('/v1//certify/%61ctuator?x=1')).toBe('/v1/certify/actuator');
    expect(normalisePath('/a/../actuator')).toBeNull();
    expect(normalisePath('/a%2factuator')).toBeNull();
    expect(normalisePath('/bad%zz')).toBeNull();
  });

  it.each([
    [443, '/v1/certify/actuator/health', 'hard-deny:/actuator/*'],
    [
      443,
      '/v1/certify/credential-configurations/x',
      'hard-deny:/v1/certify/credential-configurations*',
    ],
    [443, '/v1/certify/pre-authorized-data', 'hard-deny:/v1/certify/pre-authorized-data*'],
    [8093, '/v1/certify/system-info/version', 'hard-deny:/v1/certify/system-info/*'],
    [3005, '/v1/esignet/client-mgmt/client', 'hard-deny:/v1/esignet/client-mgmt/*'],
    [3005, '/v1/esignet/system-info/x', 'hard-deny:/v1/esignet/system-info/*'],
    [8099, '/v1/mimoto/actuator/env', 'hard-deny:/actuator/*'],
    [8443, '/v1/verify/swagger-ui/index.html', 'hard-deny:/swagger*'],
    [18103, '/issuer2/credential-offer', 'hard-deny:/issuer2/*'],
    [18103, '/api.json', 'hard-deny:/api.json'],
    [18443, '/verification-session/create', 'hard-deny:/verification-session/create'],
    [18445, '/verification-session/abc/info', 'hard-deny:/verification-session/*/info'],
    [18444, '/ui/presentations', 'hard-deny:/ui/*'],
    [18444, '/utilities/x', 'hard-deny:/utilities/*'],
    [8097, '/v3/api-docs', 'hard-deny:/v3/api-docs*'],
  ])('port %i %s → %s', async (port, path, rule) => {
    const l = listenerFor(port);
    expect(hardDenyRule(l, path)).toBe(rule);
    expect(await al.decide(l, 'GET', path)).toEqual({ kind: 'deny', rule });
  });

  it.each([
    [8443, 'GET', '/v1/verify/v2/vp-request/req_0a1b-2c', true],
    [8443, 'POST', '/v1/verify/v2/vp-submission/direct-post', true],
    [8443, 'POST', '/v1/verify/vp-submission/dc-api', true],
    [8443, 'GET', '/v1/verify/did.json', true],
    [8443, 'POST', '/v1/verify/v2/vp-request', false],
    [8443, 'GET', '/v1/verify/v2/vp-results/x', false],
    [8099, 'POST', '/v1/mimoto/credentials/download', true],
    [8099, 'GET', '/', false],
    [3004, 'GET', '/redirect', true],
    [3004, 'POST', '/v1/mimoto/x', false],
    [3005, 'GET', '/authorize', true],
    [3005, 'POST', '/v1/esignet/authorization/v3/oauth-details', true],
    [8095, 'POST', '/token', true],
    [18443, 'POST', '/verification-session/s1/response', true],
    [18445, 'GET', '/verification-session/s1/request', true],
    [18444, 'POST', '/wallet/direct_post/r1', true],
    [18444, 'GET', '/wallet/public-keys.json', true],
    [18444, 'GET', '/wallet/events', false],
    [443, 'GET', '/v1/certify/credential-offer-data/0a-1b', true],
    [443, 'GET', '/.well-known/did.json', true],
    [443, 'GET', '/authcode/did.json', true],
    [443, 'POST', '/authcode/did.json', false],
    [443, 'POST', '/v1/certify/issuance/credential', false],
  ])('port %i %s %s allowed=%s', async (port, method, path, allowed) => {
    const d = await al.decide(listenerFor(port), method, path);
    expect(d.kind === 'forward').toBe(allowed);
    if (!allowed) expect(d).toEqual({ kind: 'deny', rule: `allowlist:${listenerFor(port).allow}` });
  });

  it('M1 allows exactly the advertised endpoints of the listener port', async () => {
    const doc = {
      credential_endpoint: 'https://h/v1/certify/issuance/credential',
      nonce_endpoint: 'https://h/v1/certify/nonce',
      other: { token_endpoint: 'https://h:8093/v1/certify/oauth/token' },
      jwks_uri: 'https://h/v1/certify/.well-known/jwks.json',
    };
    expect(advertisedRules(doc, 443).map((r) => r.pattern.source)).toEqual([
      '^\\/v1\\/certify\\/issuance\\/credential$',
      '^\\/v1\\/certify\\/nonce$',
      '^\\/v1\\/certify\\/\\.well-known\\/jwks\\.json$',
    ]);
    const m1 = new Allowlists(LISTENERS, () => Promise.resolve(doc));
    await m1.refresh([443]);
    expect(m1.isLoaded(443)).toBe(true);
    const l = listenerFor(443);
    expect((await m1.decide(l, 'POST', '/v1/certify/issuance/credential')).kind).toBe('forward');
    expect((await m1.decide(l, 'GET', '/v1/certify/issuance/credential')).kind).toBe('deny');
    expect((await m1.decide(l, 'POST', '/v1/certify/oauth/token')).kind).toBe('deny');
  });

  it('the relay path is BFF-served on 8443 only', async () => {
    const run = '01JZZZZZZZZZZZZZZZZZZZZZZG';
    expect(await al.decide(listenerFor(8443), 'GET', `/tamper/request/${run}`)).toEqual({
      kind: 'relay',
      runId: run,
    });
    expect((await al.decide(listenerFor(443), 'GET', `/tamper/request/${run}`)).kind).toBe('deny');
  });
});

describe('forwarding and capture (02 §2.4, §3.3, 04 §8.1, §8.2)', () => {
  it('forwards an allowlisted well-known unchanged except Host / X-Forwarded-*, records it unattributed', async () => {
    const g = await start();
    const res = await fetch(url(g, 8093, '/.well-known/openid-credential-issuer'), {
      headers: { 'x-playground-self': 'not-the-token' },
    });
    expect(res.status).toBe(200);
    const s = seen.find(
      (x) => x.url === '/.well-known/openid-credential-issuer' && x.headers['x-forwarded-proto'],
    );
    expect(s?.headers.host).toBe(new URL(upstreamBase).host);
    expect(s?.headers['x-forwarded-proto']).toBe('http');
    expect(s?.headers['x-forwarded-host']).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(s?.headers[SELF_HEADER]).toBeUndefined();
    // a wrong token does not suppress capture
    expect(unattributedRows()).toBe(1);
    const ex = items.find((i) => i.kind === 'exchange');
    expect(ex).toMatchObject({
      kind: 'exchange',
      port: 8093,
      status: 200,
      counterpart: 'certify-authcode',
    });
  });

  it('denies an admin path with the API-71 body, one gateway.denied event, no upstream call', async () => {
    const g = await start();
    const before = seen.length;
    const res = await fetch(url(g, 8093, '/v1/certify/credential-configurations'), {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: 'gateway_denied',
      status: 403,
      retryable: false,
      details: { port: 8093, rule: 'hard-deny:/v1/certify/credential-configurations*' },
    });
    expect(seen.filter((x) => x.url.startsWith('/v1/certify/credential-config'))).toHaveLength(0);
    expect(seen.length - before).toBeLessThanOrEqual(4); // only background metadata loads
    const denied = items.filter((i) => i.kind === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      event: {
        type: 'gateway.denied',
        payload: { method: 'POST', port: 8093, remote: 'loopback' },
      },
    });
  });

  it('allows the metadata-advertised credential endpoint (M1) and denies an unadvertised one', async () => {
    const g = await start();
    await g.refresh();
    const ok = await fetch(url(g, 8093, '/v1/certify/nonce'), { method: 'POST', body: '' });
    expect(ok.status).toBe(403); // advertised for port 443, not 8093
    const g443 = g.allowlists;
    expect(g443.isLoaded(8093)).toBe(true);
    const t = await fetch(url(g, 8099, '/v1/mimoto/issuers'));
    expect(t.status).toBe(200);
  });

  it('a self-call is recorded once (outbound only); the token never reaches the upstream', async () => {
    const token = generateSelfToken();
    const g = await start({ token });
    const bound = g.listening.find((l) => l.port === 8099)?.boundPort ?? 0;
    const capture = new CaptureHttp({
      sink: store.sink,
      selfToken: token,
      gatewayOrigins: [`${LOOP}:${bound}`],
    });
    const res = await capture.fetch(
      {
        runId: RUN,
        stepKey: 'vci.web.download',
        actor: 'wallet.playground-ts',
        counterpart: 'mimoto',
      },
      url(g, 8099, '/v1/mimoto/issuers'),
    );
    expect(res.status).toBe(200);
    const last = seen[seen.length - 1];
    expect(last?.url).toBe('/v1/mimoto/issuers');
    expect(last?.headers[SELF_HEADER]).toBeUndefined();
    expect(unattributedRows()).toBe(0);
    expect(items.filter((i) => i.kind === 'exchange')).toHaveLength(0);
    const ex = runExchanges();
    expect(ex.map((e) => e.type)).toEqual(['exchange.request', 'exchange.response']);
    expect(JSON.parse(ex[0]?.payload_json ?? '{}')).toMatchObject({ direction: 'outbound' });
  });

  it('a correlated request is recorded inbound on its run with the route-table stepKey', async () => {
    const corr = new CorrelationIndex();
    corr.register(RUN, 'offer-0123456789', 'vci.offer.fetch', 'wallet.inji-jvm');
    corr.registerToken(RUN, 'access-token-value', 'vci.credential.request');
    corr.setRoutes(RUN, [{ method: 'POST', pattern: /\/token$/, stepKey: 'vci.token.request' }]);
    const g = await start({ correlation: corr });
    await fetch(url(g, 8095, '/token'), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'pre-authorized_code=offer-0123456789',
    });
    await fetch(url(g, 8095, '/userinfo'), {
      headers: { authorization: 'Bearer access-token-value' },
    });
    const ex = runExchanges().map((e) => ({
      type: e.type,
      ...(JSON.parse(e.payload_json) as Record<string, unknown>),
    }));
    expect(ex.map((e) => e.type)).toEqual([
      'exchange.request',
      'exchange.response',
      'exchange.request',
      'exchange.response',
    ]);
    expect(ex[0]).toMatchObject({ direction: 'inbound', actor: 'wallet.inji-jvm', method: 'POST' });
    const steps = store.driver.all<{ step_key: string }>(
      "SELECT step_key FROM run_events WHERE run_id = ? AND type = 'exchange.request' ORDER BY seq",
      RUN,
    );
    expect(steps.map((s) => s.step_key)).toEqual(['vci.token.request', 'vci.credential.request']);
    expect(unattributedRows()).toBe(0);
    expect(tokenKey('x')).toMatch(/^sha256:[0-9a-f]{64}$/);
    corr.dropRun(RUN);
    expect(corr.size).toBe(0);
  });

  it('a closed relay answers 404 relay-closed through the deny path', async () => {
    const g = await start();
    // 8443 is https; exercise the same handler through a plain listener table entry
    await g.close();
    gw = await startGateway({
      sink: store.sink,
      selfToken: generateSelfToken(),
      onUnattributed: (i) => items.push(i),
      host: LOOP,
      listeners: [{ ...listenerFor(8443), scheme: 'http', upstream: upstreamBase }],
      bindPort: () => 0,
      log: { info: () => undefined, warn: () => undefined },
    });
    const res = await fetch(url(gw, 8443, `/tamper/request/${RUN}`));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({
      port: 8443,
      rule: 'relay-closed',
    });
  });

  it('a down upstream answers 503; a hung upstream 502 timeout after the configured limit', async () => {
    gw = await startGateway({
      sink: store.sink,
      selfToken: generateSelfToken(),
      onUnattributed: (i) => items.push(i),
      host: LOOP,
      listeners: [
        { ...listenerFor(8095), upstream: `http://${LOOP}:1` },
        { ...listenerFor(8099), upstream: upstreamBase },
      ],
      bindPort: () => 0,
      upstreamTimeoutMs: 200,
      log: { info: () => undefined, warn: () => undefined },
    });
    const down = await fetch(url(gw, 8095, '/x'));
    expect(down.status).toBe(503);
    expect(((await down.json()) as { error: { code: string } }).error.code).toBe('env_not_ready');
    hold = true;
    const hung = await fetch(url(gw, 8099, '/v1/mimoto/issuers'));
    expect(hung.status).toBe(502);
    expect(((await hung.json()) as { error: { details: unknown } }).error.details).toMatchObject({
      errorClass: 'timeout',
    });
    expect(
      items
        .filter((i) => i.kind === 'exchange')
        .map((i) => (i.kind === 'exchange' ? i.errorClass : '')),
    ).toEqual(['ECONNREFUSED', 'timeout']);
  });
});
