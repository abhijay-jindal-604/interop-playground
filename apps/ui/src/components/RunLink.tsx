/**
 * `RunLink({runId, label})` (06 UI-50, UI-01): the short id in mono, the full ULID in `title`, a
 * link to `/runs/:runId` and a CopyButton beside it. Short id = last 8 characters (ADR-63).
 */
import { Link } from 'react-router-dom';
import { CopyButton } from './CopyButton.js';

/** The last eight characters of a run id, enough to tell runs apart on screen. */
export const shortId = (runId: string): string => runId.slice(-8);

/** A link to a run showing its short id, with an optional copy button for the full id. */
export function RunLink({
  runId,
  label,
  copyable = true,
}: {
  runId: string;
  label?: string;
  copyable?: boolean;
}) {
  return (
    <span className="run-link">
      <Link to={`/runs/${runId}`} title={runId} className="mono">
        {label ?? shortId(runId)}
      </Link>
      {copyable ? <CopyButton text={runId} label={`Copy run id ${shortId(runId)}`} /> : null}
    </span>
  );
}
