import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@interop-playground/api';
import { ERROR_COPY, errorText, fill, pageTitle } from './copy.js';

describe('ui.copy', () => {
  it('has fixed copy for every 04 §6.2 error code (40, UI-31)', () => {
    expect(ERROR_CODES).toHaveLength(40);
    for (const code of ERROR_CODES) expect(ERROR_COPY[code], code).toMatch(/\S/);
    expect(Object.keys(ERROR_COPY).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('fills {x} from details and lists the first three validation issues', () => {
    expect(errorText('incompatible_selection', { reason: 'no shared format', gapId: 'G-12' })).toBe(
      'This combination cannot run: no shared format (G-12).',
    );
    const issues = [1, 2, 3, 4].map((i) => ({ path: `/f${i}`, message: 'bad' }));
    expect(errorText('validation_failed', { issues })).toBe(
      'Some values are not valid: /f1: bad; /f2: bad; /f3: bad. Fix them and try again.',
    );
    expect(fill('({was} to {now})', { was: null, now: 'a.example' })).toBe('(down to a.example)');
  });

  it('falls back to internal_error copy for an unknown code', () => {
    expect(errorText('brand_new_code')).toBe(ERROR_COPY.internal_error);
  });

  it('builds page titles as "{screen} · Interop Playground" (UI-01)', () => {
    expect(pageTitle()).toBe('Interop Playground');
    expect(pageTitle('Environment')).toBe('Environment · Interop Playground');
  });
});
