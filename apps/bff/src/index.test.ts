import { describe, expect, it } from 'vitest';
import { BFF_PACKAGE } from './index.js';

describe('bff.skeleton', () => {
  it('exports its package name', () => {
    expect(BFF_PACKAGE).toBe('@interop-playground/bff');
  });
});
