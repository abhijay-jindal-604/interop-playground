/** Theme switch (06 UI-75): light, dark, system; a native radio group, so arrows work. */
import { useState } from 'react';
import { copy } from '../copy.js';
import { readTheme, saveTheme, type ThemePref } from '../lib/theme.js';
import { Icon, type IconName } from '../components/Icon.js';

const OPTIONS: { value: ThemePref; label: string; icon: IconName }[] = [
  { value: 'light', label: copy.theme.light, icon: 'sun' },
  { value: 'dark', label: copy.theme.dark, icon: 'moon' },
  { value: 'system', label: copy.theme.system, icon: 'system' },
];

export function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>(() => readTheme());
  return (
    <fieldset className="theme-switch">
      <legend className="visually-hidden">{copy.theme.label}</legend>
      {OPTIONS.map((o) => (
        <label key={o.value} className="theme-option" title={o.label}>
          <input
            type="radio"
            name="theme"
            value={o.value}
            checked={pref === o.value}
            onChange={() => {
              setPref(o.value);
              saveTheme(o.value);
            }}
          />
          <Icon name={o.icon} size={16} />
          <span className="visually-hidden">{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
