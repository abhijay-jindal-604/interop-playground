/**
 * Static adapter catalogue: the 18 rows of plan/02-architecture.md §5.3 (issuer, wallet and verifier
 * columns). Knob definitions (plan/09 §Spec) are attached by the registry; this table carries the
 * knob IDs only. Wallet formats that 02 §5.3 does not list per row are the formats of the flows the
 * row names; T-12 (environment manager) refines availability at probe time.
 */
import type { AdapterDescriptor, AdapterId, KnobId, Role } from './contracts.js';

export type AdapterCatalogEntry = Omit<AdapterDescriptor, 'knobs'> & {
  readonly knobIds: readonly KnobId[];
};

const noPartial = { partialHops: [] } as const;

export const ADAPTER_CATALOG: readonly AdapterCatalogEntry[] = [
  // ---------- issuers ----------
  {
    id: 'issuer.certify-preauth',
    role: 'issuer',
    vendor: 'inji',
    displayName: 'Inji Certify (pre-authorized)',
    envClass: 'local',
    tier: 'automated',
    formats: ['ldp_vc', 'dc+sd-jwt', 'mso_mdoc'],
    coverage: { default: 'full', ...noPartial },
    knobIds: ['KNOB-02', 'KNOB-04', 'KNOB-05', 'KNOB-06'],
  },
  {
    id: 'issuer.certify-authcode',
    role: 'issuer',
    vendor: 'inji',
    displayName: 'Inji Certify (authorization code, eSignet)',
    envClass: 'local',
    tier: 'automated',
    formats: ['ldp_vc', 'mso_mdoc'],
    coverage: { default: 'full', ...noPartial },
    knobIds: ['KNOB-04', 'KNOB-06'],
  },
  {
    id: 'issuer.certify-mdoc',
    role: 'issuer',
    vendor: 'inji',
    displayName: 'Inji Certify (develop, spec mDoc)',
    envClass: 'local',
    tier: 'automated',
    formats: ['mso_mdoc'],
    coverage: { default: 'full', ...noPartial },
    knobIds: ['KNOB-02'],
  },
  {
    id: 'issuer.certify-collab',
    role: 'issuer',
    vendor: 'inji',
    displayName: 'Inji Certify (Collab)',
    envClass: 'collab',
    tier: 'best-effort',
    // "as advertised in metadata": the formats are read from the Collab metadata at probe time.
    formats: [],
    coverage: {
      default: 'partial',
      partialHops: [
        {
          stepKey: 'vci.credential',
          reason: 'Collab Mimoto hops are server-side',
          evidence: 'S-025',
        },
      ],
    },
    knobIds: [],
  },
  {
    id: 'issuer.waltid',
    role: 'issuer',
    vendor: 'waltid',
    displayName: 'walt.id issuer-api2',
    envClass: 'local',
    tier: 'automated',
    formats: ['dc+sd-jwt', 'jwt_vc_json', 'mso_mdoc'],
    coverage: { default: 'full', ...noPartial },
    knobIds: ['KNOB-01'],
  },
  {
    id: 'issuer.fixture',
    role: 'issuer',
    vendor: 'playground',
    displayName: 'Fixture credential',
    envClass: 'local',
    tier: 'automated',
    formats: ['dc+sd-jwt', 'mso_mdoc'],
    coverage: { default: 'none', ...noPartial },
    knobIds: [],
  },
  // ---------- wallets ----------
  {
    id: 'wallet.playground-ts',
    role: 'wallet',
    vendor: 'playground',
    displayName: 'Playground reference wallet',
    envClass: 'local',
    tier: 'automated',
    formats: ['ldp_vc', 'dc+sd-jwt', 'mso_mdoc'],
    coverage: { default: 'full', ...noPartial },
    knobIds: ['KNOB-03'],
  },
  {
    id: 'wallet.inji-jvm',
    role: 'wallet',
    vendor: 'inji',
    displayName: 'Inji JVM libraries (VCIClient + openid4vp)',
    envClass: 'local',
    tier: 'automated',
    formats: ['ldp_vc', 'dc+sd-jwt'],
    coverage: { default: 'full', ...noPartial },
    knobIds: [],
  },
  {
    id: 'wallet.inji-web',
    role: 'wallet',
    vendor: 'inji',
    displayName: 'Inji Web + Mimoto',
    envClass: 'local',
    tier: 'automated',
    formats: ['ldp_vc', 'dc+sd-jwt'],
    coverage: { default: 'full', ...noPartial },
    knobIds: [],
  },
  {
    id: 'wallet.inji-mobile',
    role: 'wallet',
    vendor: 'inji',
    displayName: 'Inji Wallet (phone, manual assist)',
    envClass: 'local',
    tier: 'manual',
    formats: ['ldp_vc', 'dc+sd-jwt', 'mso_mdoc'],
    coverage: { default: 'partial', ...noPartial },
    knobIds: [],
  },
  {
    id: 'wallet.credo',
    role: 'wallet',
    vendor: 'credo',
    displayName: 'Credo holder',
    envClass: 'local',
    tier: 'automated',
    formats: ['dc+sd-jwt', 'mso_mdoc'],
    coverage: { default: 'full', ...noPartial },
    knobIds: [],
  },
  // ---------- verifiers ----------
  {
    id: 'verifier.inji-verify-local',
    role: 'verifier',
    vendor: 'inji',
    displayName: 'Inji Verify (local)',
    envClass: 'local',
    tier: 'automated',
    formats: ['ldp_vc', 'dc+sd-jwt'],
    coverage: { default: 'full', ...noPartial },
    knobIds: ['KNOB-07'],
  },
  {
    id: 'verifier.inji-verify-collab',
    role: 'verifier',
    vendor: 'inji',
    displayName: 'Inji Verify (Collab)',
    envClass: 'collab',
    tier: 'automated',
    formats: ['ldp_vc', 'dc+sd-jwt'],
    coverage: { default: 'full', ...noPartial },
    knobIds: ['KNOB-07'],
  },
  {
    id: 'verifier.inji-verify-sdk',
    role: 'verifier',
    vendor: 'inji',
    displayName: 'Inji Verify React SDK',
    envClass: 'local',
    tier: 'automated',
    formats: ['ldp_vc', 'dc+sd-jwt'],
    coverage: { default: 'full', ...noPartial },
    knobIds: ['KNOB-07'],
  },
  {
    id: 'verifier.vcverifier-offline',
    role: 'verifier',
    vendor: 'inji',
    displayName: 'Inji vcverifier (offline library)',
    envClass: 'local',
    tier: 'automated',
    formats: ['ldp_vc', 'dc+sd-jwt', 'mso_mdoc'],
    coverage: { default: 'none', ...noPartial },
    knobIds: [],
  },
  {
    id: 'verifier.waltid',
    role: 'verifier',
    vendor: 'waltid',
    displayName: 'walt.id verifier-api2',
    envClass: 'local',
    tier: 'automated',
    formats: ['dc+sd-jwt'],
    coverage: { default: 'full', ...noPartial },
    knobIds: [],
  },
  {
    id: 'verifier.eudi',
    role: 'verifier',
    vendor: 'eudi',
    displayName: 'EUDI reference verifier',
    envClass: 'local',
    tier: 'automated',
    formats: ['dc+sd-jwt', 'mso_mdoc'],
    coverage: { default: 'full', ...noPartial },
    knobIds: ['KNOB-09'],
  },
  {
    id: 'verifier.credo',
    role: 'verifier',
    vendor: 'credo',
    displayName: 'Credo verifier (library)',
    envClass: 'local',
    tier: 'automated',
    formats: ['dc+sd-jwt', 'mso_mdoc', 'ldp_vc'],
    coverage: { default: 'none', ...noPartial },
    knobIds: ['KNOB-08', 'KNOB-09'],
  },
];

export function catalogByRole(role: Role): readonly AdapterCatalogEntry[] {
  return ADAPTER_CATALOG.filter((entry) => entry.role === role);
}

export function catalogEntry(id: AdapterId): AdapterCatalogEntry {
  const entry = ADAPTER_CATALOG.find((e) => e.id === id);
  if (entry === undefined) throw new Error(`unknown adapter id ${id}`);
  return entry;
}
