import { describe, expect, it } from 'vitest';
import { UI_PACKAGE } from './index.js';

describe('ui.skeleton', () => {
  it('exports its package name', () => {
    expect(UI_PACKAGE).toBe('@interop-playground/ui');
  });
});
