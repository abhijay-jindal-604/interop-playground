/**
 * Event stream client (06 UI-17, ADR-20, ADR-41; wire format 04 §7.1, API-15).
 *
 * - Native `EventSource`; the browser resends `Last-Event-ID` itself; `?after=` on our own reopen.
 * - Every event is applied exactly once in `seq` order: `seq <= lastSeq` is dropped,
 *   `seq = lastSeq + 1` applied, a gap closes the source and pages `?format=json&after=` until a
 *   `closed` page (or `nextAfter: null`), then reopens with `?after=lastSeq`.
 * - `stream.end` closes the source for good: no reconnect, `lastSeq` kept.
 * - `error` while CONNECTING for more than 2 s: `reconnecting (attempt n)`; the next `open` is
 *   `caught-up` (3 s) and reconciles with API-22. `error` with CLOSED and no `stream.end`: JSON
 *   polling every 3 s (+ API-22) until `retryLive()`. A 410 `gone` ends in `gone`.
 *
 * Dependencies are injected so the logic is tested with a fake EventSource and fixture pages.
 */
import { EVENT_TYPES } from '@interop-playground/api';
import type {
  EventEnvelope,
  EventPage,
  EventType,
  StreamEndFrame,
  StreamId,
} from '@interop-playground/api';
import { ApiError, API_BASE, apiGet } from '../api/client.js';

export type ConnectionState =
  'connecting' | 'live' | 'reconnecting' | 'caught-up' | 'closed' | 'polling' | 'gone';

export interface StreamStatus {
  state: ConnectionState;
  /** reconnect attempts since the last `open` */
  attempt: number;
  /** events applied between the drop and the `open` that ended it (the `caught-up` banner) */
  caughtUp: number;
  lastSeq: number;
  end: StreamEndFrame | null;
}

/** The part of `EventSource` the client uses (readyState 0 CONNECTING, 1 OPEN, 2 CLOSED). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: MessageEvent<string> | Event) => void): void;
  close(): void;
}

export interface StreamDeps {
  streamId: StreamId;
  onEvent: (event: EventEnvelope) => void;
  onStatus?: (status: StreamStatus) => void;
  createSource?: (url: string) => EventSourceLike;
  fetchPage?: (after: number) => Promise<EventPage>;
  /** API-22 reconcile; resolves `true` when the run is terminal on the server */
  reconcile?: () => Promise<boolean>;
  /** start after this seq (a page already loaded) */
  initialSeq?: number;
}

export const RECONNECT_BANNER_MS = 2_000;
export const CAUGHT_UP_MS = 3_000;
export const POLL_MS = 3_000;
export const PAGE_LIMIT = 1_000;
const TERMINAL: ReadonlySet<EventType> = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const CONNECTING = 0;
const CLOSED = 2;

/** URL of a stream's SSE endpoint, resuming after event `after`. */
export function streamUrl(streamId: StreamId, after: number): string {
  const base = `${API_BASE}/streams/${encodeURIComponent(streamId)}/events`;
  return after > 0 ? `${base}?after=${after}` : base;
}

/** Opens the browser's native EventSource. */
function defaultSource(url: string): EventSourceLike {
  return new EventSource(url);
}

