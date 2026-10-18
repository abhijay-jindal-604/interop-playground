/**
 * Every user-visible string of the shell, verbatim from 06 (UI-01, UI-02, UI-17, UI-29, UI-31,
 * UI-34, UI-77, UI-78). Tests assert against these constants (plan/11 DoD-SCREEN 1); screens never
 * write their own copy for the same state.
 */
import type { ErrorCode } from '@interop-playground/api';

export const APP_NAME = 'Interop Playground';
export const BFF_ORIGIN_TEXT = 'http://127.0.0.1:3100';

export const pageTitle = (screen?: string): string =>
  screen ? `${screen} · ${APP_NAME}` : APP_NAME;

export const copy = {
  skipLink: 'Skip to main content',
  nav: {
    label: 'Primary',
    menu: 'Menu',
    playground: 'Playground',
    history: 'History',
    matrix: 'Matrix',
    tamper: 'Tamper',
    drafts: 'Issue drafts',
    environment: 'Environment',
  },
  footer: {
    local: `${APP_NAME} runs only on this machine.`,
    shortcuts: 'Keyboard shortcuts',
  },
  theme: { label: 'Theme', light: 'Light', dark: 'Dark', system: 'System' },
  notFound: {
    heading: 'Page not found',
    body: (path: string) => `There is nothing at ${path}.`,
    action: 'Back to the playground',
  },
  boot: {
    loading: 'Starting…',
    unreachableHeading: 'The playground backend is not reachable.',
    unreachableBody: (origin: string) =>
      `Nothing answered at ${origin}. Start the bundle with scripts/up.sh, then reload this page.`,
    reload: 'Reload',
    guardHeading: 'This page was opened from the wrong address.',
    guardBody: `Open the playground at ${BFF_ORIGIN_TEXT}. The backend refuses other hosts and origins.`,
  },
  env: {
    modeLocal: 'Full local',
    modeCollab: 'Collab',
    ready: 'Ready',
    degraded: 'Degraded',
    offline: 'Offline',
    tunnelDown: 'Tunnel down',
    tunnelUpUntil: (hhmm: string) => `Tunnel up until ${hhmm}`,
    collabBudget: (used: number) => `Collab ${used}/20 per min`,
    degradedBanner: (list: string) =>
      `Some services are not ready: ${list}. Runs that need them cannot start.`,
    probeAgain: 'Probe again',
    probeNow: 'Probe now',
    probing: 'Probing…',
    dismiss: 'Dismiss',
    openPage: 'Open environment page',
    recovered: 'All services are ready.',
    fingerprintChanged: (upstream: string, previous: string, fp: string) =>
      `${upstream} changed its version: ${previous} → ${fp}. Re-runs that depend on the old version are disabled.`,
    tunnelUpToast: (host: string, hhmm: string) => `Tunnel is up at ${host}. It closes at ${hhmm}.`,
    tunnelClosedToast: 'Tunnel closed.',
    rateLimited: (s: number) => `Probing is limited to once every 5 seconds. Try again in ${s} s.`,
    tunnelCardDown:
      'The tunnel is down. The phone wallet and Collab checks of JSON-LD credentials need it. You start it yourself with scripts/tunnel.sh in a terminal; the playground never opens one.',
    tunnelCardUp: (host: string, since: string, until: string) =>
      `The tunnel is up at ${host} since ${since} and closes at ${until}. Close it by stopping scripts/tunnel.sh.`,
    collabNote: 'Collab calls are sequential and capped at 20 per minute.',
    unattributedEmpty: 'No traffic outside a run in the last 24 hours.',
    unattributedNote:
      "Requests that reached the playground's gateway but could not be matched to a run. Denied requests show the rule that blocked them.",
  },
  offline: {
    banner: `The playground backend is not reachable. Check that it is running at ${BFF_ORIGIN_TEXT}.`,
    tooltip: 'Offline',
  },
  tryAgain: 'Try again',
  details: 'Details',
  reference: (id: string) => `Reference ${id}`,
  networkFailure: `The playground could not be reached. Check that it is running at ${BFF_ORIGIN_TEXT}.`,
  catalogEmpty:
    'No components were found. The playground could not load its catalogue. Check the Environment page.',
  runs: {
    button: 'Recent runs',
    heading: 'Recent runs',
    close: 'Close',
    empty: 'No runs yet. Pick an issuer, a wallet and a verifier to start.',
    emptyAction: 'Back to the playground',
    error: 'Recent runs could not be loaded.',
    seeAll: 'See all runs',
    running: (n: number) => `${n} running`,
    waiting: 'Waiting for you',
    rerunOf: (parent: string) => `re-run of ${parent}`,
    finishedToast: (shortId: string, word: string) => `Run ${shortId} finished: ${word}.`,
    waitingToast: (shortId: string) => `Run ${shortId} is waiting for you.`,
    view: 'View',
  },
  stream: {
    live: 'Live',
    reconnecting: (n: number) => `Connection to the playground lost. Reconnecting… (attempt ${n})`,
    caughtUp: (n: number) => `Reconnected. Caught up ${n} events.`,
    polling: 'Live updates stopped. Checking every 3 seconds.',
    retryLive: 'Try live updates again',
    gone: "This run's event log was removed by retention. Its summary is still available.",
    pausedAnnounce: 'Live updates are paused.',
    backAnnounce: 'Live updates are back.',
  },
  shortcuts: {
    heading: 'Keyboard shortcuts',
    close: 'Close',
    footer: `${APP_NAME} runs only on this machine.`,
  },
  copied: 'Copied.',
} as const;

