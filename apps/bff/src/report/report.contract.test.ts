/**
 * T-32 acceptance (plan/12; 08 §1.1, 04 §3.7 `RunReport`, API-45):
 *  - the report of a pass and of a forced-fail run lists issuer, wallet, verifier, format, proof
 *    type, outcome and error detail (JSON valid against the generated contract, and Markdown);
 *  - Markdown snapshot test (pass and fail);
 *  - `run_not_terminal` / `not_found` / `validation_failed` errors;
 *  - a `run.failed` run reports INCONCLUSIVE with its error code (ADR-81).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import type { FastifyInstance } from 'fastify';
import type { ErrorEnvelope, RunReport } from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import { DiagnosisEngine, loadLibrary } from '../diagnosis/index.js';
import {
  closeRun,
  goldenSteps,
  recordRun,
  verdictOf,
  waltidSpec,
} from '../diagnosis/fixture-runs.js';
import { loadFlowTable } from '../orchestrator/index.js';
import { createServer } from '../server.js';
import { openStore } from '../store/index.js';
import type { Store } from '../store/index.js';
import { buildRunReport, renderRunReportMarkdown } from './index.js';

const H = { host: '127.0.0.1:3100' };
const flowsDir = path.join(REPO_ROOT, 'flows');
const flows = loadFlowTable(flowsDir);
const schema = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'packages', 'api', 'api.schema.json'), 'utf8'),
) as Record<string, unknown>;
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema({ $id: 'api', ...schema });
const validReport = ajv.getSchema('api#/definitions/RunReport');

const PASS_ID = '01JA0000000000000000000001';
const FAIL_ID = '01JA0000000000000000000002';
const ENVF_ID = '01JA0000000000000000000003';
const OPEN_ID = '01JA0000000000000000000004';
const AT = () => new Date('2026-10-19T12:00:00.000Z');

let store: Store;
let app: FastifyInstance;

beforeAll(async () => {
  store = openStore(':memory:');
  app = await createServer({
    config: {
      flowsDir,
      fingerprintsDir: path.join(REPO_ROOT, 'fingerprints'),
      uiDistDir: path.join(REPO_ROOT, 'no-ui'),
    },
    probeSidecar: () => Promise.resolve({ reachable: true, version: 't' }),
    store,
  });
  const diag = new DiagnosisEngine(store, loadLibrary(path.join(REPO_ROOT, 'fingerprints')));
  // pass: S-120 (walt.id with x5c → Inji Verify Collab, every check passes)
  recordRun(
    store,
    waltidSpec('present'),
    goldenSteps('S-120-trace-x5chain-to-collab.json'),
    null,
    PASS_ID,
  );
  diag.diagnoseRun(PASS_ID, 'completed');
  closeRun(store, PASS_ID, { verdict: verdictOf('pass', null) });
  // forced fail: S-077 (no x5c → ERR_SIGNATURE_VERIFICATION_FAILED), diagnosed FP-01 + KNOB-01
  recordRun(
    store,
    waltidSpec('absent'),
    goldenSteps('S-077-trace-waltid-to-collab.json'),
    null,
    FAIL_ID,
  );
  diag.diagnoseRun(FAIL_ID, 'completed');
  closeRun(store, FAIL_ID, { verdict: verdictOf('fail', 'vp.verdict.evaluate') });
  // environment fault mid-issuance
  recordRun(
    store,
    waltidSpec('absent'),
    [
      { stepKey: 'vci.token', outcome: 'fail', capture: 'partial', coverageNote: 'engine fault' },
      { stepKey: 'vci.credential', outcome: 'skipped', skipReason: 'blocked at vci.token' },
    ],
    { failed: 'env_not_ready' },
    ENVF_ID,
  );
  recordRun(
    store,
    waltidSpec('absent'),
    [{ stepKey: 'vci.token', outcome: 'pass' }],
    null,
    OPEN_ID,
  );
});

afterAll(async () => {
  await app.close();
  store.close();
});

async function get(url: string): Promise<{ status: number; body: string; type: string }> {
  const res = await app.inject({ method: 'GET', url, headers: H });
  return { status: res.statusCode, body: res.body, type: String(res.headers['content-type']) };
}

describe('report.run (API-45) JSON', () => {
  it('a pass run lists the REQ-26 fields and validates against RunReport', async () => {
    const res = await get(`/api/v1/reports/runs/${PASS_ID}`);
    expect(res.status).toBe(200);
    const r = JSON.parse(res.body) as RunReport;
    expect(validReport?.(r), JSON.stringify(validReport?.errors)).toBe(true);
    expect(r.fields).toMatchObject({
      issuer: 'issuer.waltid',
      wallet: 'wallet.playground-ts',
      verifier: 'verifier.inji-verify-collab',
      format: 'dc+sd-jwt',
      proofType: 'jwt',
      grant: 'pre-authorized_code',
      mode: 'cross-device',
      nonDefaultKnobs: ['KNOB-01'],
      verdict: { outcome: 'pass' },
      failedStepKey: null,
      failingChecks: [],
      errorDetail: null,
    });
    expect(r.diagnosis).toEqual({ matches: [], offers: [], noFixReason: null, coverageBanner: [] });
  });

  it('a forced-fail run lists outcome, the failing checks, error detail and the diagnosis', async () => {
    const r = JSON.parse((await get(`/api/v1/reports/runs/${FAIL_ID}`)).body) as RunReport;
    expect(validReport?.(r), JSON.stringify(validReport?.errors)).toBe(true);
    expect(r.fields.verdict.outcome).toBe('fail');
    expect(r.fields.failedStepKey).toBe('vp.verdict.evaluate');
    expect(r.fields.errorDetail).toBe(
      'ERR_SIGNATURE_VERIFICATION_FAILED: Exception during Verification: getX509CertChain(...) must not be null',
    );
    expect(r.fields.failingChecks.map((c) => [c.checkId, c.code ?? null])).toEqual([
      ['vc.signature', 'ERR_SIGNATURE_VERIFICATION_FAILED'],
      ['vp.verdict', null],
    ]);
    expect(r.diagnosis.matches.map((m) => [m.fingerprintId, m.confidence])).toEqual([
      ['FP-01', 'exact'],
    ]);
    expect(r.diagnosis.offers.map((o) => `${o.knobId}:${o.from}->${o.to}`)).toEqual([
      'KNOB-01:absent->present',
    ]);
    expect(r.steps.map((s) => `${s.stepKey}:${s.outcome ?? '-'}`)).toContain(
      'vp.verdict.evaluate:fail',
    );
  });

  it('a run.failed run reports INCONCLUSIVE with its error code and a coverage banner', async () => {
    const r = JSON.parse((await get(`/api/v1/reports/runs/${ENVF_ID}`)).body) as RunReport;
    expect(validReport?.(r), JSON.stringify(validReport?.errors)).toBe(true);
    expect(r.fields.verdict).toMatchObject({
      outcome: 'inconclusive',
      countsTowardPassRate: false,
    });
    expect(r.fields.errorDetail).toBe('env_not_ready: environment fault');
    expect(r.diagnosis.noFixReason).toBe('unclassified');
    expect(r.diagnosis.coverageBanner).toEqual([
      { stepKey: 'vci.token', capture: 'partial', reason: 'engine fault' },
    ]);
  });

  it('errors: run_not_terminal, not_found, validation_failed', async () => {
    const open = await get(`/api/v1/reports/runs/${OPEN_ID}`);
    expect(open.status).toBe(409);
    expect((JSON.parse(open.body) as ErrorEnvelope).error.code).toBe('run_not_terminal');
    const missing = await get('/api/v1/reports/runs/01JNOSUCHRUN00000000000000');
    expect(missing.status).toBe(404);
    expect((JSON.parse(missing.body) as ErrorEnvelope).error.code).toBe('not_found');
    for (const q of ['?format=pdf', '?typo=1']) {
      const bad = await get(`/api/v1/reports/runs/${PASS_ID}${q}`);
      expect(bad.status).toBe(400);
      expect((JSON.parse(bad.body) as ErrorEnvelope).error.code).toBe('validation_failed');
    }
  });
});

describe('report.run Markdown (08 §1.1)', () => {
  it('served as text/markdown with the fields and upper-case verdict words', async () => {
    const res = await get(`/api/v1/reports/runs/${FAIL_ID}?format=markdown`);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/^text\/markdown/);
    expect(res.body.split('\n')[0]).toBe(`# Run ${FAIL_ID}: FAIL`);
    for (const s of [
      '| Issuer | issuer.waltid |',
      '| Wallet | wallet.playground-ts |',
      '| Verifier | verifier.inji-verify-collab |',
      '| Format | dc+sd-jwt |',
      '| Proof type | jwt |',
      '| Verdict | FAIL |',
      '| Error detail | ERR_SIGNATURE_VERIFICATION_FAILED: Exception during Verification: getX509CertChain(...) must not be null |',
      'KNOB-01=absent',
      '## Failing checks',
      '## Diagnosis',
      '## Fix-it',
      '## Coverage',
      '## Steps',
    ])
      expect(res.body).toContain(s);
  });

  it('snapshot: pass and forced-fail', async () => {
    await expect(
      renderRunReportMarkdown(buildRunReport(store, flows, PASS_ID, AT)),
    ).toMatchFileSnapshot('__snapshots__/run-report-pass.md');
    await expect(
      renderRunReportMarkdown(buildRunReport(store, flows, FAIL_ID, AT)),
    ).toMatchFileSnapshot('__snapshots__/run-report-fail.md');
  });
});
