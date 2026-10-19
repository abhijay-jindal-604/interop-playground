/**
 * API-31 compare (04 §2.3, §3.4 `CompareResponse`; 09 A5.5; 06 OI-4, ADR-85): a step-aligned diff
 * of two runs. Parent first: when the first run is the child (derived or tamper run) of the second,
 * the two are swapped, so `parent`/`child` always follow the lineage; unrelated runs keep the URL
 * order. Per step the diff covers the outcome, capture, checks, the exchanges (method, URL, status,
 * the JSON response body, compact JWS / SD-JWT strings expanded to header and payload) in order.
 * Volatile differences (nonces, timestamps, ids, signatures, salted digests) are dropped unless
 * `includeVolatile`. Rows whose step the knob changes directly (`directEffect`) come first.
 */
import { knobEntry } from '@interop-playground/adapters';
import type { CompareResponse, Run, Step } from '@interop-playground/api';
import { ApiError, issueDetails } from '../errors/index.js';
import { loadEvidence, parseArtifactText } from '../diagnosis/index.js';
import type { RunEvidence } from '../diagnosis/index.js';
import type { FlowTable } from '../orchestrator/flows.js';
import { claimSentenceOf } from '../report/index.js';
import type { Store } from '../store/index.js';
import { getRun, listSteps } from './index.js';

type Difference = CompareResponse['steps'][number]['differences'][number];

/** field names whose values change on every run (02 §1.3 item 4) */
const VOLATILE_KEYS = new Set([
  'nonce',
  'c_nonce',
  'c_nonce_expires_in',
  'expires_in',
  'state',
  'iat',
  'exp',
  'nbf',
  'jti',
  'timestamp',
  'date',
  'id',
  'access_token',
  'refresh_token',
  'pre-authorized_code',
  'code',
  'transactionId',
  'transaction_id',
  'requestId',
  'request_id',
  'sessionId',
  'session_id',
  'response_code',
  'request_uri',
  'vp_token',
  'sd_hash',
  '_sd',
  'proof',
  'jwt',
]);

const RANDOMISH =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}|\d{4}-\d{2}-\d{2}T[\d:.]+Z?|[0-9a-fA-F]{16,}|[A-Za-z0-9_-]{22,}|\d{6,}/g;

