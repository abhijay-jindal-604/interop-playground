/**
 * Static adapter catalogue: the 18 rows of plan/02-architecture.md §5.3 (issuer, wallet and verifier
 * columns), the knob catalogue of plan/09 A4 (KNOB-01..KNOB-10), the run-form presets (API-07) and
 * the credential configurations per issuer and format (API-08). `descriptorOf` attaches the knob
 * definitions to a row (02 §5.2 `AdapterDescriptor`). Wallet formats that 02 §5.3 does not list per row are the formats of the flows the
 * row names; T-12 (environment manager) refines availability at probe time.
 */
import type {
  AdapterDescriptor,
  AdapterId,
  CredentialFormat,
  FingerprintId,
  KnobDef,
  KnobId,
  Role,
} from './contracts.js';

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
    // KNOB-10 (09 A4): applied by this adapter, only when the run's wallet is wallet.inji-web
    knobIds: ['KNOB-07', 'KNOB-10'],
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

// ---------- knob catalogue (09 A4) ----------
export type KnobStatus = 'proven' | 'unproven' | 'no-value-passes';

export interface KnobCatalogEntry {
  readonly def: KnobDef;
  /** the adapters applying the knob (09 A4 column "Adapter(s) applying it") */
  readonly adapters: readonly AdapterId[];
  readonly targets: readonly FingerprintId[];
  /** key = CredentialFormat | `${CredentialFormat}@${AdapterId}` (04 §3.3 KnobEntry.status) */
  readonly status: Readonly<Record<string, KnobStatus>>;
  readonly provenBy: readonly string[];
  /** A4 report label */
  readonly label: string;
  /** extra applicability beyond adapter + format (KNOB-10: only with wallet.inji-web) */
  readonly requiresWallet?: AdapterId;
}

