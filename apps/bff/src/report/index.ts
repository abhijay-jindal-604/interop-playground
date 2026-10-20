/**
 * Per-run interoperability report (plan/12 T-32; 08 §1.1, 04 §3.7 `RunReport`, API-45, 05 §4.4).
 * A read-time rendering of the persisted run: `runs` + `steps` + `checks` + the diagnosis events
 * (+ `run_versions` through the RunSpec), so it is always consistent with the log and still renders
 * after the heavy tier is pruned. JSON = `RunReport`; Markdown = the same fields in 08 §1.1 order.
 *
 * ADR-81: a run that ended `run.failed` / `run.cancelled` has no `RunVerdict`; the report states
 * outcome `inconclusive` (08 §2: environment fault) with the failing step and the error code as
 * error detail, and `countsTowardPassRate: false`.
 */
import { KNOB_CATALOG } from '@interop-playground/adapters';
import type {
  CheckResult,
  KnobId,
  RunReport,
  RunSpec,
  RunVerdict,
  Step,
} from '@interop-playground/api';
import { readDiagnosis } from '../diagnosis/index.js';
import { ApiError } from '../errors/index.js';
import type { FlowTable } from '../orchestrator/index.js';
import { apiState, getRunRow, isTerminal, listSteps } from '../runs/index.js';
import type { Store } from '../store/index.js';

/** public evidence of a fingerprint (ADR-98, ADR-100): its repo file, never a research S-ID */
const fingerprintPath = (fingerprintId: string): string => `fingerprints/${fingerprintId}.json`;

export const REPORT_GENERATOR_VERSION = 1;

function lastPayload<T>(store: Store, runId: string, type: string): T | null {
  const r = store.driver.get<{ payload_json: string }>(
    'SELECT payload_json FROM run_events WHERE run_id = ? AND type = ? ORDER BY seq DESC LIMIT 1',
    runId,
    type,
  );
  return r ? (JSON.parse(r.payload_json) as T) : null;
}

/** OID4VCI proof type and alg: the signed proof (engine.call sign-proof), else the run's holder key */
function proofTypeOf(store: Store, runId: string, spec: RunSpec): string {
  const sign = store.driver.get<{ payload_json: string }>(
    "SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'engine.call' AND json_extract(payload_json, '$.op') = 'sign-proof' ORDER BY seq LIMIT 1",
    runId,
  );
  const alg =
    (sign
      ? (JSON.parse(sign.payload_json) as { outputSummary?: { alg?: string } }).outputSummary?.alg
      : undefined) ??
    // only the public columns of holder_keys are read here (05 §6: never the private JWK)
    store.driver.get<{ alg: string }>(
      'SELECT k.alg AS alg FROM run_keys r JOIN holder_keys k ON k.key_id = r.key_id WHERE r.run_id = ? LIMIT 1',
      runId,
    )?.alg;
  if (spec.issuer === 'issuer.fixture') return 'none (fixture credential)';
  return alg ? `jwt (${alg})` : 'jwt';
}

function nonDefaultKnobs(spec: RunSpec): KnobId[] {
  return (Object.entries(spec.knobs) as [KnobId, string][])
    .filter(([id, v]) => {
      const k = KNOB_CATALOG.find((e) => e.def.id === id);
      return k !== undefined && k.def.defaultValue !== v;
    })
    .map(([id]) => id)
    .sort();
}

function terminalVerdict(store: Store, runId: string, spec: RunSpec, state: string): RunVerdict {
  const done = lastPayload<{ verdict: RunVerdict }>(store, runId, 'run.completed');
  if (state === 'completed' && done) return done.verdict;
  const failed = lastPayload<{ stepKey: string | null }>(store, runId, 'run.failed');
  const cancelled = lastPayload<{ atStepKey: string | null }>(store, runId, 'run.cancelled');
  return {
    kind:
      spec.tamperCase !== null
        ? 'tamper'
        : spec.presentationMode === 'dc-api'
          ? 'probe'
          : 'interop',
    outcome: 'inconclusive',
    issuanceOk: null,
    verification: null,
    tamperVerdict: null,
    failedStepKey: failed?.stepKey ?? cancelled?.atStepKey ?? null,
    countsTowardPassRate: false,
  };
}

