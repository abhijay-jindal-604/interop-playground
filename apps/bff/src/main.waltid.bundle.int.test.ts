/**
 * T-43 acceptance ON THE BUNDLE (skipped unless BUNDLE_IT=1; peers profile up). main's AdapterSet
 * runs FLOW-08 (`issuer.waltid` × `wallet.playground-ts`, scope `issuance`) through the real
 * orchestrator, CaptureHttp and store from the host, once per KNOB-01 value from the run spec:
 *  - every FLOW-08 step completes (`vci.offer.fetch` skipped "offer by value"), every HTTP step
 *    with `capture: full`; the wallet hops go to `http://<PUBLIC_HOST>:18103`;
 *  - `dc+sd-jwt` issued (header `typ: dc+sd-jwt`, payload `cnf.jwk`), decoded at
 *    `vci.credential.inspect`; KNOB-01 `absent` → no `x5c`, `present` → `x5c` (S-077 → S-120);
 *  - the issuer key's private `d` sent with `present` is redacted in the store (02 §6.2).
 * Env: PUBLIC_HOST, WALTID_ISSUER_URL (container IP:8080), PEERS_CERT_DIR (certs/peers).
 */
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Run } from '@interop-playground/api';
import { x5cMaterialFromFiles } from '@interop-playground/adapters';
import { CaptureHttp } from './capture/index.js';
import { REPO_ROOT } from './config/index.js';
import { CorrelationIndex } from './gateway/index.js';
import { adaptersFor, holderKeysFor, registerPeerSecrets } from './main.js';
import { Orchestrator, loadFlowTable } from './orchestrator/index.js';
import { SecretRegistry } from './redact/registry.js';
import { scanStore } from './redact/scan.js';
import { captureHooks, createServer } from './server.js';
import { openStore } from './store/index.js';
import { EventBus } from './stream/index.js';

const ON = process.env.BUNDLE_IT === '1';
const part = (jws: string, i: number): Record<string, unknown> =>
  JSON.parse(Buffer.from(jws.split('.')[i] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;

describe.skipIf(!ON)('bundle: issuer.waltid + playground-ts, FLOW-08 (T-43)', () => {
  const store = openStore(':memory:');
  const bus = new EventBus();
  afterAll(() => store.close());

  for (const x5c of ['absent', 'present'] as const)
    it(`KNOB-01 ${x5c}: dc+sd-jwt issued with full capture`, { timeout: 120_000 }, async () => {
      const env = process.env;
      expect(registerPeerSecrets(store, env)).toEqual(['WALTID_ISSUER_KEY_D']);
      const orch = new Orchestrator({
        store,
        flows: loadFlowTable(path.join(REPO_ROOT, 'flows')),
        adapters: adaptersFor(env, new CorrelationIndex()),
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
          issuer: 'issuer.waltid',
          wallet: 'wallet.playground-ts',
          verifier: 'verifier.inji-verify-local',
          grant: 'pre-authorized_code',
          presentationMode: 'cross-device',
          format: 'dc+sd-jwt',
          scope: 'issuance',
          knobs: { 'KNOB-01': x5c },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const runId = res.json<Run>().runId;
      await orch.idle();
      const run = (
        await app.inject({
          method: 'GET',
          url: `/api/v1/runs/${runId}`,
          headers: { host: '127.0.0.1:3100' },
        })
      ).json<Run>();
      await app.close();
      const events = store.reader.readEvents(runId, 0, 5000);
      const done = new Map(
        events
          .filter((e) => e.type === 'step.completed')
          .map((e) => [e.stepKey, e.payload as { outcome: string; capture: string }]),
      );
      const reqs = events.filter((e) => e.type === 'exchange.request');
      console.warn(
        `run ${runId} ${run.state} ${JSON.stringify(run.verdict)}\n${reqs
          .map(
            (e) =>
              `${e.stepKey} ${(e.payload as { method: string; url: string }).method} ${(e.payload as { url: string }).url}`,
          )
          .join('\n')}`,
      );
      expect(run.spec.issuanceFlowId).toBe('FLOW-08');
      expect(run.spec.knobs['KNOB-01']).toBe(x5c);
      for (const k of [
        'vci.offer.mint',
        'vci.metadata.issuer',
        'vci.metadata.as',
        'vci.token',
        'vci.nonce',
        'vci.credential',
      ])
        expect(done.get(k), k).toMatchObject({ outcome: 'pass', capture: 'full' });
      expect(done.get('vci.offer.fetch')).toMatchObject({ outcome: 'skipped' });
      expect(done.get('vci.proof.sign')).toMatchObject({ outcome: 'pass' });
      expect(done.get('vci.credential.inspect')).toMatchObject({ outcome: 'pass' });
      const pub = `http://${env.PUBLIC_HOST}:18103/`;
      const wallet = reqs.filter((e) => e.stepKey !== 'vci.offer.mint');
      expect(wallet.length).toBe(5);
      for (const e of wallet) expect((e.payload as { url: string }).url.startsWith(pub)).toBe(true);
      const resp = events.find(
        (e) =>
          e.type === 'exchange.response' &&
          (e.payload as { exchangeId: string }).exchangeId ===
            (reqs.find((r) => r.stepKey === 'vci.credential')?.payload as { exchangeId: string })
              .exchangeId,
      )?.payload as { status: number; body: { text: string } };
      expect(resp.status).toBe(200);
      const compact = (JSON.parse(resp.body.text) as { credentials: { credential: string }[] })
        .credentials[0]?.credential as string;
      const header = part(compact, 0);
      expect(header.typ).toBe('dc+sd-jwt');
      expect(part(compact, 1).cnf).toHaveProperty('jwk');
      if (x5c === 'present') expect(Array.isArray(header.x5c)).toBe(true);
      else expect(header.x5c).toBeUndefined();
      const inspect = events.find(
        (e) => e.type === 'engine.call' && e.stepKey === 'vci.credential.inspect',
      )?.payload as { op: string; outputSummary: { header: Record<string, unknown> } };
      expect(inspect.op).toBe('inspect-credential');
      expect('x5c' in inspect.outputSummary.header).toBe(x5c === 'present');
      expect(run.state).toBe('completed');
      expect(run.verdict?.outcome).toBe('pass');
      // the issuer key's d never reaches the store
      const dir = env.PEERS_CERT_DIR ?? '/certs/peers';
      const d = x5cMaterialFromFiles(
        path.join(dir, 'waltid-issuer.key'),
        path.join(dir, 'waltid-issuer.pem'),
      )().issuerJwk.d as string;
      expect(scanStore(store.driver, new SecretRegistry().add('WALTID_ISSUER_KEY_D', d))).toEqual(
        [],
      );
    });
});
