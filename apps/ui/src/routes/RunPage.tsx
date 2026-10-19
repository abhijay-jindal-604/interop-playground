/**
 * `/runs/:runId` (06 UI-09): API-22 for the initial `Run` (not-found view on `not_found`), the flow
 * files (API-06), the run stream (UI-17) reduced by the one run reducer (ADR-41), header (UI-10)
 * and the run screen. `replayRunLog` is the `?format=json` path to the same reducer.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { EventEnvelope, EventPage, Run } from '@interop-playground/api';
import { ApiError, apiGet, apiSend } from '../api/client.js';
import { LiveDot } from '../components/ConnectionBanner.js';
import { EmptyState } from '../components/EmptyState.js';
import { shortId } from '../components/RunLink.js';
import { Skeleton } from '../components/Skeleton.js';
import { runCopy } from '../copy.js';
import { useRunFlows } from '../run/flows.js';
import { RunActions, RunHeaderFacts, RunTitleChips } from '../run/parts.js';
import { reduceAll, viewStateOf, type RunView } from '../run/reduce.js';
import { CancelDialog, DeleteDialog, NoteDialog } from '../run/RunDialogs.js';
import { RunScreen } from '../run/RunScreen.js';
import { defaultFetchPage } from '../state/stream.js';
import { useRunStream } from '../state/useRunStream.js';
import { PageFrame } from './PageFrame.js';

/** History replay: page `?format=json` until `closed` and reduce (same reducer as live). */
export async function replayRunLog(
  fetchPage: (after: number) => Promise<EventPage>,
): Promise<{ events: EventEnvelope[]; view: RunView }> {
  const events: EventEnvelope[] = [];
  let after = 0;
  for (;;) {
    const page = await fetchPage(after);
    events.push(...page.events);
    after = page.events.at(-1)?.seq ?? after;
    if (page.closed || page.nextAfter === null || page.events.length === 0) break;
  }
  return { events, view: reduceAll(events) };
}

export const replayRun = (runId: string) => replayRunLog((after) => defaultFetchPage(runId, after));

type RunLoad =
  | { status: 'loading' }
  | { status: 'ready'; run: Run }
  | { status: 'not-found' }
  | { status: 'error' };

export function RunPage() {
  const { runId = '' } = useParams();
  const { slice, client } = useRunStream(runId);
  const [load, setLoad] = useState<RunLoad>({ status: 'loading' });
  const [dialog, setDialog] = useState<'cancel' | 'note' | 'delete' | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<Run>(`/runs/${encodeURIComponent(runId)}`)
      .then((run) => live && setLoad({ status: 'ready', run }))
      .catch((err: unknown) => {
        if (!live) return;
        setLoad(
          err instanceof ApiError && err.code === 'not_found'
            ? { status: 'not-found' }
            : { status: 'error' },
        );
      });
    return () => {
      live = false;
    };
  }, [runId]);
  const view = useMemo(() => reduceAll(slice?.events ?? []), [slice?.events]);
  const run = load.status === 'ready' ? load.run : null;
  const spec = view.spec ?? run?.spec ?? null;
  const flows = useRunFlows(spec);
  const vs = viewStateOf(view, flows.status === 'ready');
  const sid = shortId(runId);

  if (load.status === 'not-found') {
    return (
      <PageFrame title={runCopy.notFound.heading} docTitle={runCopy.title(sid)}>
        <EmptyState
          title={runCopy.notFound.heading}
          body={<p>{runCopy.notFound.body(sid)}</p>}
          action={
            <Link className="btn btn-primary" to="/">
              {runCopy.notFound.action}
            </Link>
          }
        />
      </PageFrame>
    );
  }

  const cancel = () => {
    if (vs === 'queued') void apiSend('POST', `/runs/${runId}/cancel`).catch(() => undefined);
    else setDialog('cancel');
  };
  return (
    <PageFrame
      title={
        <>
          {runCopy.title('')}
          <span className="mono">{sid}</span> <LiveDot status={slice?.stream ?? null} />
          <RunTitleChips vs={vs} view={view} />
        </>
      }
      docTitle={runCopy.title(sid)}
      crumbs={[{ label: 'History', to: '/history' }, { label: runCopy.title(sid) }]}
      actions={
        <RunActions
          runId={runId}
          vs={vs}
          run={run}
          actions={{
            onCancel: cancel,
            onPin: () => {
              void apiSend<Run>('PATCH', `/runs/${runId}`, { pinned: !(run?.pinned ?? false) })
                .then((r) => setLoad({ status: 'ready', run: r }))
                .catch(() => undefined);
            },
            onNote: () => setDialog('note'),
            onDelete: () => setDialog('delete'),
          }}
        />
      }
      lead={
        vs === 'loading' && !spec ? (
          <Skeleton width="60%" height="1.25rem" />
        ) : (
          <>
            {(view.label ?? run?.label) ? (
              <p className="run-label">{view.label ?? run?.label}</p>
            ) : null}
            <RunHeaderFacts view={view} run={run} />
          </>
        )
      }
    >
      <RunScreen
        view={view}
        flows={flows}
        run={run}
        stream={slice?.stream ?? null}
        onRetryLive={() => client?.retryLive()}
        onCancel={cancel}
      />
      <CancelDialog runId={runId} open={dialog === 'cancel'} onClose={() => setDialog(null)} />
      {dialog === 'note' ? (
        <NoteDialog
          runId={runId}
          note={run?.note ?? null}
          open
          onClose={() => setDialog(null)}
          onSaved={(r) => setLoad({ status: 'ready', run: r })}
        />
      ) : null}
      <DeleteDialog
        runId={runId}
        pinned={run?.pinned ?? false}
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
      />
    </PageFrame>
  );
}
