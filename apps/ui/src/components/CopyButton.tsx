/** `CopyButton` (06 UI-50): copies text, shows "Copied" for 2 s through the polite live region. */
import { useEffect, useState } from 'react';
import { announce } from '../lib/announce.js';
import { copy } from '../copy.js';
import { Icon } from './Icon.js';

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2_000);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="btn-icon"
      aria-label={label}
      title={done ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          announce(copy.copied);
        });
      }}
    >
      <Icon name="copy" size={16} />
    </button>
  );
}
