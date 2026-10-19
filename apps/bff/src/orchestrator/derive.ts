/**
 * Derive (plan/12 T-42; 04 API-24, §5.4, 02 §5.7, 09 A4, A5, ADR-21): checks a counterfactual
 * re-run request against its parent in the order of 04 §5.4 (first failure answers) and builds the
 * child RunSpec: the parent's spec with exactly one knob changed through that knob's applier.
 * Adapters read the knob from `RunSpec.knobs` (`AdapterContext.knobs`); the appliers here change
 * only the spec fields a knob's application implies (KNOB-02: the issuer target; KNOB-07: the
 * effective client-id scheme and its presentation flow). Holder key reuse is the key service's
 * (`parentRunId` → the parent's key).
 */
import { KNOB_CATALOG, knobEntry } from '@interop-playground/adapters';
import type { AdapterId, KnobId, Role, RunSpec } from '@interop-playground/api';
import { ApiError, issueDetails } from '../errors/index.js';
import { readDiagnosis } from '../diagnosis/index.js';
import { apiState, getRunRow, isTerminal } from '../runs/index.js';
import type { Store } from '../store/index.js';
import { knobApplies, resolveKnobs } from '../catalog/knobs.js';
import type { FlowTable } from './flows.js';
import { presentationFlowOf, shippedFlow } from './resolve.js';
import type { ResolveEnv } from './resolve.js';

export interface DeriveRequestBody {
  knobId: KnobId;
  value: string;
}

/** 04 §1: the JSON Schema of `DeriveRequest` (unknown keys rejected) */
export function validateDeriveRequest(body: unknown): DeriveRequestBody {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new ApiError(
      'validation_failed',
      undefined,
      issueDetails([{ path: '$', message: 'must be an object' }]),
    );
  const b = body as Record<string, unknown>;
  const issues: { path: string; message: string }[] = [];
  for (const k of Object.keys(b))
    if (k !== 'knobId' && k !== 'value') issues.push({ path: `$.${k}`, message: 'unknown field' });
  for (const k of ['knobId', 'value'])
    if (typeof b[k] !== 'string' || b[k] === '')
      issues.push({ path: `$.${k}`, message: 'non-empty string' });
  if (issues.length > 0) throw new ApiError('validation_failed', undefined, issueDetails(issues));
  return b as unknown as DeriveRequestBody;
}

const ROLES: Role[] = ['issuer', 'wallet', 'verifier'];

/**
 * The knob appliers by `appliesAt` (02 §5.7). Every applier writes the knob value into `knobs`;
 * `issuer-target-switch` also switches the issuer adapter (the knob's application, not a second
 * delta, 04 §5.4); KNOB-07 (`verifier-request`) sets the effective `clientIdScheme`, which selects
 * the presentation flow (04 §4.2). The rest (`issuer-variant-config`, `peer-runtime-option`,
 * `wallet-runtime`, `adapter-setting`, KNOB-10) are read by their adapter from the spec's knobs.
 */
export function applyKnob(
  parent: RunSpec,
  knobId: KnobId,
  value: string,
  flows: FlowTable,
): RunSpec {
  const k = knobEntry(knobId);
  if (k === undefined) throw new Error(`unknown knob ${knobId}`);
  let issuer: AdapterId = parent.issuer;
  if (k.def.appliesAt === 'issuer-target-switch')
    issuer = value === 'alpha1-template' ? 'issuer.certify-preauth' : 'issuer.certify-mdoc';
  let knobs: Record<string, string> = { ...parent.knobs, [knobId]: value };
  if (issuer !== parent.issuer) {
    // the switched target's knob set: defaults for its knobs, the parent's values where shared
    const target = {
      issuer,
      wallet: parent.wallet,
      verifier: parent.verifier,
      format: parent.format,
    };
    const carried: Record<string, string> = Object.fromEntries(
      Object.entries(knobs).filter(([id]) => {
        const e = knobEntry(id);
        return e !== undefined && knobApplies(e, target);
      }),
    );
    knobs = resolveKnobs(target, carried, undefined, []);
  }
  let clientIdScheme = parent.clientIdScheme;
  let presentationFlowId = parent.presentationFlowId;
  if (knobId === 'KNOB-07' && parent.wallet !== 'wallet.inji-mobile') {
    clientIdScheme = value as RunSpec['clientIdScheme'];
    if (parent.presentationMode !== null && parent.scope === 'full') {
      const wanted = presentationFlowOf(
        {
          issuer,
          wallet: parent.wallet,
          verifier: parent.verifier,
          grant: parent.grant ?? 'pre-authorized_code',
          presentationMode: parent.presentationMode,
          format: parent.format,
        },
        parent.delivery,
        clientIdScheme,
      );
      presentationFlowId = shippedFlow(flows, wanted) ?? wanted;
    }
  }
  return { ...parent, issuer, knobs, clientIdScheme, presentationFlowId };
}

