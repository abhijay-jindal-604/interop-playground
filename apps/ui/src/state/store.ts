/**
 * The one shared store (06 §1 data layer) with the slices `catalog` (API-01, 02, 04, 07, 08, 09,
 * cached for the session), `env` (API-10 + the `env` stream) and `run:{runId}` (the run's event log,
 * fed by the stream client; the run view reduces it, ADR-41). Plus shell-only state: boot, toasts.
 * Reducers are pure; React reads slices through `useStore(selector)`.
 */
import { useSyncExternalStore } from 'react';
import type {
  AdapterListResponse,
  EnvSnapshot,
  EventEnvelope,
  Health,
} from '@interop-playground/api';
import type { StreamStatus } from './stream.js';

export type Load<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown };

export interface CatalogSlice {
  health: Load<Health>;
  adapters: Load<AdapterListResponse>;
  knobs: Load<unknown>;
  presets: Load<unknown>;
  incompatibilities: Load<unknown>;
  configurations: Load<unknown>;
}

export interface EnvSlice {
  snapshot: Load<EnvSnapshot>;
  /** upstreams named by the last `env.degraded`, with reasons; null when ready */
  degraded: { upstreams: string[]; reasons: Record<string, string> } | null;
  degradedDismissed: boolean;
  stream: StreamStatus | null;
  /** the env stream has been reconnecting for more than 10 s (EnvChip "Offline", UI-02) */
  offline: boolean;
}

export interface RunSlice {
  events: EventEnvelope[];
  lastSeq: number;
  stream: StreamStatus | null;
}

export type BootState = 'loading' | 'ready' | 'unreachable' | 'guard';

export interface ToastItem {
  id: number;
  text: string;
  action?: { label: string; href: string };
  /** stays until dismissed (fingerprint change, UI-02) */
  sticky?: boolean;
}

export interface AppState {
  boot: BootState;
  /** the BFF stopped answering after boot (UI-34 offline banner) */
  backendDown: boolean;
  catalog: CatalogSlice;
  env: EnvSlice;
  runs: Record<string, RunSlice>;
  toasts: ToastItem[];
}

const idle = { status: 'idle' } as const;

/** The state of the app store before anything has loaded. */
export function initialState(): AppState {
  return {
    boot: 'loading',
    backendDown: false,
    catalog: {
      health: idle,
      adapters: idle,
      knobs: idle,
      presets: idle,
      incompatibilities: idle,
      configurations: idle,
    },
    env: { snapshot: idle, degraded: null, degradedDismissed: false, stream: null, offline: false },
    runs: {},
    toasts: [],
  };
}

// ---------- pure reducers ----------
/** Apply one `env` stream event to the env slice (UI-02). */
export function reduceEnv(slice: EnvSlice, event: EventEnvelope): EnvSlice {
  const snap = slice.snapshot.status === 'ready' ? slice.snapshot.data : null;
  const withSnap = (next: EnvSnapshot): EnvSlice => ({
    ...slice,
    snapshot: { status: 'ready', data: next },
  });
  switch (event.type) {
    case 'env.probe': {
      if (!snap) return slice;
      const p = (event as EventEnvelope<'env.probe'>).payload;
      const row = { ...p, checkedAt: event.ts };
      const exists = snap.upstreams.some((u) => u.upstream === p.upstream);
      const upstreams = exists
        ? snap.upstreams.map((u) => (u.upstream === p.upstream ? row : u))
        : [...snap.upstreams, row];
      return withSnap({ ...snap, upstreams });
    }
    case 'env.ready': {
      const next = snap ? withSnap({ ...snap, ready: true }) : slice;
      return { ...next, degraded: null, degradedDismissed: false };
    }
    case 'env.degraded': {
      const p = (event as EventEnvelope<'env.degraded'>).payload;
      const next = snap ? withSnap({ ...snap, ready: false }) : slice;
      return {
        ...next,
        degraded: { upstreams: p.upstreams, reasons: p.reasons },
        degradedDismissed: false,
      };
    }
    case 'env.tunnel': {
      if (!snap) return slice;
      const p = (event as EventEnvelope<'env.tunnel'>).payload;
      const tunnel: EnvSnapshot['tunnel'] =
        p.state === 'up'
          ? { state: 'up', host: p.host, since: event.ts, expiresAt: p.expiresAt }
          : { state: 'down' };
      return withSnap({ ...snap, tunnel });
    }
    case 'env.fingerprint': {
      if (!snap) return slice;
      const p = (event as EventEnvelope<'env.fingerprint'>).payload;
      const upstreams = snap.upstreams.map((u) =>
        u.upstream === p.upstream ? { ...u, versionFingerprint: p.fingerprint } : u,
      );
      return withSnap({ ...snap, upstreams });
    }
    default:
      return slice;
  }
}

/** Append one run-stream event (already deduped by the stream client) to `run:{runId}`. */
export function reduceRunLog(slice: RunSlice | undefined, event: EventEnvelope): RunSlice {
  const base = slice ?? { events: [], lastSeq: 0, stream: null };
  if (event.seq <= base.lastSeq) return base;
  return { ...base, events: [...base.events, event], lastSeq: event.seq };
}

// ---------- store ----------
type Listener = () => void;

export interface Store {
  get: () => AppState;
  set: (update: (s: AppState) => AppState) => void;
  subscribe: (listener: Listener) => () => void;
}

/** A minimal external store (get, set, subscribe) for `useSyncExternalStore`; tests create their own. */
export function createStore(state: AppState = initialState()): Store {
  let current = state;
  const listeners = new Set<Listener>();
  return {
    get: () => current,
    set(update) {
      const next = update(current);
      if (next === current) return;
      current = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const store = createStore();

/** Reads a selected part of the store and re-renders only when that part changes. */
export function useStore<T>(selector: (s: AppState) => T, from: Store = store): T {
  return useSyncExternalStore(
    from.subscribe,
    () => selector(from.get()),
    () => selector(from.get()),
  );
}

// ---------- toasts (UI-01, UI-50: at most 3 visible, older ones dropped) ----------
let toastId = 0;
export const MAX_TOASTS = 3;

/** Shows a toast; keeps only the most recent few. Returns its id. */
export function pushToast(toast: Omit<ToastItem, 'id'>, into: Store = store): number {
  toastId += 1;
  const id = toastId;
  into.set((s) => ({ ...s, toasts: [...s.toasts, { ...toast, id }].slice(-MAX_TOASTS) }));
  return id;
}

/** Removes a toast by id. */
export function dismissToast(id: number, into: Store = store): void {
  into.set((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
}
