/**
 * Stream module (plan/12 T-08; 02 §4, 04 §7, API-15, ADR-20).
 *
 *   const bus = new EventBus(); attachBus(store, bus);   // sink writes now publish after commit
 *   bus.subscribe('run:<id>', lastEventId)               // replay from the store, then live
 *
 * `publish(streamKey, event)` / `subscribe(streamKey, after?)` are also exported bound to a
 * process-wide default bus (the one `startServer` attaches to the store).
 */
import type { EventEnvelope } from '@interop-playground/api';
import { EventBus } from './bus.js';
import type { StreamKey, Subscription } from './bus.js';

export {
  EventBus,
  Subscription,
  TERMINAL_TYPES,
  runStreamKey,
  streamKeyOf,
  type EventBusOptions,
  type StreamKey,
  type StreamSource,
} from './bus.js';
export { attachBus } from './attach.js';
export { storeSource } from './sources.js';

export const defaultBus = new EventBus();

/** Publishes a committed event on the process-wide bus. */
export function publish(streamKey: StreamKey, event: EventEnvelope): void {
  defaultBus.publish(streamKey, event);
}

/** Subscribes to a stream on the process-wide bus, replaying stored events after `after` first. */
export function subscribe(streamKey: StreamKey, after?: number): Subscription {
  return defaultBus.subscribe(streamKey, after);
}
