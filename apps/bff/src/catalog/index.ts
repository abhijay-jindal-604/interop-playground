/**
 * Catalog responses (04 §2.1, §3.3): API-02 adapters, API-04 knobs, API-07 presets,
 * API-08 configurations, API-09 incompatibilities. Pure functions over the static catalogues of
 * `@interop-playground/adapters` and the 04 §4.3 rules; the routes live in routes/catalog.ts.
 */
import {
  ADAPTER_CATALOG,
  CREDENTIAL_CONFIGURATIONS,
  KNOB_CATALOG,
  PRESETS,
  descriptorOf,
} from '@interop-playground/adapters';
import type {
  AdapterEntry,
  AdapterId,
  AdapterListResponse,
  Availability,
  ConfigurationListResponse,
  CredentialFormat,
  IncompatibilityListResponse,
  Iso,
  KnobCatalogResponse,
  PresetListResponse,
} from '@interop-playground/api';
import { COMPAT_RULES } from '../orchestrator/rules.js';
import { NOT_IN_RELEASE_REASON, inRelease } from './release.js';

export { NOT_IN_RELEASE_REASON, RELEASE_ADAPTERS, inRelease } from './release.js';

export { applicableTamperCases, tamperInapplicability, TAMPER_CASES } from './tamper.js';
export {
  issuerVariantKnobsChanged,
  knobApplies,
  knobsAllDefault,
  presetOf,
  resolveKnobs,
} from './knobs.js';

/** the env module's view of one adapter; null = never probed */
export type AvailabilityView = (
  id: AdapterId,
) => { availability: Availability; probedAt: Iso | null } | null;

const NOT_PROBED: Availability = {
  available: false,
  reason: 'not probed yet',
  versionFingerprint: 'unprobed',
};

const NOT_IN_RELEASE: Availability = {
  available: false,
  reason: NOT_IN_RELEASE_REASON,
  versionFingerprint: 'not-in-release',
};

export function adapterList(view: AvailabilityView): AdapterListResponse {
  const entry = (id: AdapterId): AdapterEntry => {
    // ADR-95: adapters outside this release are shown unavailable with the decision's reason
    if (!inRelease(id))
      return { descriptor: descriptorOf(id), availability: NOT_IN_RELEASE, probedAt: null };
    const a = view(id);
    return {
      descriptor: descriptorOf(id),
      availability: a?.availability ?? NOT_PROBED,
      probedAt: a?.probedAt ?? null,
    };
  };
  const ids = (role: string): AdapterId[] =>
    ADAPTER_CATALOG.filter((e) => e.role === role).map((e) => e.id);
  return {
    issuers: ids('issuer').map(entry),
    wallets: ids('wallet').map(entry),
    verifiers: ids('verifier').map(entry),
  };
}

export function knobCatalog(filter: {
  adapter?: AdapterId;
  format?: CredentialFormat;
}): KnobCatalogResponse {
  return {
    knobs: KNOB_CATALOG.filter(
      (k) =>
        (filter.adapter === undefined || k.adapters.includes(filter.adapter)) &&
        (filter.format === undefined || k.def.formats.includes(filter.format)),
    ).map((k) => ({
      def: { ...k.def, values: [...k.def.values], formats: [...k.def.formats] },
      adapters: [...k.adapters],
      targets: [...k.targets],
      status: { ...k.status },
      provenBy: [...k.provenBy],
      label: k.label,
    })),
  };
}

export function presetList(): PresetListResponse {
  return {
    presets: PRESETS.map((p) => ({
      presetId: p.presetId,
      title: p.title,
      description: p.description,
      knobs: { ...p.knobs },
    })),
  };
}

export function configurationList(filter: {
  issuer?: AdapterId;
  format?: CredentialFormat;
}): ConfigurationListResponse {
  return {
    configurations: CREDENTIAL_CONFIGURATIONS.filter(
      (c) =>
        (filter.issuer === undefined || c.issuer === filter.issuer) &&
        (filter.format === undefined || c.format === filter.format),
    ).map((c) => ({ ...c })),
  };
}

export function incompatibilityList(): IncompatibilityListResponse {
  return {
    rules: COMPAT_RULES.map((r) => ({
      ruleId: r.ruleId,
      when: r.stateful ? `${r.when} (stateful: 409 tunnel_required)` : r.when,
      reason: r.reasonTemplate,
      gapId: r.gapId,
      evidence: r.evidence.split(',').map((e) => e.trim()),
    })),
  };
}
