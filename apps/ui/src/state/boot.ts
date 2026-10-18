/**
 * Boot sequence and the shell's `env` stream (06 UI-02, UI-17 `env` stream):
 * (1) the shell renders a skeleton, (2) API-01, 02, 10, 04, 07, 09 in parallel, (3) open the `env`
 * stream, (4) render the route. API-08 and API-06 are fetched lazily by the screens that need them.
 */
import type {
  AdapterListResponse,
  EnvSnapshot,
  EventEnvelope,
  Health,
} from '@interop-playground/api';
import { ApiError, NetworkError, apiGet } from '../api/client.js';
import { copy } from '../copy.js';
import { hhmm } from '../lib/format.js';
import { announce } from '../lib/announce.js';
import { pushToast, reduceEnv, type AppState, type Load, type Store } from './store.js';
import { StreamClient, type StreamDeps, type StreamStatus } from './stream.js';

export const OFFLINE_AFTER_MS = 10_000;

function settle<T>(r: PromiseSettledResult<T>): Load<T> {
  return r.status === 'fulfilled'
    ? { status: 'ready', data: r.value }
    : { status: 'error', error: r.reason };
}

export async function loadEnv(s: Store): Promise<void> {
  try {
    const data = await apiGet<EnvSnapshot>('/env');
    s.set((st) => ({ ...st, env: { ...st.env, snapshot: { status: 'ready', data } } }));
  } catch (error) {
    s.set((st) => ({ ...st, env: { ...st.env, snapshot: { status: 'error', error } } }));
  }
}

export async function boot(s: Store): Promise<AppState['boot']> {
  const loading = { status: 'loading' } as const;
  s.set((st) => ({
    ...st,
    boot: 'loading',
    catalog: {
      ...st.catalog,
      health: loading,
      adapters: loading,
      knobs: loading,
      presets: loading,
      incompatibilities: loading,
    },
    env: { ...st.env, snapshot: loading },
  }));
  const [health, adapters, env, knobs, presets, incompatibilities] = await Promise.allSettled([
    apiGet<Health>('/health'),
    apiGet<AdapterListResponse>('/adapters'),
    apiGet<EnvSnapshot>('/env'),
    apiGet<unknown>('/knobs'),
    apiGet<unknown>('/presets'),
    apiGet<unknown>('/incompatibilities'),
  ]);
  let state: AppState['boot'] = 'ready';
  if (health.status === 'rejected') {
    const e: unknown = health.reason;
    if (e instanceof ApiError && e.code === 'request_guard_failed') state = 'guard';
    else if (e instanceof NetworkError) state = 'unreachable';
  }
  s.set((st) => ({
    ...st,
    boot: state,
    catalog: {
      ...st.catalog,
      health: settle(health),
      adapters: settle(adapters),
      knobs: settle(knobs),
      presets: settle(presets),
      incompatibilities: settle(incompatibilities),
    },
    env: { ...st.env, snapshot: settle(env) },
  }));
  return state;
}

/** Side effects of `env` events that the reducer cannot express: toasts (UI-02). */
export function envSideEffects(prev: AppState, event: EventEnvelope, s: Store): void {
  switch (event.type) {
    case 'env.ready':
      if (prev.env.degraded) pushToast({ text: copy.env.recovered }, s);
      break;
    case 'env.fingerprint': {
      const p = (event as EventEnvelope<'env.fingerprint'>).payload;
      if (p.changed) {
        pushToast(
          {
            text: copy.env.fingerprintChanged(p.upstream, p.previous ?? 'unknown', p.fingerprint),
            sticky: true,
          },
          s,
        );
      }
      break;
    }
    case 'env.tunnel': {
      const p = (event as EventEnvelope<'env.tunnel'>).payload;
      pushToast(
        {
          text:
            p.state === 'up'
              ? copy.env.tunnelUpToast(p.host, hhmm(p.expiresAt))
              : copy.env.tunnelClosedToast,
        },
        s,
      );
      break;
    }
    default:
      break;
  }
}

/** Open the shell's one `env` stream; returns a stop function. */
export function openEnvStream(s: Store, overrides: Partial<StreamDeps> = {}): () => void {
  let offlineTimer: ReturnType<typeof setTimeout> | null = null;
  let wasDown = false;
  const onStatus = (status: StreamStatus) => {
    s.set((st) => ({ ...st, env: { ...st.env, stream: status } }));
    const down = status.state === 'reconnecting' || status.state === 'polling';
    if (down && !offlineTimer) {
      if (!wasDown) announce(copy.stream.pausedAnnounce);
      wasDown = true;
      offlineTimer = setTimeout(() => {
        s.set((st) => ({ ...st, env: { ...st.env, offline: true } }));
      }, OFFLINE_AFTER_MS);
    }
    if (!down && (status.state === 'live' || status.state === 'caught-up')) {
      if (offlineTimer) clearTimeout(offlineTimer);
      offlineTimer = null;
      if (wasDown) {
        wasDown = false;
        announce(copy.stream.backAnnounce);
        s.set((st) => ({ ...st, env: { ...st.env, offline: false } }));
        void loadEnv(s); // UI-17: on reopen the shell refetches API-10 once
      }
    }
  };
  const client = new StreamClient({
    streamId: 'env',
    onEvent: (event) => {
      const prev = s.get();
      s.set((st) => ({ ...st, env: reduceEnv(st.env, event) }));
      envSideEffects(prev, event, s);
    },
    onStatus,
    ...overrides,
  });
  client.start();
  return () => {
    if (offlineTimer) clearTimeout(offlineTimer);
    client.stop();
  };
}