function errorDetailOf(
  store: Store,
  runId: string,
  state: string,
  verdict: RunVerdict,
  steps: Step[],
  failing: CheckResult[],
): string | null {
  if (state === 'failed') {
    const f = lastPayload<{ errorCode: string; message: string }>(store, runId, 'run.failed');
    return f ? `${f.errorCode}: ${f.message}` : 'run failed';
  }
  if (state === 'cancelled') return 'run cancelled';
  if (verdict.outcome === 'pass') return null;
  if (verdict.outcome === 'no-submission') return 'no presentation reached the verifier';
  const step = steps.find((s) => s.stepKey === verdict.failedStepKey);
  const onStep = step?.checks.filter((c) => c.outcome === 'fail') ?? [];
  // the verbatim upstream code first (the root cause), then the failed step's own check
  const c = failing.find((x) => x.code !== undefined) ?? onStep[0] ?? failing[0];
  if (c)
    return [c.code, c.message].filter((x) => x !== undefined && x !== '').join(': ') || c.checkId;
  return verdict.failedStepKey ? `${verdict.failedStepKey} failed` : null;
}

export function claimSentenceOf(
  store: Store,
  runId: string,
  spec: RunSpec,
  result: string | null,
): string | null {
  if (result !== 'fixed' || spec.parentRunId === null || spec.knobDelta === null) return null;
  const cause = store.driver.get<{
    fingerprint_id: string;
    title: string;
    gap_ids_json: string;
  }>(
    "SELECT fingerprint_id, title, gap_ids_json FROM fingerprint_matches WHERE run_id = ? AND role = 'cause' AND confidence = 'exact' ORDER BY seq LIMIT 1",
    spec.parentRunId,
  );
  if (!cause) return null;
  const knob = KNOB_CATALOG.find((k) => k.def.id === spec.knobDelta?.knobId);
  const gaps = (JSON.parse(cause.gap_ids_json) as string[]).join(', ');
  const d = spec.knobDelta;
  return (
    `${spec.issuer} → ${spec.wallet} → ${spec.verifier} (${spec.format}) fails because ${cause.title} ` +
    `[${cause.fingerprint_id}${gaps ? `, ${gaps}` : ''}]. Changing only ${knob?.def.name ?? d.knobId} from ` +
    `${d.from} to ${d.to} makes it pass. Evidence: run ${spec.parentRunId} vs run ${runId}; ` +
    `fingerprint ${fingerprintPath(cause.fingerprint_id)}.${knob ? ` (${knob.label})` : ''}`
  );
}

/** API-45 JSON: `not_found` for an unknown run, `run_not_terminal` before the terminal event */
export function buildRunReport(
  store: Store,
  flows: FlowTable,
  runId: string,
  now: () => Date = () => new Date(),
): RunReport {
  const row = getRunRow(store, runId);
  const state = apiState(row.state);
  if (!isTerminal(state))
    throw new ApiError('run_not_terminal', 'The run has not finished yet.', { state });
  const spec = JSON.parse(row.spec_json) as RunSpec;
  const verdict = terminalVerdict(store, runId, spec, state);
  const steps = listSteps(store, flows, runId);
  const allChecks = steps.flatMap((s) => s.checks);
  const failingChecks = allChecks.filter((c) => c.outcome === 'fail');
  const tamper = allChecks.find((c) => c.tamper !== undefined)?.tamper ?? null;
  return {
    reportVersion: 1,
    runId,
    generatedAt: now().toISOString(),
    fields: {
      issuer: spec.issuer,
      wallet: spec.wallet,
      verifier: spec.verifier,
      format: spec.format,
      proofType: proofTypeOf(store, runId, spec),
      grant: spec.grant,
      mode: spec.presentationMode,
      env: spec.env,
      versions: spec.versions,
      knobs: spec.knobs,
      nonDefaultKnobs: nonDefaultKnobs(spec),
      verdict,
      failedStepKey: verdict.failedStepKey,
      failingChecks,
      errorDetail: errorDetailOf(store, runId, state, verdict, steps, failingChecks),
    },
    diagnosis: readDiagnosis(store, runId),
    claimSentence: claimSentenceOf(store, runId, spec, row.counterfactual_result),
    tamper,
    steps: steps.map((s) => ({
      stepKey: s.stepKey,
      outcome: s.outcome,
      capture: s.capture,
      skipReason: s.skipReason,
    })),
  };
}

// ---------- Markdown (08 §1.1) ----------
const WORD: Record<RunVerdict['outcome'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  blocked: 'BLOCKED',
  lenient: 'LENIENT',
  inconclusive: 'INCONCLUSIVE',
  'no-submission': 'NO-SUBMISSION',
};

