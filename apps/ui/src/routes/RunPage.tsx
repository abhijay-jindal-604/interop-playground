/**
 * `/runs/:runId` (06 UI-09). The shell wires the run stream into `run:{runId}` and shows the
 * connection state; the run screen (header, banners, diagram, step rail, inspector) arrives in T-27.
 */
import { useParams } from 'react-router-dom';
import { ConnectionBanner, LiveDot } from '../components/ConnectionBanner.js';
import { EmptyState } from '../components/EmptyState.js';
import { RunLink, shortId } from '../components/RunLink.js';
import { useRunStream } from '../state/useRunStream.js';
import { PageFrame } from './PageFrame.js';

export function RunPage() {
  const { runId = '' } = useParams();
  const { slice, client } = useRunStream(runId);
  const count = slice?.events.length ?? 0;
  return (
    <PageFrame
      title={
        <>
          Run <span className="mono">{shortId(runId)}</span>{' '}
          <LiveDot status={slice?.stream ?? null} />
        </>
      }
      docTitle={`Run ${shortId(runId)}`}
      crumbs={[{ label: 'History', to: '/history' }, { label: `Run ${shortId(runId)}` }]}
      actions={<RunLink runId={runId} label={runId} />}
    >
      <ConnectionBanner status={slice?.stream ?? null} onRetry={() => client?.retryLive()} />
      <EmptyState
        title="This screen is not built yet"
        body={
          <p>
            The run screen shows the sequence diagram, the step rail and every captured message.{' '}
            {count} event{count === 1 ? '' : 's'} received so far.
          </p>
        }
      />
    </PageFrame>
  );
}
