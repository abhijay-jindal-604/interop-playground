/**
 * Selector model (ADR-94, ADR-95): the credential-level mode is `presentationMode: null`, the
 * fixture case rides as `configurationId` (`?config=`), and the release cut reads as such.
 */
import { describe, expect, it } from 'vitest';
import type { AdapterId } from '@interop-playground/api';
import { selectorCopy } from '../copy.js';
import { cardRequest, defaultSelection, fromQuery, toRequest } from './model.js';

const FIXTURE = 'issuer.fixture' as AdapterId;

describe('selector model: FLOW-40 and fixture cases', () => {
  it('credential-level mode sends presentationMode null', () => {
    const s = { ...defaultSelection(null), mode: 'credential-level' as const };
    expect(toRequest(s).presentationMode).toBeNull();
    expect(toRequest(defaultSelection(null)).presentationMode).toBe('cross-device');
  });

  it('?config= picks the fixture case only for issuer.fixture', () => {
    const base = defaultSelection(null);
    const s = fromQuery(
      new URLSearchParams(
        'issuer=issuer.fixture&mode=credential-level&config=PlaygroundSdJwtExpired',
      ),
      base,
    );
    expect(s.mode).toBe('credential-level');
    expect(toRequest(s)).toMatchObject({
      issuer: FIXTURE,
      configurationId: 'PlaygroundSdJwtExpired',
      presentationMode: null,
    });
    const other = fromQuery(new URLSearchParams('config=PlaygroundSdJwtExpired'), base);
    expect(other.configurationId).toBeNull();
    expect('configurationId' in toRequest(other)).toBe(false);
    // a card of another issuer drops the fixture case
    expect('configurationId' in cardRequest(s, 'issuer', 'issuer.waltid')).toBe(false);
    expect(cardRequest(s, 'wallet', 'wallet.playground-ts').configurationId).toBe(
      'PlaygroundSdJwtExpired',
    );
  });

  it('an adapter outside the release reads "Not in this release", a stopped one "Not running"', () => {
    expect(selectorCopy.unavailable('not in this release (docs/decisions.md 2026-10-20)')).toBe(
      'Not in this release (docs/decisions.md 2026-10-20)',
    );
    expect(selectorCopy.unavailable('verify-service: down')).toBe(
      'Not running: verify-service: down',
    );
  });
});
