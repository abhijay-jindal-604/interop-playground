/**
 * Static compatibility rules of 04 §4.3 (API-03, API-09, API-20 step 3): the first matching rule
 * wins. A more specific rule precedes the general one it overlaps (ADR-72 (2)), so every rule of
 * the table can be a first hit. `stateful` rules depend on the tunnel (409 `tunnel_required`); all others are 422
 * `incompatible_selection`. Verifier rules are skipped for `scope = "issuance"`.
 */
import { catalogEntry } from '@interop-playground/adapters';
import type {
  AdapterId,
  CredentialFormat,
  Delivery,
  Grant,
  PresentationMode,
} from '@interop-playground/api';
import { NOT_IN_RELEASE_REASON, inRelease } from '../catalog/release.js';

export interface RuleInput {
  issuer: AdapterId;
  wallet: AdapterId;
  verifier: AdapterId;
  grant: Grant;
  format: CredentialFormat;
  /** null: credential-level request, no OID4VP (ADR-94) */
  presentationMode: PresentationMode | null;
  delivery: Delivery;
  scope: 'issuance' | 'full';
  withTxCode: boolean;
  withIae: boolean;
  tunnelUp: boolean;
}

export interface CompatRule {
  ruleId: string;
  reason: (r: RuleInput) => string;
  /** the reason as API-09 shows it (placeholders in angle brackets, 04 §4.3 "Reason shown") */
  reasonTemplate: string;
  gapId: string | null;
  evidence: string;
  /** predicate in words (API-09) */
  when: string;
  verifierRule: boolean;
  stateful: boolean;
  applies: (r: RuleInput) => boolean;
}

const PREAUTH_ONLY: AdapterId[] = [
  'issuer.certify-preauth',
  'issuer.certify-mdoc',
  'issuer.waltid',
];
const AUTHCODE_ONLY: AdapterId[] = ['issuer.certify-authcode', 'issuer.certify-collab'];
const INJI_VERIFY = (v: AdapterId): boolean => v.startsWith('verifier.inji-verify-');
const reasonOf = (s: string) => (): string => s;

function rule(
  ruleId: string,
  when: string,
  reason: string | readonly [(r: RuleInput) => string, string],
  gapId: string | null,
  evidence: string,
  applies: (r: RuleInput) => boolean,
  flags: { verifierRule?: boolean; stateful?: boolean } = {},
): CompatRule {
  return {
    ruleId,
    when,
    reason: typeof reason === 'string' ? reasonOf(reason) : reason[0],
    reasonTemplate: typeof reason === 'string' ? reason : reason[1],
    gapId,
    evidence,
    applies,
    verifierRule: flags.verifierRule ?? false,
    stateful: flags.stateful ?? false,
  };
}

const formatsOf = (id: AdapterId): readonly CredentialFormat[] => catalogEntry(id).formats;