export const KNOB_CATALOG: readonly KnobCatalogEntry[] = [
  {
    def: {
      id: 'KNOB-01',
      name: 'waltid.sdjwt.x5c',
      values: ['absent', 'present'],
      defaultValue: 'absent',
      appliesAt: 'peer-runtime-option',
      formats: ['dc+sd-jwt'],
    },
    adapters: ['issuer.waltid'],
    targets: ['FP-01'],
    status: { 'dc+sd-jwt': 'proven' },
    provenBy: ['S-077', 'S-120'],
    label: 'changed walt.id issuance option',
  },
  {
    def: {
      id: 'KNOB-02',
      name: 'certify.mdoc.profile',
      values: ['develop-spec', 'alpha1-template'],
      defaultValue: 'develop-spec',
      appliesAt: 'issuer-target-switch',
      formats: ['mso_mdoc'],
    },
    adapters: ['issuer.certify-mdoc', 'issuer.certify-preauth'],
    targets: ['FP-04'],
    status: { mso_mdoc: 'proven' },
    provenBy: ['S-087', 'S-177'],
    label: 'switched Inji Certify release line',
  },
  {
    def: {
      id: 'KNOB-03',
      name: 'wallet.proof.kid',
      values: ['did:jwk#0', 'did:jwk', 'jwk'],
      defaultValue: 'did:jwk#0',
      appliesAt: 'wallet-runtime',
      formats: ['mso_mdoc'],
    },
    adapters: ['wallet.playground-ts'],
    targets: ['FP-07'],
    status: { mso_mdoc: 'proven' },
    provenBy: ['S-026'],
    label: 'simulated fix: wallet-side workaround, defect is in Certify alpha.1',
  },
  {
    def: {
      id: 'KNOB-04',
      name: 'certify.sdClaim.syntax',
      values: ['jsonpath', 'plain'],
      defaultValue: 'jsonpath',
      appliesAt: 'issuer-variant-config',
      formats: ['dc+sd-jwt'],
    },
    adapters: ['issuer.certify-preauth', 'issuer.certify-authcode'],
    targets: ['FP-08'],
    status: { 'dc+sd-jwt': 'proven' },
    provenBy: ['S-019', 'S-020'],
    label: 'changed Inji Certify credential configuration',
  },
  {
    def: {
      id: 'KNOB-05',
      name: 'certify.template.claimRefs',
      values: ['metadata-names', 'postman-sample'],
      defaultValue: 'metadata-names',
      appliesAt: 'issuer-variant-config',
      formats: ['mso_mdoc', 'ldp_vc'],
    },
    adapters: ['issuer.certify-preauth'],
    targets: ['FP-09'],
    status: { mso_mdoc: 'proven', ldp_vc: 'proven' },
    provenBy: ['S-026'],
    label: 'changed Inji Certify credential template',
  },
  {
    def: {
      id: 'KNOB-06',
      name: 'certify.didUrl.perConfig',
      values: ['issuer-did', 'seeded'],
      defaultValue: 'issuer-did',
      appliesAt: 'issuer-variant-config',
      formats: ['ldp_vc'],
    },
    adapters: ['issuer.certify-preauth', 'issuer.certify-authcode'],
    targets: ['FP-10'],
    status: { ldp_vc: 'proven' },
    provenBy: ['S-106', 'S-150', 'S-184'],
    label: 'changed Inji Certify credential configuration',
  },
  {
    def: {
      id: 'KNOB-07',
      name: 'verify.clientIdScheme',
      values: ['plain', 'decentralized_identifier', 'x509_san_dns'],
      defaultValue: 'plain',
      appliesAt: 'verifier-request',
      formats: ['dc+sd-jwt', 'ldp_vc'],
    },
    adapters: [
      'verifier.inji-verify-local',
      'verifier.inji-verify-collab',
      'verifier.inji-verify-sdk',
    ],
    targets: ['FP-11', 'FP-12', 'FP-13', 'FP-14'],
    status: {
      'dc+sd-jwt': 'proven',
      ldp_vc: 'proven',
      'dc+sd-jwt@wallet.credo': 'no-value-passes',
      'ldp_vc@wallet.credo': 'no-value-passes',
    },
    provenBy: ['S-116', 'S-160', 'S-161', 'S-020', 'S-060', 'S-140', 'S-162'],
    label: 'changed Inji Verify request parameter',
  },
  {
    def: {
      id: 'KNOB-08',
      name: 'credo.trustAnchor',
      values: ['issuer-leaf', 'issuer-root', 'none'],
      defaultValue: 'issuer-leaf',
      appliesAt: 'peer-runtime-option',
      formats: ['mso_mdoc', 'dc+sd-jwt'],
    },
    adapters: ['verifier.credo'],
    targets: ['FP-15'],
    status: { mso_mdoc: 'proven', 'dc+sd-jwt': 'unproven' },
    provenBy: ['S-142', 'S-188', 'S-096'],
    label: 'changed Credo verifier option',
  },
  {
    def: {
      id: 'KNOB-09',
      name: 'mdoc.envelope',
      values: ['normalised', 'as-issued'],
      defaultValue: 'normalised',
      appliesAt: 'adapter-setting',
      formats: ['mso_mdoc'],
    },
    adapters: ['verifier.credo', 'verifier.eudi'],
    targets: ['FP-16'],
    status: { 'mso_mdoc@verifier.credo': 'proven', 'mso_mdoc@verifier.eudi': 'unproven' },
    provenBy: ['S-188', 'S-087'],
    label: 'playground adapter setting',
  },
  {
    def: {
      id: 'KNOB-10',
      name: 'wallet.dcql.typeValues',
      values: ['expanded', 'plain'],
      defaultValue: 'expanded',
      appliesAt: 'verifier-request',
      formats: ['ldp_vc'],
    },
    adapters: ['verifier.inji-verify-local'],
    targets: ['FP-38'],
    status: { 'ldp_vc@wallet.inji-web': 'proven' },
    provenBy: ['S-203'],
    label: 'playground adapter setting (request form)',
    requiresWallet: 'wallet.inji-web',
  },
];

export function knobEntry(id: string): KnobCatalogEntry | undefined {
  return KNOB_CATALOG.find((k) => k.def.id === id);
}

/** 02 §5.2 `AdapterDescriptor`: the 02 §5.3 row with its knob definitions attached */
export function descriptorOf(id: AdapterId): AdapterDescriptor {
  const { knobIds, ...row } = catalogEntry(id);
  const knobs = knobIds.map((k) => {
    const e = knobEntry(k);
    if (e === undefined) throw new Error(`adapter ${id} names unknown knob ${k}`);
    return e.def;
  });
  return { ...row, knobs };
}