function keyVolatile(path: string): boolean {
  return path
    .split(/[.#[\]]/)
    .filter((s) => s !== '')
    .some((seg) => VOLATILE_KEYS.has(seg) || /(At|_at)$/.test(seg));
}

/** a difference is volatile when its key is, or when both values agree once random-looking runs are masked */
function isVolatile(path: string, a: unknown, b: unknown): boolean {
  if (keyVolatile(path)) return true;
  if (typeof a === 'string' && typeof b === 'string')
    return a.replace(RANDOMISH, '*') === b.replace(RANDOMISH, '*');
  return false;
}

const JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*(~|$)/;

/** flattens a JSON value to leaf paths; compact JWS / SD-JWT strings also yield `#header` / `#payload` */
function flatten(value: unknown, path: string, out: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(path, []);
    value.forEach((v, i) => flatten(v, `${path}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) out.set(path, {});
    for (const [k, v] of entries) flatten(v, path === '' ? k : `${path}.${k}`, out);
    return;
  }
  out.set(path, value);
  if (typeof value === 'string' && JWS.test(value.trim())) {
    const parsed = parseArtifactText(value);
    if (parsed.header !== undefined) flatten(parsed.header, `${path}#header`, out);
    if (parsed.value !== undefined && typeof parsed.value === 'object')
      flatten(parsed.value, `${path}#payload`, out);
  }
}

function bodyValue(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function stepContent(step: Step | null, ev: RunEvidence): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (step === null) return out;
  out.set('outcome', step.outcome);
  out.set('capture', step.capture);
  out.set('skipReason', step.skipReason);
  for (const c of ev.checks.filter((x) => x.stepKey === step.stepKey)) {
    const base = `checks.${c.check.checkId}`;
    out.set(`${base}.outcome`, c.check.outcome);
    if (c.check.code !== undefined) out.set(`${base}.code`, c.check.code);
    if (c.check.message !== undefined) out.set(`${base}.message`, c.check.message);
  }
  ev.exchanges
    .filter((x) => x.stepKey === step.stepKey)
    .forEach((x, i) => {
      const base = `exchanges[${i}]`;
      out.set(`${base}.method`, x.method);
      out.set(`${base}.url`, x.url);
      out.set(`${base}.status`, x.status);
      flatten(bodyValue(x.body), `${base}.response`, out);
    });
  return out;
}

function diffStep(
  parent: Map<string, unknown>,
  child: Map<string, unknown>,
  includeVolatile: boolean,
): Difference[] {
  const keys = [...new Set([...parent.keys(), ...child.keys()])];
  const out: Difference[] = [];
  for (const path of keys) {
    const a = parent.has(path) ? parent.get(path) : null;
    const b = child.has(path) ? child.get(path) : null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const volatile = parent.has(path) && child.has(path) && isVolatile(path, a, b);
    if (volatile && !includeVolatile) continue;
    out.push({ path, parent: a, child: b, volatile });
  }
  return out;
}

/** step-key prefixes where a knob's change shows directly (09 A5.5: x5c header, clientId, envelope) */
function directSteps(knobId: string | undefined): string[] {
  if (knobId === undefined) return [];
  const k = knobEntry(knobId);
  if (k === undefined) return [];
  switch (k.def.appliesAt) {
    case 'issuer-variant-config':
      return ['vci.setup.variant', 'vci.credential'];
    case 'issuer-target-switch':
      return ['vci.'];
    case 'wallet-runtime':
      return ['vci.credential', 'vci.proof'];
    case 'verifier-request':
      return ['vp.request.create'];
    case 'peer-runtime-option':
      return k.adapters.some((a) => a.startsWith('issuer.')) ? ['vci.credential'] : ['vp.'];
    default:
      return ['vp.'];
  }
}

export function compareRuns(
  store: Store,
  flows: FlowTable,
  firstId: string,
  secondId: string,
  q: Record<string, string | undefined>,
): CompareResponse {
  for (const k of Object.keys(q))
    if (k !== 'includeVolatile')
      throw new ApiError(
        'validation_failed',
        undefined,
        issueDetails([{ path: `$.query.${k}`, message: 'unknown parameter' }]),
      );
  const iv = q.includeVolatile;
  if (iv !== undefined && iv !== 'true' && iv !== 'false')
    throw new ApiError(
      'validation_failed',
      undefined,
      issueDetails([{ path: '$.query.includeVolatile', message: 'true or false' }]),
    );
  const includeVolatile = iv === 'true';
  let parent: Run = getRun(store, firstId);
  let child: Run = getRun(store, secondId);
  // OI-4: parent first; swap when the first run is the second's child or tamper run
  if (
    parent.spec.parentRunId === child.runId ||
    (parent.spec.controlRunId !== null && parent.spec.controlRunId === child.runId)
  )
    [parent, child] = [child, parent];
  const relation: CompareResponse['relation'] =
    child.spec.parentRunId === parent.runId
      ? 'derived'
      : child.spec.controlRunId === parent.runId
        ? 'control-tamper'
        : 'unrelated';
  const pSteps = listSteps(store, flows, parent.runId);
  const cSteps = listSteps(store, flows, child.runId);
  const shared = pSteps.some((s) => cSteps.some((c) => c.stepKey === s.stepKey));
  if (!shared)
    throw new ApiError('compare_not_comparable', 'The runs share no step.', {
      reason: 'no-shared-step',
    });
  if (relation === 'unrelated' && parent.spec.scope !== child.spec.scope)
    throw new ApiError('compare_not_comparable', 'The runs have different scopes.', {
      reason: 'different-scope',
    });
  const pEv = loadEvidence(store, parent.runId);
  const cEv = loadEvidence(store, child.runId);
  const knobDelta = relation === 'derived' ? child.spec.knobDelta : null;
  const direct = directSteps(knobDelta?.knobId);
  const keys = [
    ...pSteps.map((s) => s.stepKey),
    ...cSteps.map((s) => s.stepKey).filter((k) => !pSteps.some((s) => s.stepKey === k)),
  ];
  const steps = keys.map((stepKey) => {
    const p = pSteps.find((s) => s.stepKey === stepKey) ?? null;
    const c = cSteps.find((s) => s.stepKey === stepKey) ?? null;
    const differences = diffStep(stepContent(p, pEv), stepContent(c, cEv), includeVolatile);
    const directEffect =
      differences.some((d) => !d.volatile) && direct.some((pre) => stepKey.startsWith(pre));
    return { stepKey, parent: p, child: c, differences, directEffect };
  });
  // 09 A5.5: the knob's direct effect first; otherwise the parent's step order
  steps.sort((a, b) => Number(b.directEffect) - Number(a.directEffect));
  const classification = relation === 'derived' ? child.counterfactualResult : null;
  return {
    parent,
    child,
    relation,
    knobDelta,
    classification,
    claimSentence:
      relation === 'derived'
        ? claimSentenceOf(store, child.runId, child.spec, classification)
        : null,
    steps,
  };
}
