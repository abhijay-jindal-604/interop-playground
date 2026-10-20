/**
 * T-44 golden (plan/12; 09 A5, A7 FP-01, A10 step 1; S-077, S-120, G-55): the first fix-it re-run
 * as recorded live on the bundle (walt.id issuer-api2 → wallet.playground-ts → local Inji Verify,
 * FLOW-08 + FLOW-30). The parent (KNOB-01 `absent`) and its derived child (`present`) are replayed
 * from `fixtures/golden/fixit/` into a fresh store through the sink, minus the events the live C12
 * engine and classifier produced, which are then recomputed here:
 *  - parent: fails at `vp.verdict.evaluate`; FP-01 matches exactly as cause with the KNOB-01 offer;
 *  - child: one knob changed (KNOB-01 absent → present), passes, FP-01 does not match;
 *  - classification `fixed` and the API-31 claim sentence (09 A5.4), with the knob's direct effect
 *    (the credential header's `x5c`) first in the compare diff.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, RunSpec, RunVerdict } from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import { loadFlowTable } from '../orchestrator/index.js';
import { compareRuns } from '../runs/compare.js';
import { openStore } from '../store/index.js';
import type { SinkEvent, Store } from '../store/index.js';
import { classifyStoredChild } from './classify.js';
import { DiagnosisEngine, loadEvidence, loadLibrary, readDiagnosis } from './index.js';

const DIR = path.join(REPO_ROOT, 'fixtures', 'golden', 'fixit');
const LIBRARY = loadLibrary(path.join(REPO_ROOT, 'fingerprints'));
const FLOWS = loadFlowTable(path.join(REPO_ROOT, 'flows'));
/** produced by C12 / the classifier at the end of a live run: recomputed, not replayed */
const DERIVED = new Set(['fingerprint.matched', 'counterfactual.offered', 'run.completed']);

const load = (name: string): EventEnvelope[] =>
  JSON.parse(readFileSync(path.join(DIR, name), 'utf8')) as EventEnvelope[];

type WireBody = { encoding: 'utf8' | 'base64'; text: string } | null;

/** replays a recorded run (all but its terminal and diagnosis events) through the sink */
function replay(store: Store, events: EventEnvelope[]): { runId: string; spec: RunSpec } {
  const created = events[0] as EventEnvelope<'run.created'>;
  const { runId } = created;
  const spec = created.payload.spec;
  store.sink.createSuite({
    suiteId: `${runId}-s`,
    name: 'T-44 golden',
    triggerKind: 'interactive',
    envClass: 'local',
    appVersion: '0.0.0',
  });
  store.sink.createRun({
    runId,
    suiteId: `${runId}-s`,
    triggerKind: spec.parentRunId === null ? 'interactive' : 'derive',
    flowId: spec.presentationFlowId ?? spec.issuanceFlowId,
    spec,
    knobsAllDefault: false,
    targetStepKey: 'vp.verdict.evaluate',
    evidenceTier: 'automated',
    appVersion: '0.0.0',
  });
  for (const e of events.slice(1)) {
    if (DERIVED.has(e.type)) continue;
    const step = e.stepKey ? { stepKey: e.stepKey } : {};
    let payload = e.payload as Record<string, unknown>;
    if (e.type === 'exchange.request' || e.type === 'exchange.response') {
      const b = payload.body as WireBody;
      const headers = payload.headers as [string, string][] | undefined;
      const ct = headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? null;
      const { bodyState: _drop, ...rest } = payload;
      payload = {
        ...rest,
        body:
          b === null
            ? null
            : {
                bytes: b.encoding === 'base64' ? Buffer.from(b.text, 'base64') : b.text,
                contentType: ct,
              },
      };
    }
    store.sink.append(runId, { type: e.type, ...step, payload } as SinkEvent);
  }
  return { runId, spec };
}

const verdictOf = (events: EventEnvelope[]): RunVerdict =>
  (events.at(-1) as EventEnvelope<'run.completed'>).payload.verdict;

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

