/**
 * `issuer.fixture` (plan/12 T-47; 03 FLOW-14, ADR-13): no traffic. One step `vci.fixture.load`
 * (`engine.call{playground-ts, load-fixture}`, capture `none`, outcome `pass`) returns a
 * `dc+sd-jwt` signed at run time by the throwaway issuer key (`fixtures/credentials`, TEST-ONLY)
 * and bound to the run's holder key. The configuration id picks the REQ-23 case:
 *   PlaygroundSdJwt         valid, no `exp`
 *   PlaygroundSdJwtExpired  signature valid, `iat` now − 2 d, `exp` now − 1 d (TMP-39)
 *   PlaygroundSdJwtInvalid  signature byte 0 XOR 0x01 (TMP-30)
 * `mso_mdoc` fixtures are not built (T-48 cut).
 */
import { descriptorOf } from '../catalog.js';
import type {
  AdapterContext,
  AdapterDescriptor,
  Availability,
  CredentialFormat,
  HeldCredential,
  IssuerAdapter,
} from '../contracts.js';
import { inStep } from '../support.js';
import {
  DEFAULT_FIXTURES_DIR,
  loadIssuerKey,
  mintFixture,
  type FixtureIssuerKey,
} from './fixture-mint.js';

export const FIXTURE_VERSION = 'fixture-issuer:1';
export const FIXTURE_CONFIGS = {
  PlaygroundSdJwt: 'valid',
  PlaygroundSdJwtExpired: 'expired',
  PlaygroundSdJwtInvalid: 'invalid',
} as const;
export type FixtureConfigId = keyof typeof FIXTURE_CONFIGS;

export interface FixtureIssuerOptions {
  /** `fixtures/credentials` (default: relative to this module) */
  dir?: string;
  now?: () => number;
}

/** Offline issuer: signs a fixture SD-JWT at run time (valid, expired or tampered by configuration) with no network traffic. */
export class FixtureIssuer implements IssuerAdapter {
  readonly descriptor: AdapterDescriptor;
  private key: FixtureIssuerKey | null = null;

  constructor(private readonly opts: FixtureIssuerOptions = {}) {
    this.descriptor = descriptorOf('issuer.fixture');
  }

  /** Loads the throwaway issuer key on first use. */
  private issuerKey(): FixtureIssuerKey {
    this.key ??= loadIssuerKey(this.opts.dir ?? DEFAULT_FIXTURES_DIR);
    return this.key;
  }

  /** Available whenever the fixture key files can be read. */
  probe(): Promise<Availability> {
    try {
      this.issuerKey();
      return Promise.resolve({ available: true, versionFingerprint: FIXTURE_VERSION });
    } catch (e) {
      return Promise.resolve({
        available: false,
        reason: e instanceof Error ? e.message : String(e),
        versionFingerprint: FIXTURE_VERSION,
      });
    }
  }

  /** The fixture has no issuer-side knobs, so the baseline configuration is the variant. */
  resolveVariant(_ctx: AdapterContext, baselineConfigurationId: string): Promise<string> {
    return Promise.resolve(baselineConfigurationId);
  }

  /** There is no issuer to fetch metadata from. */
  metadata(): Promise<{ issuer: unknown; authorizationServer: unknown; exchangeIds: string[] }> {
    return Promise.resolve({ issuer: null, authorizationServer: null, exchangeIds: [] });
  }

  /** Signs the fixture credential for the run's holder key; only `dc+sd-jwt` is built. */
  async fixture(ctx: AdapterContext, format: CredentialFormat): Promise<HeldCredential> {
    if (format !== 'dc+sd-jwt')
      throw new Error(`issuer.fixture: no ${format} fixture (mso_mdoc fixtures are cut with T-48)`);
    const configurationId = ctx.spec.configurationId;
    const kind = FIXTURE_CONFIGS[configurationId as FixtureConfigId];
    if (!kind) throw new Error(`issuer.fixture: unknown configuration ${configurationId}`);
    const holderKey = await ctx.holderKey();
    return inStep(ctx, 'vci.fixture.load', async () => {
      const raw = mintFixture(kind, {
        issuer: this.issuerKey(),
        holder: holderKey,
        nowMs: (this.opts.now ?? Date.now)(),
      });
      await ctx.emit({
        type: 'engine.call',
        stepKey: 'vci.fixture.load',
        engine: 'playground-ts',
        op: 'load-fixture',
        inputSummary: { format, configurationId },
        outputSummary: { kind, bytes: raw.length, issuer: 'issuer.fixture' },
      });
      const held: HeldCredential = {
        format,
        raw,
        holderKey,
        issuerAdapter: 'issuer.fixture',
        configurationId,
      };
      return { outcome: 'pass', capture: 'none', value: held };
    });
  }
}
