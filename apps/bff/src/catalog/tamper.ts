/**
 * Tamper applicability (04 §4.5, 07 §4.9): which TMP case may run on a resolved
 * (issuer, wallet, verifier, format). The cases themselves (mutations, judging) arrive with T-76;
 * this table is the selector's and the resolver's applicability rule only.
 */
import type { AdapterId, CredentialFormat, TmpId } from '@interop-playground/api';

export type TamperBlock = '4.1' | '4.2' | '4.3' | '4.4' | '4.5' | '4.6' | '4.7' | '4.8' | '4.10';

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** 07 §4.1..§4.10 case numbers per block (TMP-49 sits in 4.3, TMP-79 in 4.6) */
const BLOCK_CASES: Record<TamperBlock, number[]> = {
  '4.1': range(1, 10),
  '4.2': range(11, 29),
  '4.3': [...range(30, 39), 49],
  '4.4': range(40, 48),
  '4.5': range(50, 54),
  '4.6': [...range(55, 69), 79],
  '4.7': range(70, 73),
  '4.8': range(74, 78),
  '4.10': range(80, 82),
};

export const TAMPER_CASES: readonly TmpId[] = Object.values(BLOCK_CASES)
  .flat()
  .sort((a, b) => a - b)
  .map((n): TmpId => `TMP-${String(n).padStart(2, '0')}`);

/** The block (group) a tamper case id such as TMP-07 belongs to, or null for an id that does not parse. */
export function blockOf(tmpId: string): TamperBlock | null {
  const m = /^TMP-(\d{2})$/.exec(tmpId);
  if (!m) return null;
  const n = Number(m[1]);
  for (const [block, cases] of Object.entries(BLOCK_CASES) as [TamperBlock, number[]][])
    if (cases.includes(n)) return block;
  return null;
}

/** blocks 4.3–4.8 and 4.10 judge at (or need) a verifier */
const NEEDS_VERIFIER: readonly TamperBlock[] = ['4.3', '4.4', '4.5', '4.6', '4.7', '4.8', '4.10'];

export interface TamperTarget {
  issuer: AdapterId;
  wallet: AdapterId;
  verifier: AdapterId;
  format: CredentialFormat;
  scope: 'issuance' | 'full';
}

const ALL_THREE: readonly CredentialFormat[] = ['ldp_vc', 'dc+sd-jwt', 'mso_mdoc'];
const PG = 'wallet.playground-ts';

/** null when the case applies, else the reason (04 §4.5 `details.reason`) */
export function tamperInapplicability(tmpId: string, t: TamperTarget): string | null {
  const block = blockOf(tmpId);
  if (block === null) return 'unknown tamper case';
  const n = Number(tmpId.slice(4));
  if (t.scope === 'issuance' && NEEDS_VERIFIER.includes(block))
    return 'the case is judged at a verifier; scope is issuance';
  const no = (what: string): string => `tamper case not applicable (${what})`;
  switch (block) {
    case '4.1': {
      if (t.wallet !== PG) return no('wallet must be wallet.playground-ts');
      if (!ALL_THREE.includes(t.format)) return no('format');
      if (t.issuer === 'issuer.certify-preauth') return null;
      if (t.issuer === 'issuer.waltid' && ![2, 6, 7].includes(n)) return null;
      return no('issuer');
    }
    case '4.2': {
      if (t.wallet !== PG) return no('wallet must be wallet.playground-ts');
      if (!ALL_THREE.includes(t.format)) return no('format');
      const certify = ['issuer.certify-preauth', 'issuer.certify-authcode'].includes(t.issuer);
      if (certify || (t.issuer === 'issuer.waltid' && n !== 20)) return null;
      return no('issuer');
    }
    case '4.3': {
      if (t.wallet !== PG || t.format !== 'dc+sd-jwt') return no('wallet or format');
      const issuerOk =
        n === 39 ? t.issuer === 'issuer.fixture' : t.issuer === 'issuer.certify-preauth';
      if (!issuerOk) return no('issuer');
      const verifiers: AdapterId[] = [
        'verifier.vcverifier-offline',
        'verifier.inji-verify-local',
        'verifier.inji-verify-collab',
        'verifier.credo',
        'verifier.waltid',
      ];
      return verifiers.includes(t.verifier) ? null : no('verifier');
    }
    case '4.4': {
      if (t.wallet !== PG || t.format !== 'ldp_vc') return no('wallet or format');
      const issuers: AdapterId[] =
        n === 46 ? ['issuer.fixture'] : ['issuer.certify-preauth', 'issuer.certify-authcode'];
      if (!issuers.includes(t.issuer)) return no('issuer');
      const verifiers: AdapterId[] = [
        'verifier.inji-verify-local',
        'verifier.inji-verify-collab',
        'verifier.vcverifier-offline',
        'verifier.credo',
      ];
      return verifiers.includes(t.verifier) ? null : no('verifier');
    }
    case '4.5': {
      if (t.wallet !== PG || t.format !== 'mso_mdoc') return no('wallet or format');
      if (t.issuer !== 'issuer.certify-mdoc') return no('issuer');
      return ['verifier.eudi', 'verifier.credo'].includes(t.verifier) ? null : no('verifier');
    }
    case '4.6': {
      if (t.wallet !== PG || t.format !== 'dc+sd-jwt') return no('wallet or format');
      if (t.issuer !== 'issuer.certify-preauth') return no('issuer');
      // 07 §4.9 note: EUDI rejects Certify cnf.kid (G-59), so eudi leaves block 4.6
      if (t.verifier === 'verifier.eudi') return 'G-59: verifier.eudi rejects Certify cnf.kid';
      const verifiers: AdapterId[] = [
        'verifier.inji-verify-local',
        'verifier.inji-verify-collab',
        'verifier.inji-verify-sdk',
        'verifier.waltid',
      ];
      return verifiers.includes(t.verifier) ? null : no('verifier');
    }
    case '4.7': {
      if (t.wallet !== PG || t.format !== 'ldp_vc') return no('wallet or format');
      if (t.issuer !== 'issuer.certify-preauth') return no('issuer');
      const verifiers: AdapterId[] = [
        'verifier.inji-verify-local',
        'verifier.inji-verify-collab',
        'verifier.inji-verify-sdk',
        'verifier.waltid',
      ];
      return verifiers.includes(t.verifier) ? null : no('verifier');
    }
    case '4.8': {
      if (!['wallet.inji-jvm', 'wallet.credo'].includes(t.wallet))
        return no('the wallet under test must be wallet.inji-jvm or wallet.credo');
      if (!['dc+sd-jwt', 'ldp_vc'].includes(t.format)) return no('format');
      if (t.verifier === 'verifier.inji-verify-local') return null;
      if (t.verifier === 'verifier.inji-verify-collab' && n !== 76) return null;
      return no('request source');
    }
    case '4.10': {
      if (t.wallet !== PG || t.format !== 'dc+sd-jwt') return no('wallet or format');
      return t.verifier === 'verifier.inji-verify-local' ? null : no('verifier');
    }
  }
}

/** Every tamper case that can be applied to the given issuer, wallet, verifier and format. */
export function applicableTamperCases(t: TamperTarget): TmpId[] {
  return TAMPER_CASES.filter((id) => tamperInapplicability(id, t) === null);
}
