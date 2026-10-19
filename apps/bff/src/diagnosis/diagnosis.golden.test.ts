/**
 * T-41 acceptance (plan/12; 02 §7 golden tests, 09 A3, A6, A7 FP-01):
 *  - FP-01 (G-55) matches the S-077 run exactly and offers KNOB-01 absent → present; it does not
 *    match the S-120 run (same pipeline with x5c), which passes;
 *  - partial-hop evidence never yields an exact match (observed, no offer);
 *  - two full-evidence causes → both "possible", no offer;
 *  - `verdict.check`, `fingerprint.matched`, `counterfactual.offered` are emitted from the persisted
 *    events only, and the sink sets `cause_fingerprint_id` from them at `run.completed`;
 *  - the repository library loads and contains FP-01.
 */
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@interop-playground/api';
import { REPO_ROOT } from '../config/index.js';
import { openStore } from '../store/index.js';
import type { Store } from '../store/index.js';
import {
  DiagnosisEngine,
  diagnose,
  loadEvidence,
  loadLibrary,
  readDiagnosis,
  readLibrary,
} from './index.js';
import type { Fingerprint } from './index.js';
import { closeRun, goldenSteps, recordRun, verdictOf, waltidSpec } from './fixture-runs.js';

const LIBRARY = loadLibrary(path.join(REPO_ROOT, 'fingerprints'));
const FP01 = LIBRARY.find((f) => f.id === 'FP-01') as Fingerprint;

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
function store(): Store {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
}
const events = (s: Store, runId: string): EventEnvelope[] => s.reader.readEvents(runId, 0, 5000);

