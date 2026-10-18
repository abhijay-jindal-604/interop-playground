/** Fixture answers for the shell's boot requests (06 UI-02), shared by unit tests and e2e. */
import type {
  AdapterListResponse,
  EnvSnapshot,
  Health,
  RunListResponse,
} from '@interop-playground/api';

export const health: Health = {
  status: 'ok',
  bff: { version: '0.0.0', uptimeS: 12 },
  sidecar: { reachable: true, version: '0.1.0' },
  adapters: [],
};

const descriptor = (id: string, role: 'issuer' | 'wallet' | 'verifier', displayName: string) => ({
  id,
  role,
  vendor: 'inji' as const,
  displayName,
  envClass: 'local' as const,
  tier: 'automated' as const,
  formats: ['dc+sd-jwt' as const, 'ldp_vc' as const],
  knobs: [],
  coverage: { default: 'full' as const, partialHops: [] },
});

export const adapters = {
  issuers: [
    {
      descriptor: descriptor(
        'issuer.certify-preauth',
        'issuer',
        'Inji Certify (pre-authorized code)',
      ),
      availability: { available: true, versionFingerprint: 'certify@0.12' },
      probedAt: null,
    },
  ],
  wallets: [
    {
      descriptor: descriptor('wallet.playground-ts', 'wallet', 'Playground wallet'),
      availability: { available: true, versionFingerprint: 'pg@0' },
      probedAt: null,
    },
  ],
  verifiers: [
    {
      descriptor: descriptor('verifier.inji-verify-local', 'verifier', 'Inji Verify (local)'),
      availability: {
        available: false,
        reason: 'inji-verify is not ready',
        versionFingerprint: 'verify@0.13',
      },
      probedAt: null,
    },
  ],
} as unknown as AdapterListResponse;

export const env: EnvSnapshot = {
  mode: 'full-local',
  ready: true,
  upstreams: [
    {
      upstream: 'certify',
      ok: true,
      checkedAt: '2026-10-13T10:00:00.000Z',
      detail: null,
      versionFingerprint: 'certify@0.12',
    },
    {
      upstream: 'inji-verify',
      ok: true,
      checkedAt: '2026-10-13T10:00:00.000Z',
      detail: null,
      versionFingerprint: 'verify@0.13',
    },
  ],
  tunnel: { state: 'down' },
  collabBudget: { windowS: 60, limit: 20, used: 0 },
  publicHost: '192.0.2.10',
};

export const runs: RunListResponse = { items: [], nextCursor: null };

export const BOOT_FIXTURES: Record<string, unknown> = {
  '/api/v1/health': health,
  '/api/v1/adapters': adapters,
  '/api/v1/env': env,
  '/api/v1/knobs': { items: [] },
  '/api/v1/presets': { items: [] },
  '/api/v1/incompatibilities': { items: [] },
  '/api/v1/runs': runs,
};
