/**
 * In-process event bus (02 §4.3, 04 §7, ADR-20). Stream keys: `run:<runId>`, `env`, `unattributed`.
 *
 * `publish` is called by the sink path only after the event is committed (attach.ts), so a
 * subscriber that replays from the store and then tails the bus sees every `seq` exactly once:
 * `subscribe` registers its live listener BEFORE it reads the store, buffers live events while it
 * replays, and drops every event whose `seq` it has already yielded.
 */
import type { EventEnvelope } from '@interop-playground/api';

export type StreamKey = `run:${string}` | 'env' | 'unattributed';

/** reads persisted events of one stream with `seq > after`, ascending, at most `limit` */
export type StreamSource = (key: StreamKey, after: number, limit: number) => EventEnvelope[];

export const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

/** Stream key of one run's event stream. */
export function runStreamKey(runId: string): StreamKey {
  return `run:${runId}`;
}

/** `run:<id>` for a run id, `env` / `unattributed` as is (04 §7.4 stream ids) */
export function streamKeyOf(streamId: string): StreamKey {
  return streamId === 'env' || streamId === 'unattributed' ? streamId : runStreamKey(streamId);
}

type Listener = (ev: EventEnvelope) => void;

/** One subscriber: an async iterator over the replayed then live events, deduplicated by `seq`. */
export class Subscription implements AsyncIterableIterator<EventEnvelope> {
  private readonly buffer: EventEnvelope[] = [];
  private waiter: ((r: IteratorResult<EventEnvelope>) => void) | null = null;
  private closed = false;
  private lastSeq: number;

  constructor(
    after: number,
    private readonly detach: () => void,
  ) {
    this.lastSeq = after;
  }

  /** highest `seq` handed out so far (or the `after` it started from) */
  get position(): number {
    return this.lastSeq;
  }

  /** @internal called by the bus (live) and by the replay */
  push(ev: EventEnvelope): void {
    if (this.closed || ev.seq <= this.lastSeq) return;
    if (this.waiter && this.buffer.length === 0) {
      this.lastSeq = ev.seq;
      const w = this.waiter;
      this.waiter = null;
      w({ value: ev, done: false });
      return;
    }
    this.buffer.push(ev);
  }

  next(): Promise<IteratorResult<EventEnvelope>> {
    while (this.buffer.length > 0) {
      const ev = this.buffer.shift() as EventEnvelope;
      if (ev.seq <= this.lastSeq) continue;
      this.lastSeq = ev.seq;
      return Promise.resolve({ value: ev, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  return(): Promise<IteratorResult<EventEnvelope>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.length = 0;
    this.detach();
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<EventEnvelope> {
    return this;
  }
}

export interface EventBusOptions {
  /** persisted events; without one, `subscribe` only tails live events */
  source?: StreamSource;
  /** replay page size */
  pageSize?: number;
}

/**
 * Fan-out of committed events to live subscribers, keyed by stream. Nothing is stored here: the
 * store is the source of truth and the bus only carries what was already committed.
 */
export class EventBus {
  private readonly listeners = new Map<StreamKey, Set<Listener>>();
  private source: StreamSource | null;
  private readonly pageSize: number;

  constructor(opts: EventBusOptions = {}) {
    this.source = opts.source ?? null;
    this.pageSize = opts.pageSize ?? 500;
  }

  setSource(source: StreamSource): void {
    this.source = source;
  }

  /** delivers an already persisted event to the live subscribers of `key` */
  publish(key: StreamKey, ev: EventEnvelope): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const l of [...set]) l(ev);
  }

  /** number of live subscribers (tests, shutdown) */
  subscriberCount(key?: StreamKey): number {
    if (key) return this.listeners.get(key)?.size ?? 0;
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }

  /**
   * Events of `key` with `seq > after`: first the persisted ones (store replay), then live ones,
   * each `seq` once. `after` = `Last-Event-ID` / `?after=`; 0 = history replay from the start.
   */
  subscribe(key: StreamKey, after = 0): Subscription {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    const listeners = set;
    const pending: EventEnvelope[] = [];
    let replaying = true;
    const sub = new Subscription(after, () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    });
    const listener: Listener = (ev) => {
      if (replaying) pending.push(ev);
      else sub.push(ev);
    };
    listeners.add(listener);
    if (this.source) {
      let from = after;
      for (;;) {
        const page = this.source(key, from, this.pageSize);
        for (const ev of page) sub.push(ev);
        if (page.length < this.pageSize) break;
        from = (page[page.length - 1] as EventEnvelope).seq;
      }
    }
    replaying = false;
    for (const ev of pending) sub.push(ev);
    return sub;
  }
}