/** Client for one event stream. It replays what the server stored, then tails live events over SSE, and reconnects from the last received sequence number so nothing is missed or doubled. */
export class StreamClient {
  private readonly deps: StreamDeps;
  private source: EventSourceLike | null = null;
  private status: StreamStatus;
  private sawTerminal = false;
  private stopped = false;
  private recovering = false;
  private appliedAtDrop = 0;
  private applied = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private caughtUpTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: StreamDeps) {
    this.deps = deps;
    this.status = {
      state: 'connecting',
      attempt: 0,
      caughtUp: 0,
      lastSeq: deps.initialSeq ?? 0,
      end: null,
    };
  }

  get lastSeq(): number {
    return this.status.lastSeq;
  }
  get current(): StreamStatus {
    return this.status;
  }

  /** Opens the stream. */
  start(): void {
    this.open();
  }

  /** Close everything (page unmount). Not the same as `stream.end`. */
  stop(): void {
    this.stopped = true;
    this.closeSource();
    this.clearTimers();
  }

  /** The "Try live updates again" button of the `polling` banner. */
  retryLive(): void {
    if (this.status.state !== 'polling') return;
    this.stopPolling();
    this.open();
  }

  // ---------- connection ----------
  private open(): void {
    if (this.stopped || this.isFinal()) return;
    const create = this.deps.createSource ?? defaultSource;
    const source = create(streamUrl(this.deps.streamId, this.status.lastSeq));
    this.source = source;
    source.addEventListener('open', () => {
      if (this.source === source) this.onOpen();
    });
    source.addEventListener('error', () => {
      if (this.source === source) this.onError(source);
    });
    source.addEventListener('stream.end', (e) => {
      if (this.source === source) void this.onEnd(e as MessageEvent<string>);
    });
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (e) => {
        if (this.source === source) this.onMessage(e as MessageEvent<string>);
      });
    }
  }

  /** Closes the SSE connection, if open. */
  private closeSource(): void {
    this.source?.close();
    this.source = null;
  }

  /** The connection opened: cancel pending reconnect timers and mark the stream live, or caught up after a drop. */
  private onOpen(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const wasDown = this.status.state === 'reconnecting';
    if (wasDown) {
      this.set({ state: 'caught-up', attempt: 0, caughtUp: this.applied - this.appliedAtDrop });
      this.caughtUpTimer = setTimeout(() => {
        if (this.status.state === 'caught-up') this.set({ state: 'live' });
      }, CAUGHT_UP_MS);
      void this.reconcile();
    } else {
      this.set({ state: 'live', attempt: 0 });
    }
  }

  /** The connection errored. While the browser is still retrying this shows "reconnecting"; once it gave up without an end frame, fall back to polling. */
  private onError(source: EventSourceLike): void {
    if (this.isFinal()) return;
    if (source.readyState === CLOSED) {
      this.closeSource();
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.startPolling();
      return;
    }
    if (source.readyState !== CONNECTING) return;
    const attempt = this.status.attempt + 1;
    if (this.status.state === 'reconnecting') {
      this.set({ attempt });
      return;
    }
    if (this.reconnectTimer === null) this.appliedAtDrop = this.applied;
    this.status = { ...this.status, attempt };
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.source?.readyState === CONNECTING && !this.isFinal()) {
        this.set({ state: 'reconnecting' });
      }
    }, RECONNECT_BANNER_MS);
  }

  /** Handles the server's `stream.end` frame: closes for good, first paging in any events the stream promised but we never received. */
  private async onEnd(e: MessageEvent<string>): Promise<void> {
    let end: StreamEndFrame = { reason: 'closed', lastSeq: this.status.lastSeq };
    try {
      end = JSON.parse(e.data) as StreamEndFrame;
    } catch {
      // a malformed control frame still ends the stream
    }
    this.closeSource();
    this.clearTimers();
    // Events the stream promised but we never saw (dropped frames): page them in once.
    if (end.lastSeq > this.status.lastSeq)
      await this.pageUntil(() => this.status.lastSeq >= end.lastSeq);
    this.set({ state: 'closed', end });
  }

  /** Applies one event. Duplicates (already seen sequence numbers) are dropped and a gap triggers recovery by paging, so each event is applied exactly once and in order. */
  private onMessage(e: MessageEvent<string>): void {
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(e.data) as EventEnvelope;
    } catch {
      return;
    }
    if (this.recovering) return;
    const result = this.apply(envelope);
    if (result === 'gap') void this.recoverGap();
  }

  // ---------- the feed rule ----------
  /** Apply one event under the `seq` rule; returns what happened to it. */
  private apply(event: EventEnvelope): 'applied' | 'dropped' | 'gap' {
    if (this.status.state === 'closed' || this.status.state === 'gone') return 'dropped';
    const { lastSeq } = this.status;
    if (event.seq <= lastSeq) return 'dropped';
    if (event.seq > lastSeq + 1) return 'gap';
    this.status = { ...this.status, lastSeq: event.seq };
    this.applied += 1;
    if (TERMINAL.has(event.type)) this.sawTerminal = true;
    this.deps.onEvent(event);
    return 'applied';
  }

  /** After a gap in sequence numbers, pages the missing events as JSON, then reopens the live stream. */
  private async recoverGap(): Promise<void> {
    this.recovering = true;
    this.closeSource();
    try {
      const closed = await this.pageUntil(() => false);
      if (closed) {
        this.set({ state: 'closed', end: { reason: 'terminal', lastSeq: this.status.lastSeq } });
        return;
      }
    } catch (err) {
      if (this.handleGone(err)) return;
      this.recovering = false;
      this.startPolling();
      return;
    }
    this.recovering = false;
    this.open();
  }

  /**
   * Page `?format=json&after=lastSeq` until a page is `closed`, `nextAfter` is null, or `until()`
   * holds. Resolves `true` when a `closed` page was seen.
   */
  private async pageUntil(until: () => boolean): Promise<boolean> {
    const fetchPage =
      this.deps.fetchPage ?? ((after: number) => defaultFetchPage(this.deps.streamId, after));
    for (;;) {
      const page = await fetchPage(this.status.lastSeq);
      for (const event of page.events) {
        if (this.apply(event) === 'gap') throw new Error('gap inside a JSON page');
      }
      if (page.closed) return true;
      if (page.nextAfter === null || until() || page.events.length === 0) return false;
    }
  }

  // ---------- polling fallback ----------
  private startPolling(): void {
    if (this.stopped || this.isFinal()) return;
    this.set({ state: 'polling' });
    void this.pollOnce();
    this.pollTimer = setInterval(() => void this.pollOnce(), POLL_MS);
  }

  /** Stops the JSON polling fallback. */
  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** One round of the polling fallback: fetches events after the last seen. */
  private async pollOnce(): Promise<void> {
    if (this.status.state !== 'polling') return;
    try {
      const closed = await this.pageUntil(() => false);
      if (closed) {
        this.stopPolling();
        this.set({ state: 'closed', end: { reason: 'terminal', lastSeq: this.status.lastSeq } });
        return;
      }
      await this.reconcile();
    } catch (err) {
      if (this.handleGone(err)) return;
      // network trouble: keep polling
    }
  }

  // ---------- reconcile (API-22) ----------
  private async reconcile(): Promise<void> {
    if (!this.deps.reconcile) return;
    let terminal: boolean;
    try {
      terminal = await this.deps.reconcile();
    } catch {
      return;
    }
    if (!terminal || this.sawTerminal) return;
    try {
      await this.pageUntil(() => this.sawTerminal);
    } catch (err) {
      if (this.handleGone(err)) return;
      return;
    }
    if (this.sawTerminal) {
      this.closeSource();
      this.stopPolling();
      this.set({ state: 'closed', end: { reason: 'terminal', lastSeq: this.status.lastSeq } });
    }
  }

  /** A 410 `gone` (the run's events were pruned) ends the stream for good; returns true when it did. */
  private handleGone(err: unknown): boolean {
    if (err instanceof ApiError && err.code === 'gone') {
      this.closeSource();
      this.clearTimers();
      this.set({ state: 'gone' });
      return true;
    }
    return false;
  }

  // ---------- helpers ----------
  private isFinal(): boolean {
    return this.status.state === 'closed' || this.status.state === 'gone';
  }

  /** Cancels the reconnect and polling timers. */
  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.caughtUpTimer) clearTimeout(this.caughtUpTimer);
    this.reconnectTimer = null;
    this.caughtUpTimer = null;
    this.stopPolling();
  }

  /** Updates the connection status and notifies the listener. */
  private set(patch: Partial<StreamStatus>): void {
    this.status = { ...this.status, ...patch };
    if (this.status.state === 'closed' || this.status.state === 'gone') this.clearTimers();
    this.deps.onStatus?.(this.status);
  }
}

/** Fetches one page of stored events as JSON, used for replay and as the fallback when SSE is unavailable. */
export function defaultFetchPage(streamId: StreamId, after: number): Promise<EventPage> {
  return apiGet<EventPage>(`/streams/${encodeURIComponent(streamId)}/events`, {
    format: 'json',
    after,
    limit: PAGE_LIMIT,
  });
}
