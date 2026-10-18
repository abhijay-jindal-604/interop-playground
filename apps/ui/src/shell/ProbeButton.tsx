/** "Probe now" (API-11, UI-02): "Probing…" while in flight; `rate_limited` inline under the button. */
import { useState } from 'react';
import type { EnvSnapshot } from '@interop-playground/api';
import { ApiError, apiSend } from '../api/client.js';
import { copy } from '../copy.js';
import { store, useStore } from '../state/store.js';
import { InlineError } from '../components/InlineError.js';
import { Icon } from '../components/Icon.js';

export function ProbeButton({ label = copy.env.probeNow, size }: { label?: string; size?: 'sm' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const offline = useStore((s) => s.env.offline);
  return (
    <div className="probe">
      <button
        type="button"
        className={`btn btn-secondary${size === 'sm' ? ' btn-sm' : ''}`}
        disabled={busy || offline}
        title={offline ? copy.offline.tooltip : undefined}
        onClick={() => {
          setBusy(true);
          setError(null);
          apiSend<EnvSnapshot>('POST', '/env/probe')
            .then((data) => {
              store.set((s) => ({ ...s, env: { ...s.env, snapshot: { status: 'ready', data } } }));
            })
            .catch((e: unknown) => setError(e))
            .finally(() => setBusy(false));
        }}
      >
        <Icon name="refresh" size={16} />
        <span>{busy ? copy.env.probing : label}</span>
      </button>
      {error instanceof ApiError && error.code === 'rate_limited' ? (
        <p className="field-note" role="alert">
          {copy.env.rateLimited(Number(error.details?.retryAfterS ?? 5))}
        </p>
      ) : error ? (
        <InlineError error={error} />
      ) : null}
    </div>
  );
}
