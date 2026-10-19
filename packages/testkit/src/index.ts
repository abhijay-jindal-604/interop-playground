/** @interop-playground/testkit: fake upstreams, golden loaders, helpers (plan/11 §3). */
export { installNetworkGuard, NETWORK_DISABLED_MESSAGE, isLoopbackHost } from './network-guard.js';
export {
  REPO_ROOT,
  FIXTURES_DIR,
  GOLDEN_DIR,
  EVENTS_DIR,
  FLOWS_DIR,
  API_SCHEMA_PATH,
} from './paths.js';
export { readFlowFile, mergeFlow, resolvedSteps } from './flows.js';
export { EVENT_FIXTURE_IDS, type EventFixture, type EventFixtureId } from './events/types.js';
export { buildEventFixture, FIXTURE_RUN_IDS, FIXTURE_HOST } from './events/build.js';
export {
  readEventFixture,
  writeFixtureToStore,
  readWholeLog,
  foldRunLog,
  sseFrames,
  serialiseFixture,
  type FixtureSink,
  type FixtureReader,
  type RunFold,
} from './events/load.js';
export {
  startFakeSidecar,
  DEFAULT_PROOF_CALLBACK,
  type FakeSidecar,
  type FakeSidecarScript,
} from './fakes/sidecar.js';
export {
  runGolden,
  readManifest,
  BASE_GOLDEN_CHECKS,
  type GoldenCheck,
  type GoldenEntry,
  type GoldenManifest,
  type GoldenReport,
} from './golden/runner.js';