export const COMPAT_RULES: readonly CompatRule[] = [
  rule(
    'collab-issuer-no-preauth',
    'issuer.certify-collab × pre-auth',
    'Collab Certify does not offer pre-authorized issuance.',
    'G-06',
    '02 §5.3',
    (r) => r.issuer === 'issuer.certify-collab' && r.grant === 'pre-authorized_code',
  ),
  rule(
    'issuer-grant-mismatch',
    'grant not supported by the issuer',
    [
      (r) =>
        `This issuer only supports ${PREAUTH_ONLY.includes(r.issuer) ? 'pre-authorized_code' : 'authorization_code'}.`,
      'This issuer only supports <grant>.',
    ],
    null,
    '02 §5.3',
    (r) =>
      (PREAUTH_ONLY.includes(r.issuer) && r.grant !== 'pre-authorized_code') ||
      (AUTHCODE_ONLY.includes(r.issuer) && r.grant !== 'authorization_code'),
  ),
  rule(
    'fixture-formats',
    'issuer.fixture × ldp_vc',
    'Fixtures exist for dc+sd-jwt and mso_mdoc.',
    null,
    'FLOW-14',
    (r) => r.issuer === 'issuer.fixture' && r.format === 'ldp_vc',
  ),
  rule(
    'issuer-format-unsupported',
    'format not in the issuer descriptor formats',
    [(r) => `Issuer does not issue ${r.format}.`, 'Issuer does not issue <format>.'],
    null,
    '02 §5.3',
    // Collab Certify advertises its formats at probe time (empty static list)
    (r) => r.issuer !== 'issuer.certify-collab' && !formatsOf(r.issuer).includes(r.format),
  ),
  rule(
    'mdoc-at-inji-verify',
    'mso_mdoc × verifier.inji-verify-*',
    'Inji Verify has no mso_mdoc path.',
    'G-09',
    '02 §5.3',
    (r) => r.format === 'mso_mdoc' && INJI_VERIFY(r.verifier),
    { verifierRule: true },
  ),
  rule(
    'ldp-at-eudi',
    'ldp_vc × verifier.eudi',
    'EUDI verifier has no ldp_vc.',
    null,
    'S-085',
    (r) => r.format === 'ldp_vc' && r.verifier === 'verifier.eudi',
    { verifierRule: true },
  ),
  rule(
    'verifier-format-unsupported',
    'format not in the verifier descriptor formats',
    [(r) => `Verifier does not verify ${r.format}.`, 'Verifier does not verify <format>.'],
    null,
    '02 §5.3',
    (r) => !formatsOf(r.verifier).includes(r.format),
    { verifierRule: true },
  ),
  rule(
    'mdoc-no-oid4vp',
    'mso_mdoc with a delivery other than in-process or a verifier outside vcverifier-offline, credo, eudi',
    'mso_mdoc is verified at credential level only.',
    null,
    'ADR-30',
    (r) =>
      r.format === 'mso_mdoc' &&
      (r.delivery !== 'in-process' ||
        !['verifier.vcverifier-offline', 'verifier.credo', 'verifier.eudi'].includes(r.verifier)),
    { verifierRule: true },
  ),
  rule(
    'webwallet-no-preauth',
    'wallet.inji-web × pre-auth',
    'Inji Web has no offer entry.',
    'G-08',
    '02 §5.3',
    (r) => r.wallet === 'wallet.inji-web' && r.grant === 'pre-authorized_code',
  ),
  rule(
    'collab-issuer-wallet',
    'issuer.certify-collab and wallet ≠ wallet.inji-web',
    'Collab issuance runs only through Inji Web (best-effort).',
    'G-36',
    '02 §5.3',
    (r) => r.issuer === 'issuer.certify-collab' && r.wallet !== 'wallet.inji-web',
  ),
  rule(
    'jvm-mdoc-unoffered',
    'wallet.inji-jvm × mso_mdoc',
    'mso_mdoc through VCIClient is not offered (needs a did:jwk proof, FP-07).',
    'G-23',
    '03 FLOW-06',
    (r) => r.wallet === 'wallet.inji-jvm' && r.format === 'mso_mdoc',
  ),
  rule(
    'jvm-preauth-only',
    'wallet.inji-jvm × auth-code',
    'inji-jvm issues by pre-authorized offer only.',
    null,
    '02 §5.3',
    (r) => r.wallet === 'wallet.inji-jvm' && r.grant === 'authorization_code',
  ),
  rule(
    'jvm-http-issuer',
    'wallet.inji-jvm × certify-authcode / certify-mdoc / waltid',
    'VCIClient refuses http issuers.',
    'G-103',
    '02 §5.3',
    (r) =>
      r.wallet === 'wallet.inji-jvm' &&
      ['issuer.certify-authcode', 'issuer.certify-mdoc', 'issuer.waltid'].includes(r.issuer),
  ),
  rule(
    'jvm-eudi-verifier',
    'wallet.inji-jvm × verifier.eudi',
    'The jar accepts only EdDSA request objects; EUDI signs with ES512.',
    'G-112',
    '03 §2.1, S-195',
    (r) => r.wallet === 'wallet.inji-jvm' && r.verifier === 'verifier.eudi',
    { verifierRule: true },
  ),
  rule(
    'mobile-preauth-only',
    'wallet.inji-mobile × auth-code',
    'The phone leg uses a pre-authorized offer QR.',
    null,
    'ADR-15',
    (r) => r.wallet === 'wallet.inji-mobile' && r.grant === 'authorization_code',
  ),
  rule(
    'mobile-peer-verifier',
    'wallet.inji-mobile × verifier.waltid / verifier.eudi',
    'The tunnel exposes only Inji Verify and certify-preauth.',
    null,
    '03 §2.1, 02 §2.6',
    (r) =>
      r.wallet === 'wallet.inji-mobile' &&
      (r.verifier === 'verifier.waltid' || r.verifier === 'verifier.eudi'),
    { verifierRule: true },
  ),
  rule(
    'webwallet-only-local-verify',
    'wallet.inji-web × any verifier ≠ verifier.inji-verify-local',
    'The Mimoto trusted-verifier list registers only the local Verify.',
    null,
    '03 §2.1, FLOW-36',
    (r) => r.wallet === 'wallet.inji-web' && r.verifier !== 'verifier.inji-verify-local',
    { verifierRule: true },
  ),
  rule(
    'webwallet-collab-redirect',
    'delivery = web-wallet-redirect × verifier.inji-verify-collab',
    "response_code redirect target is Collab's configuration.",
    null,
    'S-005, FLOW-36',
    (r) => r.delivery === 'web-wallet-redirect' && r.verifier === 'verifier.inji-verify-collab',
    { verifierRule: true },
  ),
  rule(
    'dcapi-needs-sdk-verifier',
    'presentationMode = dc-api and verifier ≠ verifier.inji-verify-sdk',
    'The DC API probe runs through the Verify SDK.',
    'G-37',
    'ADR-16',
    (r) => r.presentationMode === 'dc-api' && r.verifier !== 'verifier.inji-verify-sdk',
    { verifierRule: true },
  ),
  rule(
    'credo-needs-fixture',
    'wallet.credo and issuer ≠ issuer.fixture',
    'Credo holds fixture credentials only (no issuance).',
    null,
    '02 §5.3',
    (r) => r.wallet === 'wallet.credo' && r.issuer !== 'issuer.fixture',
  ),
  rule(
    'txcode-scope',
    'withTxCode and not (issuer.certify-preauth × wallet.playground-ts × pre-auth)',
    'tx_code runs only on the local pre-auth issuer with the reference wallet.',
    null,
    'FLOW-02, RISK-25',
    (r) =>
      r.withTxCode &&
      !(
        r.issuer === 'issuer.certify-preauth' &&
        r.wallet === 'wallet.playground-ts' &&
        r.grant === 'pre-authorized_code'
      ),
  ),
  rule(
    'iae-scope',
    'withIae and not (issuer.certify-preauth × wallet.playground-ts × pre-auth)',
    'Presentation during issuance runs only on the local pre-auth issuer with the reference wallet.',
    'G-13',
    'ADR-50',
    (r) =>
      r.withIae &&
      !(
        r.issuer === 'issuer.certify-preauth' &&
        r.wallet === 'wallet.playground-ts' &&
        r.grant === 'pre-authorized_code'
      ),
  ),
  rule(
    'jvm-waltid-signed-unbuilt',
    'wallet.inji-jvm × verifier.waltid',
    'The signed walt.id verifier process for inji-jvm was never smoke-tested in the build (RISK-38 fallback; proven in research only).',
    null,
    'S-205, ADR-48',
    (r) => r.wallet === 'wallet.inji-jvm' && r.verifier === 'verifier.waltid',
    { verifierRule: true },
  ),
  rule(
    'mobile-needs-tunnel',
    'wallet.inji-mobile and tunnel down',
    'Start scripts/tunnel.sh first.',
    'G-105',
    'ADR-15',
    (r) => r.wallet === 'wallet.inji-mobile' && !r.tunnelUp,
    { stateful: true },
  ),
  rule(
    'ldp-collab-verify-needs-tunnel',
    'ldp_vc × verifier.inji-verify-collab and tunnel down',
    'Collab resolves the issuer did:web publicly; start the tunnel.',
    null,
    'S-021',
    (r) => r.format === 'ldp_vc' && r.verifier === 'verifier.inji-verify-collab' && !r.tunnelUp,
    { verifierRule: true, stateful: true },
  ),
];

/**
 * The release gate (ADR-95, docs/decisions.md 2026-10-20): evaluated by the resolver after every
 * 04 §4.3 rule (stateful ones included), so each table rule can still be a first hit and an
 * unreleased adapter is refused with this reason instead of `adapter_unavailable` at Start.
 */
export const NOT_IN_RELEASE_RULE: CompatRule = rule(
  'not-in-release',
  'issuer, wallet or verifier (full runs) outside the release adapters',
  NOT_IN_RELEASE_REASON,
  null,
  'docs/decisions.md 2026-10-20 (T-40), ADR-95',
  (r) =>
    !inRelease(r.issuer) || !inRelease(r.wallet) || (r.scope === 'full' && !inRelease(r.verifier)),
);

/** first matching rule (04 §4.1 step 3; stateful rules are evaluated last, step 6) */
export function firstHit(r: RuleInput, opts: { stateful: boolean }): CompatRule | null {
  for (const c of COMPAT_RULES) {
    if (c.stateful !== opts.stateful) continue;
    if (c.verifierRule && r.scope === 'issuance') continue;
    if (c.applies(r)) return c;
  }
  return null;
}
