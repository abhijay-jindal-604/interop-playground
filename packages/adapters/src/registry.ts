/**
 * The real adapters the BFF registers (`main.ts` → `startServer(env, { adapters })`). Shape =
 * the orchestrator's `AdapterSet` (apps/bff/src/orchestrator/engine.ts): `issuer.certify-preauth`,
 * `wallet.playground-ts`, `verifier.inji-verify-local`, `issuer.waltid` (T-43, peers profile), `issuer.fixture` (T-47, no traffic). Adapters still to come answer `undefined`,
 * which the runs API reports as `adapter_unavailable`.
 */
import path from 'node:path';
import type {
  GatewayCorrelation,
  IssuerAdapter,
  VerifierAdapter,
  WalletAdapter,
} from './contracts.js';
import { CertifyPreauthIssuer } from './issuers/certify-preauth.js';
import { FixtureIssuer } from './issuers/fixture.js';
import { WaltidIssuer, x5cMaterialFromFiles } from './issuers/waltid.js';
import { InjiVerifyLocalVerifier } from './verifiers/inji-verify-local.js';
import { PlaygroundTsWallet } from './wallets/playground-ts.js';

export interface AdapterSetLike {
  issuer(id: string): IssuerAdapter | undefined;
  wallet(id: string): WalletAdapter | undefined;
  verifier(id: string): VerifierAdapter | undefined;
}

export interface BundleAdapterOptions {
  /** ADR-06: the advertised host (`PUBLIC_HOST`) */
  publicHost: string;
  /** service-name bases; defaults are the compose service names (10 §7.2) */
  certifyPreauthBase?: string;
  verifyServiceBase?: string;
  waltidIssuerBase?: string;
  /** peer key material (`certs/peers`, /certs/peers in the bff container): KNOB-01 `present` */
  peersCertDir?: string;
  /** rendered config root (`CONFIG_DIR`, /config in the bff container) */
  configDir?: string;
  gateway?: GatewayCorrelation;
  /** `fixtures/credentials` (default: relative to the adapters package) */
  fixturesDir?: string;
  /** extra wallets (later tasks, tests); an entry replaces the built-in one of the same id */
  wallets?: Readonly<Record<string, WalletAdapter>>;
}

/** Constructs the real adapters (and their shared HTTP, correlation and key services) from the environment; roles not yet built answer undefined and surface as `adapter_unavailable`. */
export function bundleAdapters(o: BundleAdapterOptions): AdapterSetLike & {
  certifyPreauth: CertifyPreauthIssuer;
  injiVerifyLocal: InjiVerifyLocalVerifier;
  playgroundTs: PlaygroundTsWallet;
  waltid: WaltidIssuer;
  fixture: FixtureIssuer;
} {
  const certifyPreauth = new CertifyPreauthIssuer({
    internalBase: o.certifyPreauthBase ?? 'http://certify-preauth:8090',
    publicBase: `https://${o.publicHost}`,
    ...(o.configDir
      ? { configDir: path.join(o.configDir, 'certify-preauth', 'credential-configs') }
      : {}),
    ...(o.gateway ? { gateway: o.gateway } : {}),
  });
  const injiVerifyLocal = new InjiVerifyLocalVerifier({
    internalBase: o.verifyServiceBase ?? 'http://verify-service:8080/v1/verify',
    ...(o.gateway ? { gateway: o.gateway } : {}),
  });
  const peers = o.peersCertDir ?? '/certs/peers';
  const waltid = new WaltidIssuer({
    internalBase: o.waltidIssuerBase ?? 'http://waltid-issuer-api2:8080',
    publicBase: `http://${o.publicHost}:18103`,
    x5c: x5cMaterialFromFiles(
      path.join(peers, 'waltid-issuer.key'),
      path.join(peers, 'waltid-issuer.pem'),
    ),
    ...(o.gateway ? { gateway: o.gateway } : {}),
  });
  const fixture = new FixtureIssuer(o.fixturesDir ? { dir: o.fixturesDir } : {});
  const issuers: Record<string, IssuerAdapter> = {
    'issuer.certify-preauth': certifyPreauth,
    'issuer.waltid': waltid,
    'issuer.fixture': fixture,
  };
  const verifiers: Record<string, VerifierAdapter> = {
    'verifier.inji-verify-local': injiVerifyLocal,
  };
  const playgroundTs = new PlaygroundTsWallet(o.gateway ? { gateway: o.gateway } : {});
  const wallets: Record<string, WalletAdapter> = {
    'wallet.playground-ts': playgroundTs,
    ...o.wallets,
  };
  return {
    certifyPreauth,
    injiVerifyLocal,
    playgroundTs,
    waltid,
    fixture,
    issuer: (id) => issuers[id],
    wallet: (id) => wallets[id],
    verifier: (id) => verifiers[id],
  };
}
