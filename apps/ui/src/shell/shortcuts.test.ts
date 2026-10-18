import { describe, expect, it } from 'vitest';
import { matchShortcut } from './shortcuts.js';

const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({
  altKey: true,
  shiftKey: true,
  ctrlKey: false,
  metaKey: false,
  code,
  target: document.body,
  ...extra,
});

describe('ui.shortcuts', () => {
  it('maps Alt+Shift letters to routes and K to the help dialog (UI-77)', () => {
    expect(matchShortcut(key('KeyH'))).toEqual({ kind: 'navigate', to: '/history' });
    expect(matchShortcut(key('KeyN'))).toEqual({ kind: 'navigate', to: '/' });
    expect(matchShortcut(key('KeyK'))).toEqual({ kind: 'help' });
  });

  it('ignores bare keys, other modifiers and text fields', () => {
    expect(matchShortcut(key('KeyH', { altKey: false }))).toBeNull();
    expect(matchShortcut(key('KeyH', { ctrlKey: true }))).toBeNull();
    const input = document.createElement('input');
    expect(matchShortcut(key('KeyH', { target: input }))).toBeNull();
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(matchShortcut(key('KeyH', { target: box }))).toEqual({
      kind: 'navigate',
      to: '/history',
    });
  });
});
