/**
 * T-23..T-26 acceptance ON THE BUNDLE (skipped unless BUNDLE_IT=1; stack up; command in the
 * build wave 5 A note of STATUS.md). main's AdapterSet (certify-preauth, playground-ts,
 * inji-verify-local) and key service run FLOW-04 + FLOW-30 through the real orchestrator,
 * CaptureHttp and store from the host, `BUNDLE_RUNS` times in a row (default 5):
 *  - T-23: offer minted, metadata, token, nonce, credential, did.json exchanges all `capture: full`,
 *    shape (method, path, status, JSON keys) equal to `local-preauth-sdjwt-trace.json` (first run);
 *  - T-24: `dc+sd-jwt` issued with an ES256 P1363 proof by the run's holder key, the decoded
 *    artifact at `vci.credential.inspect`, the private key only in `holder_keys` (scan-store);
 *  - T-25/T-26: request created (clientId `interop-playground`, 32-char nonce), `openid4vp://`
 *    URI, KB-JWT `aud` = clientId and `nonce` = request nonce, direct_post 200, Verify's result
 *    `allChecksSuccessful` → verdict Valid, run outcome pass; all 20 `vp.*` keys applied/skipped.
 * Env: PUBLIC_HOST, CERTIFY_PREAUTH_URL, VERIFY_SERVICE_URL (container IPs), NODE_EXTRA_CA_CERTS.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Run } from '@interop-playground/api';
import { CaptureHttp } from './capture/index.js';
import { REPO_ROOT } from './config/index.js';
import { CorrelationIndex } from './gateway/index.js';
import { adaptersFor, holderKeysFor } from './main.js';
import { Orchestrator, loadFlowTable } from './orchestrator/index.js';
import { SecretRegistry } from './redact/registry.js';
import { scanStore } from './redact/scan.js';
import { captureHooks, createServer } from './server.js';
import { openStore } from './store/index.js';
import { EventBus } from './stream/index.js';

const ON = process.env.BUNDLE_IT === '1';
const RUNS = Number(process.env.BUNDLE_RUNS ?? '5');
const VP_KEYS = [
  'vp.request.create',
  'vp.request.deliver',
  'vp.request.fetch',
  'vp.request.validate',
  'vp.credential.match',
  'vp.token.build',
  'vp.response.post',
  'vp.error.dispatch',
  'vp.response.redirect',
  'vp.result.poll',
  'vp.result.fetch',
  'vp.vc.verify',
  'vp.verdict.evaluate',
  'vp.wallet.observe',
  'vp.dcapi.probe',
  'vp.dcapi.request.create',
  'vp.dcapi.request.fetch',
  'vp.dcapi.invoke',
  'vp.dcapi.response.post',
  'vp.dcapi.holder',
];
const part = (jws: string, i: number): Record<string, unknown> =>
  JSON.parse(Buffer.from(jws.split('.')[i] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;
type TraceEx = { method: string; url: string; status: number; resBody: unknown; reqBody?: string };

const norm = (url: string): string =>
  new URL(url).pathname.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    '<uuid>',
  );
const keysOf = (v: unknown): string[] =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort() : [];

describe.skipIf(!ON)(
  'bundle: certify-preauth + playground-ts + inji-verify-local (T-23..T-26)',
  () => {
    const store = openStore(':memory:');
    const bus = new EventBus(); // one bus per store (the sink attaches once)
    afterAll(() => store.close());

    for (let n = 1; n <= RUNS; n += 1)
      it(
        `FLOW-04 + FLOW-30 run ${n}/${RUNS} from the host against the running bundle`,
        { timeout: 180_000 },
        async () => {
          const env = process.env;
          const correlation = new CorrelationIndex();
          const adapters = adaptersFor(env, correlation);
          const orch = new Orchestrator({
            store,
            flows: loadFlowTable(path.join(REPO_ROOT, 'flows')),
            adapters,
            keys: holderKeysFor(store),
            capture: captureHooks(
              new CaptureHttp({ sink: store.sink, selfToken: 'bundle-it-'.padEnd(43, 'x') }),
            ),
            resultTimeoutMs: 60_000,
          });
          const app = await createServer({
            config: {
              flowsDir: path.join(REPO_ROOT, 'flows'),
              fingerprintsDir: path.join(REPO_ROOT, 'none'),
              uiDistDir: path.join(REPO_ROOT, 'none'),
            },
            probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
            store,
            bus,
            orchestrator: orch,
          });
          const res = await app.inject({
            method: 'POST',
            url: '/api/v1/runs',
            headers: {
              host: '127.0.0.1:3100',
              origin: 'http://127.0.0.1:3100',
              'content-type': 'application/json',
            },
            payload: {
              issuer: 'issuer.certify-preauth',
              wallet: 'wallet.playground-ts',
              verifier: 'verifier.inji-verify-local',
              grant: 'pre-authorized_code',
              presentationMode: 'cross-device',
              format: 'dc+sd-jwt',
            },
          });
          expect(res.statusCode).toBe(201);
          const runId = res.json<Run>().runId;
          await orch.idle();
          const events = store.reader.readEvents(runId, 0, 5000);
          const run = (
            await app.inject({
              method: 'GET',
              url: `/api/v1/runs/${runId}`,
              headers: { host: '127.0.0.1:3100' },
            })
          ).json<Run>();
          await app.close();

          // ---- exchanges (request + response pairs) ----
          type P = Record<string, unknown> & { exchangeId: string };
          const reqs = events.filter((e) => e.type === 'exchange.request');
          const resps = new Map(
            events
              .filter((e) => e.type === 'exchange.response' || e.type === 'exchange.error')
              .map((e) => [(e.payload as P).exchangeId, e]),
          );
          const ex = reqs.map((e) => {
            const p = e.payload as P & { method: string; url: string };
            const r = resps.get(p.exchangeId);
            const rp = (r?.payload ?? {}) as { status?: number; body?: { text: string } | null };
            let json: unknown;
            try {
              json = rp.body ? JSON.parse(rp.body.text) : null;
            } catch {
              json = null;
            }
            return {
              step: e.stepKey ?? '',
              method: p.method,
              path: norm(p.url),
              url: p.url,
              status: rp.status ?? 0,
              json,
              type: r?.type,
            };
          });
          const lines = ex.map((x) => `${x.step} ${x.method} ${x.path} ${x.status}`);
          console.warn(`run ${runId} ${run.state} ${run.verdict?.outcome}\n${lines.join('\n')}`);

          // ---- T-23: the steps are full and the shape equals the golden trace ----
          const done = new Map(
            events
              .filter((e) => e.type === 'step.completed')
              .map((e) => [e.stepKey, e.payload as { outcome: string; capture: string }]),
          );
          for (const k of [
            'vci.setup.config-read',
            'vci.offer.mint',
            'vci.offer.fetch',
            'vci.metadata.issuer',
            'vci.metadata.as',
            'vci.token',
            'vci.nonce',
            'vci.credential',
          ]) {
            expect(done.get(k), k).toMatchObject({ outcome: 'pass', capture: 'full' });
          }
          const golden = (
            JSON.parse(
              readFileSync(
                path.join(REPO_ROOT, 'fixtures/golden/traces/local-preauth-sdjwt-trace.json'),
                'utf8',
              ),
            ) as TraceEx[]
          ).filter((g) => g.status !== 404); // the raw service's root 404; the bundle's front maps the root (S-018)
          const certify = ex.filter(
            (x) => x.path.startsWith('/v1/certify/') || x.path.startsWith('/.well-known/'),
          );
          let at = 0;
          for (const g of n === 1 ? golden : []) {
            const i = certify.findIndex(
              (x, j) => j >= at && x.method === g.method && x.path === norm(g.url),
            );
            expect(i, `${g.method} ${norm(g.url)} in order`).toBeGreaterThanOrEqual(0);
            const x = certify[i] as (typeof certify)[number];
            expect(x.status, `${g.method} ${norm(g.url)}`).toBe(g.status);
            expect(keysOf(x.json), `${g.method} ${norm(g.url)} keys`).toEqual(
              expect.arrayContaining(keysOf(g.resBody)),
            );
            at = i + 1;
          }
          const pub = `https://${env.PUBLIC_HOST}`;
          const wallet = ex.filter((x) => x.step.startsWith('vci.') && x.url.startsWith(`${pub}/`));
          expect(wallet.map((x) => x.step)).toEqual(
            expect.arrayContaining([
              'vci.offer.fetch',
              'vci.metadata.issuer',
              'vci.metadata.as',
              'vci.token',
              'vci.nonce',
              'vci.credential',
              'vci.setup.config-read',
            ]),
          );
          const did = ex.find((x) => x.path === '/.well-known/did.json');
          expect(did).toMatchObject({ status: 200, step: 'vci.setup.config-read' });
          expect((did?.json as { id: string }).id).toBe(`did:web:${env.PUBLIC_HOST}`);
          const cred = ex.find((x) => x.step === 'vci.credential');
          const compact =
            (cred?.json as { credentials: { credential: string }[] }).credentials[0]?.credential ??
            '';
          expect(compact.split('~').length).toBeGreaterThan(2); // issuer-jwt~disclosures~ (FLOW-04)

          // ---- T-25: request created, URI, deliver-request, premature result ----
          expect(done.get('vp.request.create')).toMatchObject({ outcome: 'pass', capture: 'full' });
          const create = events.find(
            (e) => e.type === 'exchange.request' && e.stepKey === 'vp.request.create',
          );
          const sent = JSON.parse((create?.payload as { body: { text: string } }).body.text) as {
            clientId: string;
            nonce: string;
          };
          expect(sent.clientId).toBe('interop-playground');
          expect(sent.nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
          const created = ex.find((x) => x.step === 'vp.request.create');
          expect(created?.status).toBe(201);
          const details = (
            created?.json as {
              authorizationDetails: { nonce: string; clientId: string; responseUri: string };
            }
          ).authorizationDetails;
          expect(details).toMatchObject({
            clientId: 'interop-playground',
            nonce: sent.nonce,
            responseUri: `https://${env.PUBLIC_HOST}:8443/v1/verify/v2/vp-submission/direct-post`,
          });
          const deliver = events.find(
            (e) => e.type === 'engine.call' && e.stepKey === 'vp.request.deliver',
          );
          const uri = (deliver?.payload as { op: string; outputSummary: { uri: string } })
            .outputSummary.uri;
          expect((deliver?.payload as { op: string }).op).toBe('deliver-request');
          const u = new URL(uri);
          expect(u.protocol).toBe('openid4vp:');
          expect(u.searchParams.get('client_id')).toBe('interop-playground');
          expect(u.searchParams.get('nonce')).toBe(sent.nonce);
          expect(u.searchParams.get('response_uri')).toBe(details.responseUri);
          // ---- T-24: proof, decoded artifact, key only in holder_keys ----
          const credReq = events.find(
            (e) => e.type === 'exchange.request' && e.stepKey === 'vci.credential',
          );
          const proof = (
            JSON.parse((credReq?.payload as { body: { text: string } }).body.text) as {
              proofs: { jwt: string[] };
            }
          ).proofs.jwt[0] as string;
          expect(part(proof, 0)).toMatchObject({ alg: 'ES256', typ: 'openid4vci-proof+jwt' });
          expect(Buffer.from(proof.split('.')[2] ?? '', 'base64url')).toHaveLength(64);
          expect(done.get('vci.credential.inspect')).toMatchObject({
            outcome: 'pass',
            capture: 'none',
          });
          const inspect = events.find(
            (e) => e.type === 'engine.call' && e.stepKey === 'vci.credential.inspect',
          )?.payload as { op: string; outputSummary: { payload: { vct: string } } };
          expect(inspect.op).toBe('inspect-credential');
          expect(inspect.outputSummary.payload.vct).toBe('PlaygroundSdJwt');
          const key = store.driver.get<{ private_jwk_json: string }>(
            'SELECT h.private_jwk_json FROM holder_keys h JOIN run_keys r ON r.key_id = h.key_id WHERE r.run_id = ?',
            runId,
          );
          const d = (JSON.parse(key?.private_jwk_json ?? '{}') as { d: string }).d;
          const hits = scanStore(store.driver, new SecretRegistry().add('HOLDER_KEY_D', d));
          expect(hits.filter((h) => h.table !== 'holder_keys')).toEqual([]);

          // ---- T-26: KB-JWT, direct_post, Valid ----
          const post = events.find(
            (e) => e.type === 'exchange.request' && e.stepKey === 'vp.response.post',
          );
          const form = new URLSearchParams((post?.payload as { body: { text: string } }).body.text);
          expect(form.get('state')).toBe(u.searchParams.get('state'));
          const presented = (JSON.parse(form.get('vp_token') ?? '{}') as { pg: string[] })
            .pg[0] as string;
          const kb = presented.split('~').at(-1) as string;
          expect(part(kb, 0)).toEqual({ alg: 'ES256', typ: 'kb+jwt' });
          expect(part(kb, 1)).toMatchObject({ aud: 'interop-playground', nonce: sent.nonce });
          expect(ex.find((x) => x.step === 'vp.response.post')?.status).toBe(200);
          const results = ex.filter((x) => x.path.includes('/v2/vp-results/'));
          expect(results.at(-1)).toMatchObject({
            status: 200,
            json: { allChecksSuccessful: true },
          });
          for (const k of VP_KEYS) expect(done.get(k)?.outcome, k).toMatch(/^(pass|skipped)$/);
          expect(run.verdict).toMatchObject({ outcome: 'pass', verification: 'valid' });
        },
      );
  },
);
