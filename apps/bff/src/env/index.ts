/** Environment manager (T-12): probe loop, availability, fingerprints, tunnel (02 §1.1 C8). */
export { EnvManager, PROBE_RATE_LIMIT_MS } from './manager.js';
export type { EnvEventSink, EnvManagerOptions, EnvTimers } from './manager.js';
export { ADAPTER_UPSTREAMS, UPSTREAMS, inProcessFingerprint } from './upstreams.js';
export type { UpstreamDef, UpstreamProfile } from './upstreams.js';
