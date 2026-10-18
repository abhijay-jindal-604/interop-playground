/** `StatusBadge({state, size})` (06 UI-50, UI-74): always glyph + word, never colour alone. */
import { STATE_MEANINGS, STATE_WORDS } from '../copy.js';
import { Icon } from './Icon.js';

export type BadgeState = keyof typeof STATE_WORDS;

const TOKEN: Record<BadgeState, string> = {
  pass: 'pass',
  fail: 'fail',
  blocked: 'fail',
  lenient: 'neutral',
  inconclusive: 'warn',
  'no-submission': 'neutral',
  'n/a': 'skipped',
  'not-run': 'skipped',
  queued: 'info',
  running: 'info',
  cancelled: 'skipped',
  failed: 'warn',
};

export function StatusBadge({ state, size = 'sm' }: { state: BadgeState; size?: 'sm' | 'md' }) {
  const meaning = STATE_MEANINGS[state];
  return (
    <span className={`badge badge-${size} tone-${TOKEN[state]}`} title={meaning}>
      <Icon name={`st-${state}`} size={size === 'sm' ? 16 : 20} />
      <span>{STATE_WORDS[state]}</span>
    </span>
  );
}
