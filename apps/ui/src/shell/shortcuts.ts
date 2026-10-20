/**
 * Global shortcuts (06 UI-77, which wins over UI-32 per RISK-33): `Alt+Shift` + a letter, never a
 * bare key (WCAG 2.1.4); disabled while focus is in a text field, a select or a contenteditable.
 * Matched on `KeyboardEvent.code` because Alt changes `key` on macOS.
 */
export const GLOBAL_SHORTCUTS = [
  { code: 'KeyN', keys: 'Alt+Shift+N', action: 'Go to the playground (new run)', to: '/' },
  { code: 'KeyH', keys: 'Alt+Shift+H', action: 'Go to History', to: '/history' },
  { code: 'KeyM', keys: 'Alt+Shift+M', action: 'Go to Matrix', to: '/matrix' },
  { code: 'KeyT', keys: 'Alt+Shift+T', action: 'Go to Tamper', to: '/tamper' },
  { code: 'KeyD', keys: 'Alt+Shift+D', action: 'Go to Issue drafts', to: '/drafts' },
  { code: 'KeyK', keys: 'Alt+Shift+K', action: 'Open this list of shortcuts', to: null },
] as const;

export const OTHER_KEYS = [
  { keys: 'Alt+Shift+F', action: 'Focus the search box (History, Tamper)' },
  { keys: 'Esc', action: 'Close the topmost dialog, drawer or menu' },
] as const;

/** True when the key event came from a field the user is typing in, where shortcuts must not fire. */
export function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
      type,
    );
  }
  return false;
}

export type ShortcutHit = { kind: 'navigate'; to: string } | { kind: 'help' } | null;

/** Maps an Alt+Shift key event to a shortcut action, or null when it is not one of ours. */
export function matchShortcut(
  e: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'code' | 'target'>,
): ShortcutHit {
  if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return null;
  if (inTextField(e.target)) return null;
  const hit = GLOBAL_SHORTCUTS.find((s) => s.code === e.code);
  if (!hit) return null;
  return hit.to === null ? { kind: 'help' } : { kind: 'navigate', to: hit.to };
}
