/**
 * Theme preference (06 UI-75): follows `prefers-color-scheme` by default; the shell's switch
 * (light, dark, system) stores the choice in `localStorage` (a convenience only, no server state).
 */
export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'interop-playground.theme';

export function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export function saveTheme(pref: ThemePref): void {
  applyTheme(pref);
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}