/** knob ids whose value differs between two specs (a knob absent on one side counts when not default) */
export function knobDiff(ka: RunSpec['knobs'], kb: RunSpec['knobs']): string[] {
  const a = ka as Record<string, string | undefined>;
  const b = kb as Record<string, string | undefined>;
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ids].filter((id) => {
    const x = a[id];
    const y = b[id];
    if (x !== undefined && y !== undefined) return x !== y;
    const d = knobEntry(id)?.def.defaultValue;
    return (x ?? y) !== d;
  });
}

/** 09 A5.6: the first run up the lineage (the parent included) whose knobDelta changed `knobId` */
export function ancestorChanging(store: Store, runId: string, knobId: string): string | null {
  const seen = new Set<string>();
  let id: string | null = runId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const row: { spec_json: string; parent_run_id: string | null } | undefined = store.driver.get<{
      spec_json: string;
      parent_run_id: string | null;
    }>('SELECT spec_json, parent_run_id FROM runs WHERE run_id = ?', id);
    if (!row) return null;
    const spec = JSON.parse(row.spec_json) as RunSpec;
    if (spec.knobDelta?.knobId === knobId) return id;
    id = row.parent_run_id;
  }
  return null;
}

/**
 * ADR-21 environment checks against the current probes: the first role whose version fingerprint
 * changed (`version_drift`), else a tunnel the parent depended on that is down or moved
 * (`environment_changed`); null when the parent can be re-run as it was. `skipIssuer` when the
 * knob itself switches the issuer (KNOB-02).
 */
export function driftOf(
  spec: RunSpec,
  env: ResolveEnv,
  skipIssuer = false,
):
  | { code: 'version_drift'; details: { column: Role; was: string; now: string } }
  | { code: 'environment_changed'; details: { was: string | null; now: string | null } }
  | null {
  for (const role of ROLES) {
    if (role === 'issuer' && skipIssuer) continue;
    const now = env.availability(spec[role])?.versionFingerprint ?? 'unprobed';
    const was = spec.versions[role];
    if (now !== was) return { code: 'version_drift', details: { column: role, was, now } };
  }
  if (spec.tunnelHost !== null) {
    const t = env.tunnel();
    if (!t.up || t.host !== spec.tunnelHost)
      return {
        code: 'environment_changed',
        details: { was: spec.tunnelHost, now: t.up ? t.host : null },
      };
  }
  return null;
}

export interface DerivePlan {
  spec: RunSpec;
  parentRunId: string;
}

/**
 * 04 §5.4 checks, in order: `not_found`, `run_not_terminal`, `key_unavailable` (imported parent),
 * `tamper_run_not_derivable`, `parent_not_failed`, `knob_invalid`, `knob_not_applicable`,
 * `derive_not_one_knob`, `fix_not_offered`, `knob_reverted`, `version_drift`,
 * `environment_changed`, `adapter_unavailable` (probe). The adapter set and the queue
 * (`queue_full`) are checked by the orchestrator when it enqueues the child.
 */
