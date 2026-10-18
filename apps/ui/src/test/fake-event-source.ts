/** A scriptable EventSource for stream-client tests (06 UI-17; wire format 04 §7.1). */
import type { EventEnvelope, EventType, StreamEndFrame } from '@interop-playground/api';
import type { EventSourceLike } from '../state/stream.js';

type Listener = (event: MessageEvent<string> | Event) => void;

export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  readonly url: string;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  static reset(): void {
    FakeEventSource.instances = [];
  }
  static get last(): FakeEventSource {
    const s = FakeEventSource.instances.at(-1);
    if (!s) throw new Error('no EventSource was created');
    return s;
  }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2;
    this.closed = true;
  }
  private fire(type: string, event: MessageEvent<string> | Event): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  open(): void {
    this.readyState = 1;
    this.fire('open', new Event('open'));
  }
  /** `error` with the given readyState (0 CONNECTING = the browser retries, 2 CLOSED = gave up) */
  error(readyState: 0 | 2): void {
    this.readyState = readyState;
    this.fire('error', new Event('error'));
  }
  send(event: EventEnvelope): void {
    this.fire(event.type, new MessageEvent(event.type, { data: JSON.stringify(event) }));
  }
  end(frame: StreamEndFrame): void {
    this.fire('stream.end', new MessageEvent('stream.end', { data: JSON.stringify(frame) }));
  }
}

export function ev(
  seq: number,
  type: EventType = 'step.started',
  runId = '01J8ZZZZZZZZZZZZZZZZZZZZZZ',
): EventEnvelope {
  return {
    v: 1,
    runId,
    seq,
    ts: new Date(Date.UTC(2026, 9, 13, 10, 0, seq)).toISOString(),
    type,
    payload: {} as EventEnvelope['payload'],
  };
}
