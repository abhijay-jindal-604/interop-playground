/**
 * Angle A on the run screen and the report (06 UI-24..UI-28, 09 A3, A5): pure decisions over the
 * API-30 `DiagnosisResponse`, API-31 `CompareResponse`, API-33 `LineageResponse` and API-04
 * knob entries. The components in this folder only render what these functions decide.
 */
import type {
  CompareResponse,
  CounterfactualOfferedPayload,
  DiagnosisResponse,
  FingerprintMatchedPayload,
  KnobEntry,
  Run,
} from '@interop-playground/api';

export type Match = FingerprintMatchedPayload;

/** 09 A2's six sides (G-151); the wider union is accepted whether or not the API type has it yet */
export type DeviatingSide =
  | FingerprintMatchedPayload['deviatingSide']
  | 'issuer'
  | 'wallet'
  | 'verifier'
  | 'issuer+verifier'
  | 'environment'
  | 'playground';

export const SIDE_WORD: Record<DeviatingSide, string> = {
  issuer: 'Issuer',
  wallet: 'Wallet',
  verifier: 'Verifier',
  'issuer+verifier': 'Issuer and verifier',
  environment: 'Environment',
  playground: 'Playground',
};

/** Display word for the side a diagnosis blames (issuer, wallet or verifier). */
export const sideWord = (side: string): string => SIDE_WORD[side as DeviatingSide] ?? side;

export type DiagnosisCase = 'exact' | 'possible' | 'observed' | 'unclassified';

export interface DiagnosisView {
  kind: DiagnosisCase;
  /** `role: cause` matches, the exact or first one first */
  causes: Match[];
  /** `role: finding` matches (lint on passing steps) */
  findings: Match[];
}

/** UI-24 "One of four cases (decided by the matches with `role = cause`)" */
export function diagnosisCase(d: Pick<DiagnosisResponse, 'matches'>): DiagnosisView {
  const causes = d.matches.filter((m) => m.role === 'cause');
  const findings = d.matches.filter((m) => m.role === 'finding');
  if (causes.length === 0) return { kind: 'unclassified', causes, findings };
  if (causes.length === 1) {
    const only = causes[0]!;
    if (only.confidence === 'exact') return { kind: 'exact', causes, findings };
    if (only.confidence === 'observed') return { kind: 'observed', causes, findings };
  }
  // ≥ 2 causes (A3.4: all shown as possible), or a lone `possible`: never upgraded
  return { kind: 'possible', causes, findings };
}

export interface FixItDecision {
  offer: CounterfactualOfferedPayload | null;
  /** the NoFixLine key when there is no panel (UI-25 table), null = no line */
  noFix: string | null;
}

/**
 * UI-25 visibility rule: the panel renders only for an Exact cause, exactly one offer (the first
 * when the server sends more, with a warning), a run that is not imported and ended `fail`.
 * A `chain` offer is never offered in the UI (04 §5.4).
 */
export function fixItDecision(
  d: DiagnosisResponse,
  view: DiagnosisView,
  run: { origin: Run['origin'] | null; outcome: string | null },
): FixItDecision {
  if (run.origin === 'imported') return { offer: null, noFix: 'imported' };
  const offer = d.offers[0] ?? null;
  if (d.offers.length > 1)
    console.warn(`diagnosis: ${d.offers.length} offers for one run; showing the first`);
  if (view.kind === 'exact' && offer && !offer.chain && run.outcome === 'fail')
    return { offer, noFix: null };
  if (d.noFixReason) return { offer: null, noFix: d.noFixReason };
  const byCase: Partial<Record<DiagnosisCase, string>> = {
    possible: 'several-causes',
    observed: 'observed-only',
    unclassified: 'unclassified',
  };
  return { offer: null, noFix: byCase[view.kind] ?? null };
}

/** Finds a knob by id in the loaded catalogue. */
export function knobEntry(knobs: readonly KnobEntry[], knobId: string): KnobEntry | null {
  return knobs.find((k) => k.def.id === knobId) ?? null;
}

/** API-04 answer (`{knobs}`) read defensively from the boot store slice (typed `unknown` there) */
export function knobList(data: unknown): KnobEntry[] {
  if (typeof data !== 'object' || data === null) return [];
  const list = (data as { knobs?: unknown }).knobs;
  return Array.isArray(list) ? (list as KnobEntry[]) : [];
}

export type CompareRow = CompareResponse['steps'][number];

export type ChangeWord =
  | { kind: 'same' }
  | { kind: 'differs'; n: number }
  | { kind: 'only-parent' }
  | { kind: 'only-child' }
  | { kind: 'skipped'; side: 'parent' | 'child' };

/** UI-27 change words; volatile differences are never counted here */
export function changeOf(row: CompareRow): ChangeWord {
  if (row.parent && !row.child) return { kind: 'only-parent' };
  if (!row.parent && row.child) return { kind: 'only-child' };
  const p = row.parent?.outcome;
  const c = row.child?.outcome;
  if (p !== c && c === 'skipped') return { kind: 'skipped', side: 'child' };
  if (p !== c && p === 'skipped') return { kind: 'skipped', side: 'parent' };
  const n = row.differences.filter((d) => !d.volatile).length;
  if (n > 0 || p !== c) return { kind: 'differs', n: Math.max(n, 1) };
  return { kind: 'same' };
}

/** UI-27 / A5.5: rows with `directEffect` first, then the other changed rows; unchanged apart */
export function orderCompareRows(rows: readonly CompareRow[]): {
  shown: CompareRow[];
  unchanged: CompareRow[];
} {
  const direct = rows.filter((r) => r.directEffect);
  const changed = rows.filter((r) => !r.directEffect && changeOf(r).kind !== 'same');
  const unchanged = rows.filter((r) => !r.directEffect && changeOf(r).kind === 'same');
  return { shown: [...direct, ...changed], unchanged };
}

export type Classification = NonNullable<Run['counterfactualResult']>;

export const CLASS_TONE: Record<Classification, string> = {
  fixed: 'pass',
  moved: 'warn',
  'not-fixed': 'fail',
  inconclusive: 'warn',
};