export function planDerive(
  store: Store,
  flows: FlowTable,
  env: ResolveEnv,
  parentRunId: string,
  body: unknown,
): DerivePlan {
  const req = validateDeriveRequest(body);
  const row = getRunRow(store, parentRunId);
  const state = apiState(row.state);
  if (!isTerminal(state))
    throw new ApiError('run_not_terminal', 'The parent run has not finished yet.', { state });
  if (row.origin === 'imported')
    throw new ApiError(
      'key_unavailable',
      'Imported runs cannot be re-run: their holder key is not in the bundle.',
      { runId: parentRunId },
    );
  const parent = JSON.parse(row.spec_json) as RunSpec;
  if (parent.tamperCase !== null)
    throw new ApiError('tamper_run_not_derivable', 'Tamper runs are not re-run with a fix.', {
      tmpId: parent.tamperCase,
    });
  const outcome = store.driver.get<{ outcome: string | null }>(
    'SELECT outcome FROM runs WHERE run_id = ?',
    parentRunId,
  )?.outcome;
  if (state !== 'completed' || outcome !== 'fail')
    throw new ApiError('parent_not_failed', 'Only a failed run can be re-run with a fix.', {
      outcome: state === 'completed' ? (outcome ?? null) : state,
    });
  const k = KNOB_CATALOG.find((e) => e.def.id === req.knobId);
  if (k === undefined)
    throw new ApiError('knob_invalid', `Unknown knob ${req.knobId}.`, { knobId: req.knobId });
  if (!k.def.values.includes(req.value))
    throw new ApiError('knob_invalid', `${req.knobId} has no value ${req.value}.`, {
      knobId: req.knobId,
      allowed: [...k.def.values],
    });
  const current = (parent.knobs as Record<string, string | undefined>)[req.knobId];
  if (current === undefined) {
    const reason =
      parent.issuer === 'issuer.certify-collab' && k.def.appliesAt.startsWith('issuer-')
        ? 'collab-no-write'
        : 'not-applicable';
    throw new ApiError('knob_not_applicable', `${req.knobId} does not apply to this run.`, {
      knobId: req.knobId,
      reason,
    });
  }
  if (req.knobId === 'KNOB-07' && parent.wallet === 'wallet.inji-mobile')
    throw new ApiError(
      'knob_not_applicable',
      'Inji Wallet uses a fixed request profile (redirect_uri).',
      { knobId: req.knobId, reason: 'fixed-request-profile' },
    );
  if (current === req.value)
    throw new ApiError('derive_not_one_knob', `${req.knobId} already is ${req.value}.`, {
      reason: 'no-change',
    });
  const diagnosis = readDiagnosis(store, parentRunId);
  const offer = diagnosis.offers.find((o) => o.knobId === req.knobId && o.to === req.value);
  if (offer === undefined)
    throw new ApiError('fix_not_offered', "The run's diagnosis did not offer this change.", {
      knobId: req.knobId,
      value: req.value,
    });
  const ancestor = ancestorChanging(store, parentRunId, req.knobId);
  if (ancestor !== null)
    throw new ApiError('knob_reverted', `An earlier run in this lineage changed ${req.knobId}.`, {
      knobId: req.knobId,
      ancestorRunId: ancestor,
    });
  const applied = applyKnob(parent, req.knobId, req.value, flows);
  const switched = applied.issuer !== parent.issuer;
  const drift = driftOf(parent, env, switched);
  if (drift !== null)
    throw new ApiError(
      drift.code,
      drift.code === 'version_drift'
        ? `The ${drift.details.column} version changed since this run.`
        : 'The tunnel changed since this run.',
      drift.details,
    );
  const diff = knobDiff(parent.knobs, applied.knobs);
  if (diff.length !== 1 || diff[0] !== req.knobId)
    throw new ApiError('derive_not_one_knob', 'The change would alter more than one knob.', {
      reason: 'side-effect',
      knobIds: diff,
    });
  for (const role of ROLES) {
    const id = applied[role];
    const a = env.availability(id);
    if (a && !a.available)
      throw new ApiError('adapter_unavailable', `${id} is not available.`, {
        adapterId: id,
        reason: a.reason ?? 'probe failed',
      });
  }
  const versions = { ...parent.versions };
  if (switched)
    versions.issuer = env.availability(applied.issuer)?.versionFingerprint ?? 'unprobed';
  const spec: RunSpec = {
    ...applied,
    versions,
    tamperCase: null,
    parentRunId,
    knobDelta: { knobId: req.knobId, from: current, to: req.value },
    causeFingerprintId: offer.fingerprintId,
    suiteId: null,
    controlRunId: null,
  };
  return { spec, parentRunId };
}
