/**
 * Shell banners under the TopBar: the offline banner (06 UI-34) and the degraded EnvBanner (UI-02).
 * Banners are not focus targets; their buttons are in Tab order.
 */
import { copy } from '../copy.js';
import { store, useStore } from '../state/store.js';
import { Icon } from '../components/Icon.js';
import { ProbeButton } from './ProbeButton.js';

export function ShellBanners({ onRetry }: { onRetry: () => void }) {
  const offline = useStore((s) => s.env.offline);
  const degraded = useStore((s) => s.env.degraded);
  const dismissed = useStore((s) => s.env.degradedDismissed);
  return (
    <>
      {offline ? (
        <div className="banner tone-warn" role="status">
          <Icon name="st-failed" size={20} />
          <p>{copy.offline.banner}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
            {copy.tryAgain}
          </button>
        </div>
      ) : null}
      {degraded && !dismissed && !offline ? (
        <div className="banner tone-warn" role="status">
          <Icon name="st-inconclusive" size={20} />
          <p>{copy.env.degradedBanner(degraded.upstreams.join(', '))}</p>
          <div className="banner-actions">
            <ProbeButton label={copy.env.probeAgain} size="sm" />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                store.set((s) => ({ ...s, env: { ...s.env, degradedDismissed: true } }))
              }
            >
              {copy.env.dismiss}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
