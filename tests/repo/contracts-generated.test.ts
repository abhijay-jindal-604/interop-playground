/**
 * plan/11 §4.3 `contracts.generated`: contracts:generate is idempotent and the committed generated
 * files are fresh (same check as `npm run contracts:check`, without git). Schema coverage of 04 §3,
 * §2 and §7.2 is asserted in packages/api/src/api.contract.test.ts. The golden-sample part arrives
 * with the golden fixtures (T-10).
 */
import { describe, expect, it } from 'vitest';
import { runNode } from './helpers.js';

describe('contracts.generated', () => {
  it('regenerating produces the committed files byte for byte', () => {
    const result = runNode('scripts/contracts-generate.mjs', ['--check-only']);
    expect(result.status, result.output).toBe(0);
  });
});
