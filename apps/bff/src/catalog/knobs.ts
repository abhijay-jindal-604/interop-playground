/**
 * Knob resolution (04 §4.1 step 4, §4.4; 09 A4): presets first, explicit knobs override, defaults
 * written out for every applicable knob, inapplicable ones absent.
 */
import { KNOB_CATALOG, PRESETS, knobEntry } from '@interop-playground/adapters';
import type { KnobCatalogEntry, PresetDef } from '@interop-playground/adapters';
import type { AdapterId, CredentialFormat, KnobValues, RunSpec } from '@interop-playground/api';
import { ApiError, issueDetails } from '../errors/index.js';

export interface KnobTarget {
  issuer: AdapterId;
  wallet: AdapterId;
  verifier: AdapterId;
  format: CredentialFormat;
}

/** 04 §4.4: the `appliesAt` adapter is chosen and the format is offered (KNOB-10 also needs Inji Web) */
export function knobApplies(k: KnobCatalogEntry, t: KnobTarget): boolean {
  const chosen = [t.issuer, t.wallet, t.verifier];
  if (!k.adapters.some((a) => chosen.includes(a))) return false;
  if (!k.def.formats.includes(t.format)) return false;
  if (k.requiresWallet !== undefined && t.wallet !== k.requiresWallet) return false;
  return true;
}

/** Finds a preset by id. */
export function presetOf(presetId: string): PresetDef | undefined {
  return PRESETS.find((p) => p.presetId === presetId);
}

/** the KNOB-02 value a request asks for (preset, then explicit), before validation (§4.1 step 2) */
export function requestedKnob(
  id: string,
  knobs: Partial<KnobValues> | undefined,
  preset: string | undefined,
): string | undefined {
  const explicit = (knobs as Record<string, string> | undefined)?.[id];
  if (explicit !== undefined) return explicit;
  return preset === undefined ? undefined : presetOf(preset)?.knobs[id as `KNOB-${string}`];
}

/**
 * Step 4: unknown id / value → `knob_invalid`; a knob that does not apply → `knob_not_applicable`
 * (reasons `collab-no-write`, `fixed-request-profile`, `not-applicable`). Returns `spec.knobs`.
 */
export function resolveKnobs(
  t: KnobTarget,
  explicit: Partial<KnobValues> | undefined,
  presetId: string | undefined,
  warnings: string[],
): KnobValues {
  const out: Record<string, string> = {};
  for (const k of KNOB_CATALOG) if (knobApplies(k, t)) out[k.def.id] = k.def.defaultValue;
  if (presetId !== undefined) {
    const preset = presetOf(presetId);
    if (preset === undefined)
      throw new ApiError(
        'validation_failed',
        undefined,
        issueDetails([{ path: '$.preset', message: `unknown preset ${presetId}` }]),
      );
    for (const [id, value] of Object.entries(preset.knobs)) {
      if (id in out) out[id] = value;
      else warnings.push(`preset ${presetId}: ${id} does not apply to this run and was skipped`);
    }
  }
  for (const [id, value] of Object.entries(explicit ?? {}) as [string, unknown][]) {
    const k = knobEntry(id);
    if (k === undefined)
      throw new ApiError('knob_invalid', `Unknown knob ${id}.`, {
        knobId: id,
        reason: 'unknown-knob',
      });
    if (typeof value !== 'string' || !k.def.values.includes(value))
      throw new ApiError('knob_invalid', `${id} has no value ${String(value)}.`, {
        knobId: id,
        reason: 'unknown-value',
        allowed: [...k.def.values],
      });
    const isDefault = value === k.def.defaultValue;
    if (!(id in out)) {
      const issuerSide = k.def.appliesAt.startsWith('issuer-');
      if (t.issuer === 'issuer.certify-collab' && issuerSide) {
        // ADR-13: Collab is never written to; the default value is a no-op
        if (isDefault) {
          warnings.push(`${id} ignored: Collab issuers take no issuer-side knob`);
          continue;
        }
        throw new ApiError('knob_not_applicable', 'Collab issuers take no issuer-side knob.', {
          knobId: id,
          reason: 'collab-no-write',
        });
      }
      throw new ApiError('knob_not_applicable', `${id} does not apply to this run.`, {
        knobId: id,
        reason: 'not-applicable',
      });
    }
    if (id === 'KNOB-07' && t.wallet === 'wallet.inji-mobile' && !isDefault)
      throw new ApiError(
        'knob_not_applicable',
        'Inji Wallet uses a fixed request profile (redirect_uri).',
        { knobId: id, reason: 'fixed-request-profile' },
      );
    out[id] = value;
  }
  return out;
}

/** every knob of the spec at its default (05 `runs.knobs_all_default`) */
export function knobsAllDefault(spec: Pick<RunSpec, 'knobs'>): boolean {
  return Object.entries(spec.knobs).every(([id, v]) => knobEntry(id)?.def.defaultValue === v);
}

/** an issuer variant-config knob differs from its default: `vci.setup.variant` runs (02 §1.3 item 5) */
export function issuerVariantKnobsChanged(spec: Pick<RunSpec, 'knobs'>): boolean {
  return Object.entries(spec.knobs).some(([id, v]) => {
    const k = knobEntry(id);
    return (
      k !== undefined && k.def.appliesAt === 'issuer-variant-config' && k.def.defaultValue !== v
    );
  });
}
