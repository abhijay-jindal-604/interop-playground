import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope, EventPage } from '@interop-playground/api';
import { ApiError } from '../api/client.js';
import { FakeEventSource, ev } from '../test/fake-event-source.js';
import {
  CAUGHT_UP_MS,
  POLL_MS,
  RECONNECT_BANNER_MS,
  StreamClient,
  type StreamStatus,
} from './stream.js';

const RUN = '01J8ZZZZZZZZZZZZZZZZZZZZZZ';

function setup(
  opts: {
    pages?: EventPage[];
    reconcile?: () => Promise<boolean>;
    fetchPage?: (after: number) => Promise<EventPage>;
  } = {},
) {
  const seen: number[] = [];
  const states: StreamStatus['state'][] = [];
  const pages = [...(opts.pages ?? [])];
  const fetchPage = vi.fn(
    opts.fetchPage ??
      ((after: number) =>
        Promise.resolve(
          pages.shift() ?? { streamId: RUN, events: [], nextAfter: null, closed: false, after },
        )),
  );
  const client = new StreamClient({
    streamId: RUN,
    onEvent: (e: EventEnvelope) => seen.push(e.seq),
    onStatus: (s) => states.push(s.state),
    createSource: (url) => new FakeEventSource(url),
    fetchPage,
    ...(opts.reconcile ? { reconcile: opts.reconcile } : {}),
  });
  client.start();
  return { client, seen, states, fetchPage };
}

const page = (seqs: number[], closed: boolean, nextAfter: number | null = null): EventPage => ({
  streamId: RUN,
  events: seqs.map((s) => ev(s)),
  nextAfter,
  closed,
});

