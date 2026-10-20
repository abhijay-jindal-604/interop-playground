/**
 * RunsButton and the Recent runs drawer (06 UI-29): API-21 `limit=15`, loaded on first open;
 * the button's badge counts runs that are queued or running. Rows are links.
 */
import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Run, RunListResponse } from '@interop-playground/api';
import { apiGet } from '../api/client.js';
import { copy } from '../copy.js';
import { localDateTime, relative } from '../lib/format.js';
import { FORMAT_SHORT, runBadge } from '../lib/labels.js';
import type { Load } from '../state/store.js';
import { Drawer } from '../components/Drawer.js';
import { EmptyState } from '../components/EmptyState.js';
import { Icon } from '../components/Icon.js';
import { InlineError } from '../components/InlineError.js';
import { shortId } from '../components/RunLink.js';
import { Skeleton } from '../components/Skeleton.js';
import { StatusBadge } from '../components/StatusBadge.js';

/** The "recent runs" menu in the header; loads the latest runs when opened. */
export function RecentRuns() {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<Load<Run[]>>({ status: 'idle' });
  const button = useRef<HTMLButtonElement>(null);
  const load = useCallback(() => {
    setRuns({ status: 'loading' });
    apiGet<RunListResponse>('/runs', { limit: 15 })
      .then((page) => setRuns({ status: 'ready', data: page.items }))
      .catch((error: unknown) => setRuns({ status: 'error', error }));
  }, []);
  const active =
    runs.status === 'ready'
      ? runs.data.filter((r) => r.state === 'queued' || r.state === 'running').length
      : 0;

  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-ghost runs-button"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          if (runs.status === 'idle' || runs.status === 'error') load();
        }}
      >
        <Icon name="runs" size={18} />
        <span className="runs-label">{copy.runs.button}</span>
        {active > 0 ? <span className="counter">{copy.runs.running(active)}</span> : null}
      </button>
      <Drawer
        open={open}
        title={copy.runs.heading}
        onClose={() => setOpen(false)}
        returnFocus={button}
        footer={
          <Link to="/history" onClick={() => setOpen(false)}>
            {copy.runs.seeAll}
          </Link>
        }
      >
        {runs.status === 'loading' || runs.status === 'idle' ? (
          <ul className="run-rows" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="run-row">
                <Skeleton width="5rem" height="1.25rem" />
                <Skeleton width="70%" />
              </li>
            ))}
          </ul>
        ) : runs.status === 'error' ? (
          <div className="region-error">
            <p>{copy.runs.error}</p>
            <InlineError error={runs.error} alert={false} onRetry={load} />
          </div>
        ) : runs.data.length === 0 ? (
          <EmptyState
            title={copy.runs.heading}
            body={copy.runs.empty}
            action={
              <Link className="btn btn-secondary" to="/" onClick={() => setOpen(false)}>
                {copy.runs.emptyAction}
              </Link>
            }
          />
        ) : (
          <ul className="run-rows">
            {runs.data.map((r) => (
              <li key={r.runId}>
                <Link className="run-row" to={`/runs/${r.runId}`} onClick={() => setOpen(false)}>
                  <span className="run-row-top">
                    <StatusBadge state={runBadge(r)} />
                    {r.awaiting ? (
                      <span className="chip tone-info">{copy.runs.waiting}</span>
                    ) : null}
                    <span className="chip">{FORMAT_SHORT[r.spec.format]}</span>
                    <span className="mono muted" title={r.runId}>
                      {shortId(r.runId)}
                    </span>
                  </span>
                  <span className="run-row-combo">
                    {r.spec.issuer} → {r.spec.wallet} → {r.spec.verifier}
                  </span>
                  <span className="run-row-meta muted">
                    <time
                      dateTime={r.createdAt}
                      title={`${r.createdAt} (${relative(r.createdAt)})`}
                    >
                      {localDateTime(r.createdAt)}
                    </time>
                    {r.links.parentRunId ? (
                      <span> · {copy.runs.rerunOf(shortId(r.links.parentRunId))}</span>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Drawer>
    </>
  );
}
