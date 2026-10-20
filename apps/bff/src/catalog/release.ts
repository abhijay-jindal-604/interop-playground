/**
 * The adapters of this release (docs/decisions.md 2026-10-20, T-40 submission cuts; ADR-95). Every
 * other catalog entry is shown as unavailable by API-02 and refused by the `not-in-release` rule
 * (API-03, API-09, API-20) instead of failing at Start with `adapter_unavailable`.
 */
import type { AdapterId } from '@interop-playground/api';

export const RELEASE_ADAPTERS: readonly AdapterId[] = [
  'issuer.certify-preauth',
  'issuer.waltid',
  'issuer.fixture',
  'wallet.playground-ts',
  'verifier.inji-verify-local',
] as AdapterId[];

export const NOT_IN_RELEASE_REASON = 'not in this release (docs/decisions.md 2026-10-20)';

/** True when the adapter ships in this release. */
export const inRelease = (id: AdapterId): boolean => RELEASE_ADAPTERS.includes(id);