describe('diagnosis.library', () => {
  it('loads fingerprints/ and FP-01 is in it, valid against 09 A2', () => {
    const r = readLibrary(path.join(REPO_ROOT, 'fingerprints'));
    expect(r.errors).toEqual([]);
    expect(FP01).toBeDefined();
    expect(FP01.fix).toEqual({ knobId: 'KNOB-01', from: 'absent', to: 'present' });
  });

  it('rejects a malformed predicate and an unknown knob', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fp-'));
    try {
      writeFileSync(
        path.join(dir, 'FP-90.json'),
        JSON.stringify({
          ...FP01,
          id: 'FP-90',
          match: [[{ on: 'check', checkId: 'x', outcome: 'maybe' }]],
          fix: { knobId: 'KNOB-99', from: 'a', to: 'b' },
        }),
      );
      const r = readLibrary(dir);
      expect(r.fingerprints).toEqual([]);
      expect(r.errors[0]?.errors).toEqual(
        expect.arrayContaining([
          '$.match[0][0].outcome: pass or fail',
          '$.fix.knobId: unknown knob',
        ]),
      );
      expect(() => loadLibrary(dir)).toThrow(/fingerprint library invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('diagnosis.golden FP-01 (S-077 / S-120)', () => {
  it('S-077: exact cause FP-01 with the KNOB-01 offer; persisted and projected', () => {
    const s = store();
    const runId = recordRun(
      s,
      waltidSpec('absent'),
      goldenSteps('S-077-trace-waltid-to-collab.json'),
      null,
    );
    const result = new DiagnosisEngine(s, LIBRARY).diagnoseRun(runId, 'completed');
    expect(result.noFixReason).toBeNull();
    const ev = events(s, runId);
    const matched = ev.filter((e) => e.type === 'fingerprint.matched');
    expect(matched).toHaveLength(1);
    expect(matched[0]?.stepKey).toBe('vp.verdict.evaluate');
    expect(matched[0]?.payload).toMatchObject({
      fingerprintId: 'FP-01',
      gapIds: ['G-55'],
      confidence: 'exact',
      role: 'cause',
      deviatingSide: 'verifier',
      evidenceSIds: ['S-077', 'S-120'],
      fingerprintVersion: 1,
    });
    const offered = ev.filter((e) => e.type === 'counterfactual.offered');
    expect(offered.map((e) => e.payload)).toEqual([
      {
        fingerprintId: 'FP-01',
        knobId: 'KNOB-01',
        from: 'absent',
        to: 'present',
        knobStatus: 'proven',
        applyKind: 'peer-runtime-option',
        provenBy: ['S-077', 'S-120'],
      },
    ]);
    // the matched evidence: the vc.signature check, the credential exchange and the result fetch
    const p = matched[0]?.payload as { matchedExchangeIds: string[]; matchedEventSeqs: number[] };
    expect(p.matchedExchangeIds).toEqual([`${runId}:4`, `${runId}:1`]);
    expect(p.matchedEventSeqs.length).toBeGreaterThanOrEqual(2);
    closeRun(s, runId, { verdict: verdictOf('fail', 'vp.verdict.evaluate') });
    expect(
      s.driver.get<{ c: string | null }>(
        'SELECT cause_fingerprint_id AS c FROM runs WHERE run_id = ?',
        runId,
      )?.c,
    ).toBe('FP-01');
    const d = readDiagnosis(s, runId);
    expect(d.matches.map((m) => m.fingerprintId)).toEqual(['FP-01']);
    expect(d.offers).toHaveLength(1);
    expect(d.noFixReason).toBeNull();
  });

  it('S-120: the x5c credential passes and FP-01 does not match', () => {
    const s = store();
    const runId = recordRun(
      s,
      waltidSpec('present'),
      goldenSteps('S-120-trace-x5chain-to-collab.json'),
      null,
    );
    const ev = loadEvidence(s, runId);
    expect(ev.failedStepKey).toBeNull();
    const r = diagnose(LIBRARY, ev, 'completed');
    expect(r.emissions).toEqual([]);
    expect(r.noFixReason).toBeNull();
  });

  it('S-077 with the credential hop partial: observed only, never exact, no offer', () => {
    const s = store();
    const runId = recordRun(
      s,
      waltidSpec('absent'),
      goldenSteps('S-077-trace-waltid-to-collab.json', 'partial'),
      null,
    );
    const r = diagnose(LIBRARY, loadEvidence(s, runId), 'completed');
    expect(r.emissions.map((e) => [e.match.fingerprintId, e.match.confidence, e.offer])).toEqual([
      ['FP-01', 'observed', null],
    ]);
    expect(r.noFixReason).toBe('observed-only');
  });

  it('a knob already at its fix value, or a tamper run, gets no offer', () => {
    const s = store();
    const runId = recordRun(
      s,
      waltidSpec('present'),
      goldenSteps('S-077-trace-waltid-to-collab.json'),
      null,
    );
    const r = diagnose(LIBRARY, loadEvidence(s, runId), 'completed');
    expect(r.emissions[0]?.match.confidence).toBe('exact');
    expect(r.emissions[0]?.offer).toBeNull();
    expect(r.noFixReason).toBe('no-proven-knob');
    const t = recordRun(
      s,
      { ...waltidSpec('absent'), tamperCase: 'TMP-01' },
      goldenSteps('S-077-trace-waltid-to-collab.json'),
      null,
    );
    expect(diagnose(LIBRARY, loadEvidence(s, t), 'completed').noFixReason).toBe('tamper-run');
  });
});

describe('diagnosis.ranking (09 A3.4, A3.5)', () => {
  const twin: Fingerprint = {
    ...FP01,
    id: 'FP-90',
    title: 'A second cause on the same evidence',
    match: [[{ on: 'check', checkId: 'vp.verdict', outcome: 'fail' }]],
    fix: null,
    noFixReason: 'test',
  };
  const lint: Fingerprint = {
    ...FP01,
    id: 'FP-91',
    title: 'Credential carries no x5c (lint)',
    appliesWhen: 'always',
    stepKey: 'vci.credential',
    match: [[{ on: 'artifact', kind: 'credential-header', path: '$.x5c', op: 'absent' }]],
    fix: null,
    noFixReason: 'test',
    scope: { formats: ['dc+sd-jwt'] },
  };

  it('two full-evidence causes → both possible, no offer, "several-causes"', () => {
    const s = store();
    const runId = recordRun(
      s,
      waltidSpec('absent'),
      goldenSteps('S-077-trace-waltid-to-collab.json'),
      null,
    );
    const r = new DiagnosisEngine(s, [FP01, twin]).diagnoseRun(runId, 'completed');
    expect(
      r.emissions.map((e) => [e.match.fingerprintId, e.match.confidence, e.match.role]),
    ).toEqual([
      ['FP-01', 'possible', 'cause'],
      ['FP-90', 'possible', 'cause'],
    ]);
    expect(events(s, runId).filter((e) => e.type === 'counterfactual.offered')).toEqual([]);
    expect(r.noFixReason).toBe('several-causes');
    closeRun(s, runId, { verdict: verdictOf('fail', 'vp.verdict.evaluate') });
    expect(
      s.driver.get<{ c: string | null }>(
        'SELECT cause_fingerprint_id AS c FROM runs WHERE run_id = ?',
        runId,
      )?.c,
    ).toBeNull();
    expect(readDiagnosis(s, runId).noFixReason).toBe('several-causes');
  });

  it('an always-fingerprint off the failed step is a finding with a playground-lint info check', () => {
    const s = store();
    const runId = recordRun(
      s,
      waltidSpec('absent'),
      goldenSteps('S-077-trace-waltid-to-collab.json'),
      null,
    );
    const r = new DiagnosisEngine(s, [lint]).diagnoseRun(runId, 'completed');
    expect(
      r.emissions.map((e) => [e.match.fingerprintId, e.match.role, e.match.confidence]),
    ).toEqual([['FP-91', 'finding', 'exact']]);
    const check = events(s, runId).find(
      (e) =>
        e.type === 'verdict.check' &&
        (e.payload as { check: { checkId: string } }).check.checkId === 'diag.FP-91',
    );
    expect(check?.stepKey).toBe('vci.credential');
    expect(check?.payload).toMatchObject({
      check: {
        outcome: 'info',
        source: 'playground-lint',
        message: 'Credential carries no x5c (lint)',
      },
    });
    // a failing run whose only match is a finding is unclassified
    expect(r.noFixReason).toBe('unclassified');
  });

  it('out-of-scope and historical fingerprints are not candidates; replay is identical', () => {
    const s = store();
    const runId = recordRun(
      s,
      { ...waltidSpec('absent'), verifier: 'verifier.waltid' },
      goldenSteps('S-077-trace-waltid-to-collab.json'),
      null,
    );
    expect(diagnose(LIBRARY, loadEvidence(s, runId), 'completed').emissions).toEqual([]);
    const r2 = recordRun(
      s,
      waltidSpec('absent'),
      goldenSteps('S-077-trace-waltid-to-collab.json'),
      null,
    );
    expect(
      diagnose([{ ...FP01, status: 'historical' }], loadEvidence(s, r2), 'completed').emissions,
    ).toEqual([]);
    const a = diagnose(LIBRARY, loadEvidence(s, r2), 'completed');
    const b = diagnose(LIBRARY, loadEvidence(s, r2), 'completed');
    expect(b).toEqual(a);
  });
});
