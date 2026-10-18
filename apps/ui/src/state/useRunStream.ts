/**
 * Hook that keeps `run:{runId}` current from the run's stream (06 UI-17): one StreamClient per run
 * page, reconciled with API-22 after every reconnect. The run view (T-27) reduces `events`.
 */
import { useEffect, useState } from 'react';
import type { Run } from '@interop-playground/api';
import { apiGet } from '../api/client.js';
import { copy } from '../copy.js';
import { announce } from '../lib/announce.js';
import { reduceRunLog, store, useStore, type RunSlice } from './store.js';
import { StreamClient, type StreamDeps } from './stream.js';

const TERMINAL_STATES: ReadonlySet<Run['state']> = new Set(['completed', 'failed', 'cancelled']);

export function useRunStream(runId: string, overrides: Partial<StreamDeps> = {}) {
  const slice = useStore((s): RunSlice | undefined => s.runs[runId]);
  const [client, setClient] = useState<StreamClient | null>(null);
  useEffect(() => {
    let wasDown = false;
    const c = new StreamClient({
      streamId: runId,
      initialSeq: store.get().runs[runId]?.lastSeq ?? 0,
      onEvent: (event) =>
        store.set((s) => ({
          ...s,
          runs: { ...s.runs, [runId]: reduceRunLog(s.runs[runId], event) },
        })),
      onStatus: (status) => {
        store.set((s) => {
          const prev = s.runs[runId] ?? { events: [], lastSeq: 0, stream: null };
          return { ...s, runs: { ...s.runs, [runId]: { ...prev, stream: status } } };
        });
        if (status.state === 'reconnecting' || status.state === 'polling') {
          if (!wasDown) announce(copy.stream.pausedAnnounce);
          wasDown = true;
        } else if (wasDown && status.state === 'caught-up') {
          wasDown = false;
          announce(copy.stream.backAnnounce);
        }
      },
      reconcile: async () => TERMINAL_STATES.has((await apiGet<Run>(`/runs/${runId}`)).state),
      ...overrides,
    });
    setClient(c);
    c.start();
    return () => c.stop();
  }, [runId]); // overrides are a test seam, fixed per mount
  return { slice, client };
}
