/**
 * Fingerprint library types (plan/09 A2; plan/10 §1.1: `diagnosis/fingerprints.json` is one file per
 * fingerprint, `fingerprints/FP-xx.json`). The knob catalogue of 09 A4 lives in
 * `@interop-playground/adapters` `KNOB_CATALOG` (ADR-72), not in a `knobs.json`.
 */
import type {
  AdapterId,
  ClientIdScheme,
  CredentialFormat,
  EngineId,
  EnvClass,
  FingerprintId,
  KnobId,
} from '@interop-playground/api';

export type ArtifactKind =
  | 'credential'
  | 'credential-header'
  | 'mdoc-cbor'
  | 'x509-leaf'
  | 'did-document'
  | 'request-object'
  | 'token';

export type Predicate =
  | {
      on: 'exchange';
      counterpart: string;
      method?: string;
      pathGlob?: string;
      status?: number;
      /** default true; false = no such exchange in the step */
      present?: boolean;
      bodyPath?: string;
      op?: 'eq' | 'contains' | 'regex' | 'exists' | 'absent';
      value?: string;
    }
  | { on: 'engine.call'; engine: EngineId; op: string; result: 'ok' | 'error' }
  | { on: 'engine.exception'; engine: EngineId; exceptionClass?: string; messageContains: string }
  | {
      on: 'check';
      checkId: string;
      outcome: 'pass' | 'fail';
      code?: string;
      messageContains?: string;
    }
  | {
      on: 'artifact';
      kind: ArtifactKind;
      path: string;
      op:
        | 'eq'
        | 'contains'
        | 'regex'
        | 'exists'
        | 'absent'
        | 'count-eq'
        | 'equals-path'
        | 'differs-from-path';
      value?: string;
    }
  | { on: 'env'; probe: string; op: 'eq' | 'contains' | 'absent'; value?: string }
  | { on: 'manual'; step: 'issuance' | 'presentation' | 'card-status'; shown: string };

export interface Fingerprint {
  id: FingerprintId;
  version: number;
  gapIds: readonly string[];
  title: string;
  appliesWhen: 'run-failed' | 'always' | 'environment';
  evidenceClass: 'full' | 'observed-only';
  deviatingSide:
    'issuer' | 'wallet' | 'verifier' | 'issuer+verifier' | 'environment' | 'playground';
  component: {
    vendor: 'inji' | 'waltid' | 'eudi' | 'credo' | 'playground';
    name: string;
    versions: string;
  };
  specClause: { spec: string; section: string } | null;
  scope: {
    issuers?: readonly AdapterId[];
    wallets?: readonly AdapterId[];
    verifiers?: readonly AdapterId[];
    formats?: readonly CredentialFormat[];
    envs?: readonly EnvClass[];
    clientIdSchemes?: readonly ClientIdScheme[];
  };
  stepKey?: string;
  match: readonly (readonly Predicate[])[];
  evidence: { sIds: readonly string[]; artifact: string; goldenTest: string };
  fix: { knobId: KnobId; from: string; to: string } | null;
  noFixReason?: string;
  issue: { repo: string; privateDisclosure: boolean } | null;
  status: 'active' | 'historical';
}

/** 09 A9.3 wording keys (04 `DiagnosisResponse.noFixReason`) */
export type NoFixReason =
  | 'no-proven-knob'
  | 'several-causes'
  | 'unclassified'
  | 'tamper-run'
  | 'observed-only'
  | 'version-drift'
  | 'environment-changed';