/** UI-31: one fixed sentence per 04 §6.2 code; `{x}` is filled from `details`. */
export const ERROR_COPY: Record<ErrorCode, string> = {
  validation_failed: 'Some values are not valid: {issues}. Fix them and try again.',
  request_guard_failed: `The playground refused this request because it did not come from its own page. Open the playground at ${BFF_ORIGIN_TEXT} and try again.`,
  unauthorized: 'Not authorised.',
  not_found: 'That item was not found. It may have been deleted.',
  conflict: 'That conflicts with the current state: {reason}. Reload and try again.',
  payload_too_large: 'That request is too large.',
  unsupported_media_type:
    'The playground could not read that request. Reload the page and try again.',
  gone: "This was removed by retention. The run's summary is still available.",
  idempotency_conflict:
    'This request was already sent with different values. Reload the page and start again.',
  incompatible_selection: 'This combination cannot run: {reason} ({gapId}).',
  knob_invalid:
    'That option or value is not available for the chosen components: {knobId}. Allowed values: {allowed}.',
  knob_not_applicable: 'The option {knobId} does not apply to this selection: {reason}.',
  tamper_not_applicable: 'This tamper case does not apply to the selection: {reason}.',
  tunnel_required:
    'This selection needs the public tunnel and it is not up. Start scripts/tunnel.sh, then try again.',
  adapter_unavailable: '{adapter} is not available: {reason}. Check the Environment page.',
  env_not_ready:
    'A service this run needs is not ready: {upstreams}. Check the Environment page, then try again.',
  queue_full:
    'The run queue is full ({queued} waiting). Wait for a run to finish or cancel one, then try again.',
  rate_limited: 'Too many requests to {scope}. Try again in {retryAfterS} seconds.',
  run_not_cancellable: 'The run has already finished.',
  run_not_terminal: 'That is available when the run ends.',
  run_in_use: 'This run is used by other records.',
  key_unavailable: 'Imported runs cannot be re-run with a fix: their holder key is not included.',
  parent_not_failed:
    'Only a run that failed can be re-run with a fix. This run ended as {outcome}.',
  tamper_run_not_derivable: 'Tamper runs are not re-run with a fix.',
  derive_not_one_knob: 'A fix changes exactly one option. This change did not.',
  fix_not_offered:
    "That change was not offered for this run's diagnosis, so the playground will not run it.",
  knob_reverted:
    '{knobId} was already changed earlier in this re-run chain (run {ancestorRunId}). Changing it back would not prove anything new.',
  version_drift:
    'The {column} version changed since this run ({was} to {now}), so a re-run would not be a fair comparison. Run the original combination again first.',
  environment_changed:
    'The tunnel changed since this run ({was} to {now}). Restore it or run the original combination again.',
  observation_not_expected: 'The playground is not waiting for that any more.',
  compare_not_comparable: 'These runs cannot be compared.',
  draft_not_editable: 'This draft can no longer be edited.',
  proxy_path_denied:
    'The Verify SDK asked for something the playground does not allow ({method} {path}).',
  proxy_run_not_active:
    'This run is not accepting SDK requests. It must be running and driven from this page.',
  upstream_unreachable:
    'Inji Verify could not be reached ({upstream}). Check the Environment page.',
  gateway_denied: "The playground's gateway refused a request on port {port} (rule {rule}).",
  sidecar_unavailable:
    'The Inji library sidecar could not be reached. Check that the sidecar container is running.',
  engine_exception: 'A library threw an exception: {exceptionClass}: {message}.',
  callback_not_pending: 'That callback is no longer pending.',
  internal_error:
    'The playground hit an unexpected error. Run it again; if it repeats, export the run and report it.',
};

function show(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'not given';
  if (Array.isArray(value)) return value.map(show).join(', ');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value) ?? 'not given';
}

/** Fill a template from `details`; `{issues}` lists the first three as `path: message`. */
export function fill(template: string, details: Record<string, unknown> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = details[key];
    if (key === 'issues' && Array.isArray(value)) {
      return value
        .slice(0, 3)
        .map((i: { path?: unknown; message?: unknown }) => `${show(i.path)}: ${show(i.message)}`)
        .join('; ');
    }
    if (key === 'was' || key === 'now') return value === null ? 'down' : show(value);
    return show(value);
  });
}

/** Copy for a code; unknown codes fall back to `internal_error` (UI-31). */
export function errorText(code: string, details?: Record<string, unknown>): string {
  const template = (ERROR_COPY as Record<string, string>)[code] ?? ERROR_COPY.internal_error;
  return fill(template, details);
}

/** UI-74 words (lower case in badges) and the run-state words of 06 §1. */
export const STATE_WORDS = {
  pass: 'pass',
  fail: 'fail',
  blocked: 'blocked',
  lenient: 'lenient',
  inconclusive: 'inconclusive',
  'no-submission': 'no submission',
  'n/a': 'n/a',
  'not-run': 'not run',
  queued: 'queued',
  running: 'running',
  cancelled: 'cancelled',
  failed: 'error',
} as const;

export const STATE_MEANINGS: Partial<Record<keyof typeof STATE_WORDS, string>> = {
  pass: 'Every check passed.',
  fail: 'A check failed. The software under test did not meet the expectation.',
  blocked: 'The flow stopped before the checks could run.',
  lenient: 'The software accepted input a strict reader would reject. Counted as conformant.',
  inconclusive: 'The playground could not tell. Not a verdict on the software.',
  'no-submission': 'The wallet or verifier never sent the expected message.',
  'n/a': 'This combination cannot work by design. The reason is shown.',
  'not-run': 'No run exists for this combination yet.',
};
