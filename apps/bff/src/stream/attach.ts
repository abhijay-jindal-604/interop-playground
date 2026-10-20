/**
 * Wires one store's EventSink to the bus (02 §4.1 "persisted before published"): every sink write
 * that returns an envelope is published only after its transaction returned (= committed). Writers
 * keep calling the sink (CaptureHttp, orchestrator, gateway), so nothing can publish an event the
 * store does not hold. Idempotent per (store, bus).
 */
import type { EventEnvelope } from '@interop-playground/api';
import type { Store } from '../store/index.js';
import type { EventBus } from './bus.js';
import { runStreamKey } from './bus.js';
import { readUnattributedRow, storeSource, unattributedEvents } from './sources.js';

const ATTACHED = Symbol.for('interop-playground.bus-attached');

type Marked = { [ATTACHED]?: EventBus };

/** Wires the sink to the bus so every committed event is published; attaching a second, different bus is an error. */
export function attachBus(store: Store, bus: EventBus): void {
  const sink = store.sink as typeof store.sink & Marked;
  if (sink[ATTACHED] === bus) return;
  if (sink[ATTACHED] !== undefined)
    throw new Error('store sink is already attached to another bus');
  sink[ATTACHED] = bus;
  bus.setSource(storeSource(store));
  // the store's own driver must not be inside an outer transaction when we publish
  const committed = (ev: EventEnvelope | null): EventEnvelope | null => {
    if (ev === null) return null;
    if (ev.runId === 'env') bus.publish('env', ev);
    else bus.publish(runStreamKey(ev.runId), ev);
    return ev;
  };

  const createRun = sink.createRun.bind(sink);
  sink.createRun = (n) => {
    const ev = createRun(n);
    committed(ev);
    return ev;
  };
  const append = sink.append.bind(sink);
  sink.append = (runId, ev) => committed(append(runId, ev));
  const appendEnv = sink.appendEnv.bind(sink);
  sink.appendEnv = (type, payload) => {
    const ev = appendEnv(type, payload);
    committed(ev);
    return ev;
  };
  const appendUnattributed = sink.appendUnattributed.bind(sink);
  sink.appendUnattributed = (x) => {
    const id = appendUnattributed(x);
    const row = readUnattributedRow(store, id);
    if (row) for (const ev of unattributedEvents(store, row)) bus.publish('unattributed', ev);
    return id;
  };
}
