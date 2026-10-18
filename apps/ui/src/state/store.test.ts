import { describe, expect, it } from 'vitest';
import type { EnvSnapshot, EventEnvelope } from '@interop-playground/api';
import { ev } from '../test/fake-event-source.js';
import {
  MAX_TOASTS,
  createStore,
  initialState,
  pushToast,
  reduceEnv,
  reduceRunLog,
} from './store.js';

const snapshot: EnvSnapshot = {
  mode: 'full-local',
  ready: true,
  upstreams: [
    {
      upstream: 'certify',
      ok: true,
      checkedAt: '2026-10-13T10:00:00.000Z',
      detail: null,
      versionFingerprint: 'v1',
    },
  ],
  tunnel: { state: 'down' },
  collabBudget: { windowS: 60, limit: 20, used: 0 },
  publicHost: '192.0.2.10',
};

function envEvent<T extends EventEnvelope['type']>(
  type: T,
  payload: EventEnvelope<T>['payload'],
): EventEnvelope {
  return { ...ev(1, type, 'env'), payload };
}

describe('ui.store', () => {
  const base = { ...initialState().env, snapshot: { status: 'ready' as const, data: snapshot } };

  it('env.degraded marks not ready with the named upstreams; env.ready clears it', () => {
    const degraded = reduceEnv(
      base,
      envEvent('env.degraded', { upstreams: ['certify'], reasons: { certify: 'down' } }),
    );
    expect(degraded.degraded?.upstreams).toEqual(['certify']);
    expect(degraded.snapshot.status === 'ready' && degraded.snapshot.data.ready).toBe(false);
    const ready = reduceEnv(degraded, envEvent('env.ready', { upstreams: ['certify'] }));
    expect(ready.degraded).toBeNull();
    expect(ready.snapshot.status === 'ready' && ready.snapshot.data.ready).toBe(true);
  });

  it('env.probe updates one upstream row; env.tunnel and env.fingerprint update the snapshot', () => {
    let s = reduceEnv(
      base,
      envEvent('env.probe', {
        upstream: 'certify',
        ok: false,
        detail: 'timeout',
        versionFingerprint: null,
      }),
    );
    expect(s.snapshot.status === 'ready' && s.snapshot.data.upstreams[0]?.ok).toBe(false);
    s = reduceEnv(
      s,
      envEvent('env.tunnel', {
        state: 'up',
        host: 'x.trycloudflare.com',
        expiresAt: '2026-10-13T12:00:00.000Z',
      }),
    );
    expect(s.snapshot.status === 'ready' && s.snapshot.data.tunnel.state).toBe('up');
    s = reduceEnv(
      s,
      envEvent('env.fingerprint', {
        upstream: 'certify',
        fingerprint: 'v2',
        previous: 'v1',
        changed: true,
      }),
    );
    expect(s.snapshot.status === 'ready' && s.snapshot.data.upstreams[0]?.versionFingerprint).toBe(
      'v2',
    );
  });

  it('run:{runId} log appends in seq order and ignores repeats', () => {
    let slice = reduceRunLog(undefined, ev(1));
    slice = reduceRunLog(slice, ev(2));
    slice = reduceRunLog(slice, ev(2));
    expect(slice.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(slice.lastSeq).toBe(2);
  });

  it('keeps at most three toasts, dropping the oldest (UI-01)', () => {
    const s = createStore();
    for (const t of ['a', 'b', 'c', 'd']) pushToast({ text: t }, s);
    expect(s.get().toasts.map((t) => t.text)).toEqual(['b', 'c', 'd']);
    expect(s.get().toasts).toHaveLength(MAX_TOASTS);
  });
});