// ---------- presets (API-07, 09 A4) ----------
export interface PresetDef {
  readonly presetId: string;
  readonly title: string;
  readonly description: string;
  readonly knobs: Readonly<Record<KnobId, string>>;
}

export const PRESETS: readonly PresetDef[] = [
  {
    presetId: 'inji-shipped-samples',
    title: 'Inji shipped samples',
    description:
      'Inji Certify configured like the documented quickstart samples (sdClaim without JSONPath, the Postman template placeholders, the seeded didUrl), so the quickstart defects G-14/G-15, G-17 and G-20 can be shown and fixed one knob at a time.',
    knobs: { 'KNOB-04': 'plain', 'KNOB-05': 'postman-sample', 'KNOB-06': 'seeded' },
  },
];

// ---------- credential configurations (API-08) ----------
export interface CredentialConfigurationDef {
  readonly issuer: AdapterId;
  readonly format: CredentialFormat;
  readonly configurationId: string;
  readonly default: boolean;
  readonly vctOrDoctypeOrType: string;
}

const MDL_DOCTYPE = 'org.iso.18013.5.1.mDL';

/**
 * The configuration IDs the bundle seeds per issuer and format (03 FLOW-01/03/04/05/08/09/10/14).
 * `issuer.certify-collab` advertises its configurations in metadata (read at probe time, none here).
 */
export const CREDENTIAL_CONFIGURATIONS: readonly CredentialConfigurationDef[] = [
  {
    issuer: 'issuer.certify-preauth',
    format: 'ldp_vc',
    configurationId: 'FarmerCredential',
    default: true,
    vctOrDoctypeOrType: 'FarmerCredential',
  },
  {
    issuer: 'issuer.certify-preauth',
    format: 'dc+sd-jwt',
    configurationId: 'PlaygroundSdJwt',
    default: true,
    vctOrDoctypeOrType: 'PlaygroundSdJwt',
  },
  {
    issuer: 'issuer.certify-preauth',
    format: 'mso_mdoc',
    configurationId: 'DrivingLicenseCredential',
    default: true,
    vctOrDoctypeOrType: MDL_DOCTYPE,
  },
  {
    issuer: 'issuer.certify-authcode',
    format: 'ldp_vc',
    configurationId: 'FarmerCredential',
    default: true,
    vctOrDoctypeOrType: 'FarmerCredential',
  },
  {
    issuer: 'issuer.certify-authcode',
    format: 'mso_mdoc',
    configurationId: 'DrivingLicenseCredential',
    default: true,
    vctOrDoctypeOrType: MDL_DOCTYPE,
  },
  {
    issuer: 'issuer.certify-mdoc',
    format: 'mso_mdoc',
    configurationId: 'DrivingLicenseCredential',
    default: true,
    vctOrDoctypeOrType: MDL_DOCTYPE,
  },
  {
    issuer: 'issuer.waltid',
    format: 'dc+sd-jwt',
    configurationId: 'identityCredentialSdJwt',
    default: true,
    vctOrDoctypeOrType: 'identity_credential',
  },
  {
    issuer: 'issuer.fixture',
    format: 'dc+sd-jwt',
    configurationId: 'PlaygroundSdJwt',
    default: true,
    vctOrDoctypeOrType: 'PlaygroundSdJwt',
  },
  {
    issuer: 'issuer.fixture',
    format: 'dc+sd-jwt',
    configurationId: 'PlaygroundSdJwtExpired',
    default: false,
    vctOrDoctypeOrType: 'PlaygroundSdJwt',
  },
  {
    issuer: 'issuer.fixture',
    format: 'dc+sd-jwt',
    configurationId: 'PlaygroundSdJwtInvalid',
    default: false,
    vctOrDoctypeOrType: 'PlaygroundSdJwt',
  },
  {
    issuer: 'issuer.fixture',
    format: 'mso_mdoc',
    configurationId: 'DrivingLicenseCredential',
    default: true,
    vctOrDoctypeOrType: MDL_DOCTYPE,
  },
];

export function configurationsOf(
  issuer: AdapterId,
  format: CredentialFormat,
): readonly CredentialConfigurationDef[] {
  return CREDENTIAL_CONFIGURATIONS.filter((c) => c.issuer === issuer && c.format === format);
}
