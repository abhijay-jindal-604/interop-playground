/**
 * ConnectionBanner (06 UI-17): `role="status"`, shown only when the stream is not `live`; it never
 * steals focus. "Try live updates again" reopens the EventSource from the `polling` state.
 */
import { copy } from '../copy.js';
import type { StreamStatus } from '../state/stream.js';
import { Icon } from './Icon.js';

/** Banner showing the event stream's connection state, with a retry action when it dropped. */
export function ConnectionBanner({
  status,
  onRetry,
}: {
  status: StreamStatus | null;
  onRetry?: () => void;
}) {
  if (!status) return null;
  let text: string | null;
  let tone = 'info';
  switch (status.state) {
    case 'reconnecting':
      text = copy.stream.reconnecting(status.attempt);
      tone = 'warn';
      break;
    case 'caught-up':
      text = copy.stream.caughtUp(status.caughtUp);
      break;
    case 'polling':
      text = copy.stream.polling;
      tone = 'warn';
      break;
    case 'gone':
      text = copy.stream.gone;
      tone = 'neutral';
      break;
    default:
      text = null;
  }
  return (
    <div role="status" className="connection-status">
      {text ? (
        <div className={`banner tone-${tone}`}>
          <Icon name={tone === 'warn' ? 'st-inconclusive' : 'refresh'} size={20} />
          <p>{text}</p>
          {status.state === 'polling' && onRetry ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
              {copy.stream.retryLive}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The 6 px "Live" dot in the run header (UI-17 `live`). */
export function LiveDot({ status }: { status: StreamStatus | null }) {
  if (status?.state !== 'live') return null;
  return (
    <span className="live-dot" title={copy.stream.live} aria-label={copy.stream.live} role="img" />
  );
}