describe('ui.stream-client', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens /api/v1/streams/{id}/events and applies each seq once, in order (dedupe by seq)', () => {
    const { seen, client } = setup();
    const src = FakeEventSource.last;
    expect(src.url).toBe(`/api/v1/streams/${RUN}/events`);
    src.open();
    for (const s of [1, 2, 2, 1, 3, 3]) src.send(ev(s));
    expect(seen).toEqual([1, 2, 3]);
    expect(client.lastSeq).toBe(3);
    expect(client.current.state).toBe('live');
  });

  it('stops after stream.end: the source is closed, never reopened, later events ignored', async () => {
    const { seen, client, fetchPage } = setup();
    const src = FakeEventSource.last;
    src.open();
    src.send(ev(1));
    src.send(ev(2, 'run.completed'));
    src.end({ reason: 'terminal', lastSeq: 2 });
    await vi.runAllTimersAsync();
    expect(src.closed).toBe(true);
    expect(client.current.state).toBe('closed');
    expect(client.current.end).toEqual({ reason: 'terminal', lastSeq: 2 });
    // anything after the end is ignored and no new connection appears
    src.send(ev(3));
    src.error(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toEqual([1, 2]);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(client.lastSeq).toBe(2);
  });

  it('pages in events that stream.end promised but never arrived, then closes', async () => {
    const { seen, client, fetchPage } = setup({ pages: [page([3, 4], true)] });
    const src = FakeEventSource.last;
    src.open();
    src.send(ev(1));
    src.send(ev(2));
    src.end({ reason: 'terminal', lastSeq: 4 });
    await vi.runAllTimersAsync();
    expect(fetchPage).toHaveBeenCalledWith(2);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(client.current.state).toBe('closed');
  });

  it('a gap closes the source, pages ?format=json&after=lastSeq, then reopens with ?after=', async () => {
    const { seen, fetchPage } = setup({ pages: [page([3, 4], false, 4), page([5], false, null)] });
    const first = FakeEventSource.last;
    first.open();
    first.send(ev(1));
    first.send(ev(2));
    first.send(ev(6)); // gap: 3..5 missing
    await vi.runAllTimersAsync();
    expect(first.closed).toBe(true);
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([2, 4]);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    const second = FakeEventSource.last;
    expect(second).not.toBe(first);
    expect(second.url).toBe(`/api/v1/streams/${RUN}/events?after=5`);
    second.open();
    second.send(ev(5)); // replayed duplicate
    second.send(ev(6));
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a gap whose pages reach a closed page ends the stream without reopening', async () => {
    const { client } = setup({ pages: [page([2, 3], true)] });
    const src = FakeEventSource.last;
    src.open();
    src.send(ev(1));
    src.send(ev(5));
    await vi.runAllTimersAsync();
    expect(client.current.state).toBe('closed');
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('shows reconnecting after 2 s of CONNECTING, then caught-up for 3 s with a reconcile, then live', async () => {
    const reconcile = vi.fn(() => Promise.resolve(false));
    const { client, states } = setup({ reconcile });
    const src = FakeEventSource.last;
    src.open();
    src.send(ev(1));
    src.error(0);
    await vi.advanceTimersByTimeAsync(RECONNECT_BANNER_MS - 1);
    expect(client.current.state).toBe('live');
    await vi.advanceTimersByTimeAsync(1);
    expect(client.current.state).toBe('reconnecting');
    expect(client.current.attempt).toBe(1);
    src.error(0);
    expect(client.current.attempt).toBe(2);
    src.open();
    src.send(ev(2));
    expect(client.current.state).toBe('caught-up');
    await vi.advanceTimersByTimeAsync(CAUGHT_UP_MS);
    expect(client.current.state).toBe('live');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(states).toContain('reconnecting');
  });

  it('a short drop (under 2 s) shows no banner', async () => {
    const { client, states } = setup();
    const src = FakeEventSource.last;
    src.open();
    src.error(0);
    await vi.advanceTimersByTimeAsync(500);
    src.open();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(states).not.toContain('reconnecting');
    expect(client.current.state).toBe('live');
  });

  it('CLOSED without stream.end falls back to polling every 3 s, and retryLive reopens', async () => {
    const { client, fetchPage } = setup({
      pages: [page([2], false, null), page([3], false, null)],
    });
    const src = FakeEventSource.last;
    src.open();
    src.send(ev(1));
    src.error(2);
    expect(client.current.state).toBe('polling');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(client.lastSeq).toBe(3);
    client.retryLive();
    expect(FakeEventSource.last).not.toBe(src);
    expect(FakeEventSource.last.url).toContain('?after=3');
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('polling stops at the first closed page', async () => {
    const { client } = setup({ pages: [page([1, 2], true)] });
    FakeEventSource.last.error(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.current.state).toBe('closed');
  });

  it('a 410 gone while polling ends in the gone state', async () => {
    const gone = new ApiError({
      code: 'gone',
      message: 'pruned',
      status: 410,
      requestId: '01J8AAAAAAAAAAAAAAAAAAAAAA',
      retryable: false,
    });
    const { client } = setup({ fetchPage: () => Promise.reject(gone) });
    FakeEventSource.last.error(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.current.state).toBe('gone');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(client.current.state).toBe('gone');
  });

  it('reconcile: API-22 terminal without a terminal event pages until it arrives, then closes', async () => {
    const terminalPage: EventPage = {
      streamId: RUN,
      events: [ev(4, 'run.failed')],
      nextAfter: null,
      closed: true,
    };
    const { client, seen } = setup({
      reconcile: () => Promise.resolve(true),
      pages: [page([2, 3], false, 3), terminalPage],
    });
    const src = FakeEventSource.last;
    src.open();
    src.send(ev(1));
    src.error(0);
    await vi.advanceTimersByTimeAsync(RECONNECT_BANNER_MS);
    src.open(); // caught-up -> reconcile says terminal, the log has no terminal event yet
    await vi.runAllTimersAsync();
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(client.current.state).toBe('closed');
    expect(src.closed).toBe(true);
  });

  it('stop() closes the source and cancels timers', async () => {
    const { client } = setup();
    const src = FakeEventSource.last;
    src.error(0);
    client.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(src.closed).toBe(true);
    expect(client.current.state).toBe('connecting');
  });
});
