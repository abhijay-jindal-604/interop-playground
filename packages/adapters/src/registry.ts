/**
 * The real adapters the BFF registers (`main.ts` → `startServer(env, { adapters })`). Shape =
 * the orchestrator's `AdapterSet` (apps/bff/src/orchestrator/engine.ts). Adapters still to come
 * (T-24 wallet, T-26 …) answer `undefined`, which the runs API reports as `adapter_unavailable`.
 */
import path from 'node:path';
import type { IssuerAdapter, VerifierAdapter, WalletAdapter } from './contracts.js';
import { CertifyPreauthIssuer } from './issuers/certify-preauth.js';
import type { GatewayCorrelation } from './support.js';
import { InjiVerifyLocalVerifier } from './verifiers/inji-verify-local.js';

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
  /** rendered config root (`CONFIG_DIR`, /config in the bff container) */
  configDir?: string;
  gateway?: GatewayCorrelation;
  /** wallets registered by later tasks or by tests */
  wallets?: Readonly<Record<string, WalletAdapter>>;
}

export function bundleAdapters(o: BundleAdapterOptions): AdapterSetLike & {
  certifyPreauth: CertifyPreauthIssuer;
  injiVerifyLocal: InjiVerifyLocalVerifier;
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
  const issuers: Record<string, IssuerAdapter> = { 'issuer.certify-preauth': certifyPreauth };
  const verifiers: Record<string, VerifierAdapter> = {
    'verifier.inji-verify-local': injiVerifyLocal,
  };
  const wallets = o.wallets ?? {};
  return {
    certifyPreauth,
    injiVerifyLocal,
    issuer: (id) => issuers[id],
    wallet: (id) => wallets[id],
    verifier: (id) => verifiers[id],
  };
}