describe('T-44 golden: walt.id → playground-ts → Inji Verify (local), FP-01 + KNOB-01', () => {
  const parentEvents = load('T-44-parent-events.json');
  const childEvents = load('T-44-child-events.json');

  it('the recorded pair is one knob apart and the live run ended fail → pass, fixed', () => {
    const p = (parentEvents[0] as EventEnvelope<'run.created'>).payload.spec;
    const c = (childEvents[0] as EventEnvelope<'run.created'>).payload.spec;
    expect([p.issuer, p.wallet, p.verifier, p.format]).toEqual([
      'issuer.waltid',
      'wallet.playground-ts',
      'verifier.inji-verify-local',
      'dc+sd-jwt',
    ]);
    expect([p.issuanceFlowId, p.presentationFlowId]).toEqual(['FLOW-08', 'FLOW-30']);
    expect(p.knobs['KNOB-01']).toBe('absent');
    expect(c.parentRunId).toBe(parentEvents[0]?.runId);
    expect(c.knobDelta).toEqual({ knobId: 'KNOB-01', from: 'absent', to: 'present' });
    expect(c.causeFingerprintId).toBe('FP-01');
    expect({ ...c.knobs, 'KNOB-01': 'absent' }).toEqual(p.knobs);
    expect(verdictOf(parentEvents)).toMatchObject({
      outcome: 'fail',
      failedStepKey: 'vp.verdict.evaluate',
    });
    expect(verdictOf(childEvents).outcome).toBe('pass');
    expect(
      (childEvents.at(-1) as EventEnvelope<'run.completed'>).payload.counterfactualResult,
    ).toBe('fixed');
    // the issuer key's private `d` sent with `present` was stored redacted (ADR-83)
    expect(JSON.stringify(childEvents)).toContain('«redacted:WALTID_ISSUER_KEY_D»');
  });

  it('parent: FP-01 exact cause with the KNOB-01 offer; child: FP-01 absent; fixed + claim', () => {
    const store = openStore(':memory:');
    stores.push(store);
    const engine = new DiagnosisEngine(store, LIBRARY);

    const parent = replay(store, parentEvents);
    const pr = engine.diagnoseRun(parent.runId, 'completed');
    expect(pr.noFixReason).toBeNull();
    expect(
      pr.emissions.map((e) => [e.match.fingerprintId, e.match.confidence, e.match.role]),
    ).toEqual([['FP-01', 'exact', 'cause']]);
    expect(pr.emissions[0]?.stepKey).toBe('vp.verdict.evaluate');
    expect(pr.emissions[0]?.offer).toMatchObject({
      knobId: 'KNOB-01',
      from: 'absent',
      to: 'present',
      knobStatus: 'proven',
    });
    // the evidence: the credential exchange (no x5c) and Inji Verify's vc.signature failure
    expect(pr.emissions[0]?.match.matchedExchangeIds).toContain(`${parent.runId}:6`);
    const ev = loadEvidence(store, parent.runId);
    expect(ev.checks.find((c) => c.check.checkId === 'vc.signature')?.check).toMatchObject({
      outcome: 'fail',
      code: 'ERR_SIGNATURE_VERIFICATION_FAILED',
    });
    store.sink.append(parent.runId, {
      type: 'run.completed',
      payload: { verdict: verdictOf(parentEvents), counterfactualResult: null },
    });
    const d = readDiagnosis(store, parent.runId);
    expect(d.offers.map((o) => o.knobId)).toEqual(['KNOB-01']);

    const child = replay(store, childEvents);
    const cr = engine.diagnoseRun(child.runId, 'completed');
    expect(cr.emissions.filter((e) => e.match.role === 'cause')).toEqual([]);
    const result = classifyStoredChild(store, child.runId, verdictOf(childEvents));
    expect(result).toBe('fixed');
    store.sink.append(child.runId, {
      type: 'run.completed',
      payload: { verdict: verdictOf(childEvents), counterfactualResult: result },
    });

    const cmp = compareRuns(store, FLOWS, child.runId, parent.runId, {});
    expect(cmp.parent.runId).toBe(parent.runId); // parent first (OI-4)
    expect(cmp.classification).toBe('fixed');
    expect(cmp.claimSentence).toBe(
      'issuer.waltid → wallet.playground-ts → verifier.inji-verify-local (dc+sd-jwt) fails because ' +
        'Inji Verify cannot verify an SD-JWT VC whose issuer key is not given as an x5c chain ' +
        '[FP-01, G-55]. Changing only waltid.sdjwt.x5c from absent to present makes it pass. ' +
        `Evidence: run ${parent.runId} vs run ${child.runId}; fingerprint fingerprints/FP-01.json. ` +
        '(changed walt.id issuance option)',
    );
    // the knob's direct effect first: the credential header gains x5c
    expect(cmp.steps[0]?.stepKey).toBe('vci.credential');
    expect(cmp.steps[0]?.differences[0]?.path).toMatch(/#header\.x5c\[0\]$/);
    expect(storedResult(store, child.runId)).toBe('fixed');
  });
});

function storedResult(store: Store, runId: string): string | null {
  return (
    store.driver.get<{ r: string | null }>(
      'SELECT counterfactual_result AS r FROM runs WHERE run_id = ?',
      runId,
    )?.r ?? null
  );
}