/** one table cell: no pipes or newlines break the row */
function cell(v: unknown): string {
  const s =
    v === null || v === undefined || v === ''
      ? '—'
      : typeof v === 'string'
        ? v
        : typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : JSON.stringify(v);
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(head: string[], rows: unknown[][]): string[] {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
}

const roles = ['issuer', 'wallet', 'verifier'] as const;

export function renderRunReportMarkdown(r: RunReport): string {
  const f = r.fields;
  const out: string[] = [`# Run ${r.runId}: ${WORD[f.verdict.outcome]}`, ''];
  out.push(`Generated ${r.generatedAt} (report version ${r.reportVersion}).`, '');
  const knobs = Object.entries(f.knobs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, v]) => `${id}=${v}${f.nonDefaultKnobs.includes(id as KnobId) ? '*' : ''}`)
    .join(', ');
  out.push(
    ...table(
      ['Field', 'Value'],
      [
        ['Issuer', f.issuer],
        ['Wallet', f.wallet],
        ['Verifier', f.verifier],
        ['Format', f.format],
        ['Proof type', f.proofType],
        ['Grant', f.grant],
        ['Mode', f.mode],
        ['Environment', roles.map((k) => `${k} ${f.env[k]}`).join(', ')],
        ...roles.map((k) => [`Version (${k})`, f.versions[k]]),
        [
          'Knobs',
          knobs ? `${knobs}${f.nonDefaultKnobs.length ? ' (* = non-default)' : ''}` : 'none',
        ],
        ['Verdict', WORD[f.verdict.outcome]],
        ['Failed step', f.failedStepKey],
        ['Error detail', f.errorDetail],
      ],
    ),
    '',
  );

  out.push('## Failing checks', '');
  if (f.failingChecks.length === 0) out.push('None.', '');
  else
    out.push(
      ...table(
        ['Check', 'Source', 'Status / code', 'Spec clause', 'Message'],
        f.failingChecks.map((c) => [
          c.checkId,
          c.source,
          c.code ?? c.outcome,
          c.specClause,
          c.message,
        ]),
      ),
      '',
    );

  const d = r.diagnosis;
  out.push('## Diagnosis', '');
  const causes = d.matches.filter((m) => m.role === 'cause');
  const findings = d.matches.filter((m) => m.role === 'finding');
  if (causes.length === 0)
    out.push(
      f.verdict.outcome === 'pass'
        ? 'No cause to diagnose (the run passed).'
        : 'Unclassified: no fingerprint matched; the raw failing checks are listed above.',
      '',
    );
  else {
    if (causes.length > 1) out.push('Possible causes (more than one fingerprint matched):', '');
    out.push(
      ...table(
        [
          'Fingerprint',
          'Title',
          'Gaps',
          'Confidence',
          'Deviating side',
          'Component',
          'Spec clause',
          'Evidence',
          'Exchanges',
        ],
        causes.map((m) => [
          `${m.fingerprintId} v${m.fingerprintVersion}`,
          m.title,
          m.gapIds.join(', '),
          m.confidence,
          m.deviatingSide,
          `${m.component.name} ${m.component.versions}`,
          m.specClause,
          fingerprintPath(m.fingerprintId),
          m.matchedExchangeIds.join(', '),
        ]),
      ),
      '',
    );
  }
  if (findings.length > 0)
    out.push(
      'Findings:',
      '',
      ...findings.map(
        (m) => `- ${m.fingerprintId} (${m.confidence}): ${m.title} [${m.gapIds.join(', ')}]`,
      ),
      '',
    );

  out.push('## Fix-it', '');
  if (d.offers.length > 0)
    for (const o of d.offers) {
      const knob = KNOB_CATALOG.find((k) => k.def.id === o.knobId);
      out.push(
        `- ${o.knobId} \`${knob?.def.name ?? o.knobId}\`: ${o.from} → ${o.to} (${knob?.label ?? o.applyKind}); proven by an earlier re-run.`,
      );
    }
  else out.push(d.noFixReason ? `Diagnosis only: ${d.noFixReason}.` : 'Not applicable.');
  if (r.claimSentence) out.push('', r.claimSentence);
  out.push('');

  if (r.tamper) {
    const t = r.tamper;
    out.push(
      '## Tamper',
      '',
      ...table(
        ['Case', 'Expected', 'Observed', 'Verdict', 'Findings', 'Reason'],
        [
          [
            t.tmpId,
            t.expected,
            t.observed,
            t.verdict.toUpperCase(),
            t.findings.join(', '),
            t.reason,
          ],
        ],
      ),
      '',
    );
  }

  out.push('## Coverage', '');
  if (d.coverageBanner.length === 0) out.push('Every performed step was captured in full.', '');
  else
    out.push(
      ...d.coverageBanner.map(
        (c) => `- ${c.stepKey}: ${c.capture}${c.reason ? ` (${c.reason})` : ''}`,
      ),
      '',
    );

  out.push(
    '## Steps',
    '',
    ...table(
      ['Step', 'Outcome', 'Capture'],
      r.steps.map((s) => [
        s.stepKey,
        s.outcome ?? 'pending',
        `${s.capture ?? '—'}${s.skipReason ? ` (${s.skipReason})` : ''}`,
      ]),
    ),
    '',
  );
  return out.join('\n');
}
