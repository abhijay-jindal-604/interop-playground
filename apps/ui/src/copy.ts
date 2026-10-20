/**
 * Every user-visible string of the shell, verbatim from 06 (UI-01, UI-02, UI-17, UI-29, UI-31,
 * UI-34, UI-77, UI-78). Tests assert against these constants (plan/11 DoD-SCREEN 1); screens never
 * write their own copy for the same state.
 */
import type { ErrorCode } from '@interop-playground/api';

export const APP_NAME = 'Interop Playground';
export const BFF_ORIGIN_TEXT = 'http://127.0.0.1:3100';

/** Browser tab title for a screen: "<screen> · <app name>", or the app name alone. */
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
    eyebrow: 'Bundle health',
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

/** Run screen copy, verbatim from 06 UI-09, UI-10, UI-11, UI-13, UI-14, UI-15 (headings). */
export const runCopy = {
  title: (shortId: string) => `Run ${shortId}`,
  notFound: {
    heading: 'This run does not exist.',
    body: (shortId: string) => `It may have been deleted. Run ${shortId} was not found.`,
    action: 'Back to the playground',
  },
  loading: 'Loading…',
  stateChip: {
    queued: 'Queued',
    running: 'Running',
    awaiting: 'Waiting for you',
    completed: 'Finished',
    cancelled: 'Cancelled',
    failed: 'Error',
  },
  verdictChip: {
    pass: 'Pass',
    fail: 'Fail',
    blocked: 'Blocked',
    lenient: 'Lenient',
    inconclusive: 'Inconclusive',
    'no-submission': 'No submission',
  },
  facts: {
    issuer: 'Issuer',
    wallet: 'Wallet',
    verifier: 'Verifier',
    format: 'Format',
    grant: 'Grant',
    mode: 'Mode',
    env: 'Environment',
    versions: 'Versions',
    proof: (alg: string) => `Proof: ${alg}`,
    changed: (knob: string, value: string) => `Changed: ${knob} = ${value}`,
    rerunOf: (parent: string) => `Re-run of ${parent}`,
    imported: 'Imported',
    importedTip: 'Imported runs cannot be re-run with a fix: their holder key is not included.',
  },
  actions: {
    cancel: 'Cancel',
    runAgain: 'Run again',
    pin: 'Pin',
    unpin: 'Unpin',
    pinTip: 'Pinned runs are never removed by automatic cleanup.',
    note: 'Note',
    export: 'Export',
    delete: 'Delete',
    report: 'Report',
    whenEnded: 'Available when the run ends',
  },
  banner: {
    queued: (reason: string) =>
      `Queued. ${reason} You can leave this page; the run starts by itself.`,
    queuedCollab: 'Only one run at a time can use the Collab sandbox.',
    queuedLocal: 'At most 4 runs execute at once.',
    running: (n: number, total: number, label: string) =>
      `Running. Step ${n} of ${total}: ${label}.`,
    awaiting: (text: string) => `Waiting for you. ${text}`,
    cancelled: {
      user: 'Cancelled. You stopped this run.',
      suite: 'Cancelled. The suite this run belongs to was cancelled.',
      shutdown: 'Cancelled. The playground was shutting down.',
    },
    noVerdict: 'No verdict was recorded.',
    error: (detail: string) =>
      `Run error. This is a problem with the playground or an upstream service, not a protocol result. ${detail}`,
  },
  errorCode: {
    env_not_ready: (message: string) =>
      `A service this run needs was not ready: ${message}. Check the Environment page, then run again.`,
    sidecar_unavailable:
      'The Inji library sidecar could not be reached. Check that the sidecar container is running, then run again.',
    engine_exception: (message: string) =>
      `A library threw an exception outside a protocol step: ${message}. The Engine tab shows it.`,
    ui_not_connected:
      'This run uses the Verify SDK in the browser, and no request arrived from the page within 120 seconds. Keep this page open while the run starts, then run again.',
    bff_restarted: 'The playground restarted while this run was in progress. Run it again.',
    internal_error: (requestId: string) =>
      `The playground hit an unexpected error. Reference ${requestId}. Run it again; if it repeats, export the run and report it.`,
  },
  awaitingHeading: {
    issuance: 'Scan the offer with your phone.',
    presentation: 'Share the credential from your phone.',
    'card-status': 'Check the card in the wallet.',
    'dcapi-holder': 'Did a wallet answer?',
    'sdk-request-uri': 'Use the Verify SDK in the page below.',
  } as Record<string, string>,
  result: {
    region: 'Result',
    passValid: 'The verifier accepted the credential: Valid.',
    passExpired:
      'Valid but expired. The signature checks out and the credential is past its expiry date.',
    passIssued: 'The credential was issued. No verification was run.',
    failInvalid: (step: string, code: string, message: string) =>
      `Invalid. The verifier rejected the credential at ${step}: ${code} ${message}.`,
    /** every step passed and the verifier answered "invalid" (FLOW-40 credential-level) */
    failInvalidChecks: (code: string, message: string) =>
      `Invalid. The verifier rejected the credential: ${code} ${message}.`,
    failAt: (step: string, code: string, message: string) =>
      `Failed at ${step}: ${code} ${message}.`,
    blocked: (target: string, failing: string) =>
      `Blocked. ${target} did not run because ${failing} failed first. Counted as not working in pass rates.`,
    lenient:
      'Lenient. The component accepted something the specification leaves to policy. Counted as conformant.',
    inconclusive: (reason: string) => `Inconclusive. ${reason}. Not counted in pass rates.`,
    inconclusiveManual: 'a manual observation never arrived',
    inconclusiveControl: 'the control run failed',
    noSubmission:
      'No submission. The wallet never sent a response to the verifier before the request expired. Not counted in pass rates.',
    probe:
      'Probe result: no holder answered. Inji Wallet cannot answer the DC API (G-37). Not counted in pass rates.',
    outcome: 'Outcome',
    failingStep: 'Failing step',
    errorDetail: 'Error detail',
    proofAlg: 'Proof alg',
    note: 'Note',
  },
  rail: {
    heading: 'Steps',
    issuance: 'Issuance',
    presentation: 'Presentation',
    outcome: {
      pending: 'Pending',
      running: 'Running',
      pass: 'Pass',
      fail: 'Fail',
      skipped: 'Skipped',
    },
    messages: (n: number) => `${n} message${n === 1 ? '' : 's'}`,
    checks: (n: number) => `${n} check${n === 1 ? '' : 's'}`,
    announceStep: (label: string, word: string) => `${label}: ${word}.`,
    announceDone: (word: string) => `Run finished: ${word}.`,
  },
  capture: {
    full: 'Full capture',
    partial: 'Partial capture',
    none: 'No capture (engine)',
    fullTip: 'Every HTTP message of this step was recorded by the playground.',
    partialTip: (note: string) =>
      `Part of this step ran outside the playground's capture: ${note}. Diagnosis does not use this step as evidence.`,
    noneTip:
      'This step runs inside a library or by hand, so no HTTP message was recorded. The playground shows the engine call instead.',
  },
  coverage: {
    heading: (k: number) => `Partial evidence: ${k} step(s) ran outside full capture.`,
    partialItem: (label: string, key: string, note: string) =>
      `${label} (${key}): Partial capture: ${note}`,
    noneItem: (label: string, key: string, engine: string) =>
      `${label} (${key}): No capture: runs inside ${engine} or by hand`,
    engineSteps: 'Engine steps (always uncaptured)',
    footer:
      'A diagnosis never rests on these steps. Anything seen only here is reported as an observation.',
  },
  inspector: {
    region: 'Inspector',
    selectStep: 'Select a step in the diagram to see its messages.',
    noMessages: 'No messages yet. They appear here as the run makes requests.',
  },
  diagram: {
    region: 'Sequence diagram',
    issue: '1. Issue',
    present: '2. Present and verify',
    legend: 'Diagram legend',
    pass: 'Pass',
    fail: 'Fail',
    skipped: 'Skipped',
    pending: 'Pending',
    builtin: 'Using the built-in diagram renderer.',
    delivery: 'Delivery',
    deliveryTip: 'Show the QR code and link sent to the wallet',
  },
} as const;

/** UI-30 dialogs of the run screen, verbatim. */
export const runDialogCopy = {
  cancel: {
    heading: 'Stop this run?',
    body: 'The run stops at the current step and no verdict is recorded. Steps already captured are kept.',
    confirm: 'Stop run',
    keep: 'Keep running',
    alreadyFinished: 'The run has already finished.',
    close: 'Close',
  },
  note: {
    heading: 'Run note',
    label: 'Note',
    counter: (n: number) => `${n.toLocaleString('en-US')} / 2,000`,
    helper: 'Shown on the result card and in reports.',
    save: 'Save',
    clear: 'Clear note',
    cancel: 'Cancel',
    notTerminal: 'The note can be edited when the run ends.',
  },
  delete: {
    heading: 'Delete this run?',
    body: 'This removes the run, its messages and its stored artifacts from this machine. It cannot be undone.',
    pinned: 'This run is pinned. Deleting it overrides the pin.',
    confirm: 'Delete',
    cancel: 'Cancel',
    cascadeHeading: 'Delete this run and the runs that depend on it?',
    cascadeBody: (n: number, tmp: string | null) =>
      `${n} re-run(s) of this run${tmp ? ` and the control run of ${tmp}` : ''} will also be deleted:`,
    cascadeTail: 'This cannot be undone.',
    cascadeConfirm: (n: number) => `Delete ${n + 1} runs`,
    deletedToast: (shortId: string) => `Run ${shortId} deleted.`,
  },
} as const;

/** UI-18..UI-23 inspector copy, verbatim. */
const INSPECT_FORMAT: Record<string, string> = {
  'dc+sd-jwt': 'SD-JWT VC',
  ldp_vc: 'JSON-LD',
  mso_mdoc: 'mDoc',
  jwt_vc_json: 'JWT VC',
};

export const inspectorCopy = {
  tabsLabel: 'Inspector views',
  tabs: {
    messages: 'Messages',
    decoded: 'Decoded',
    checks: 'Checks',
    engine: 'Engine',
    events: 'Events',
  },
  scope: { label: 'Scope', step: 'This step', run: 'Whole run' },
  keyBar: 'Key payloads',
  chips: {
    offer: 'Offer',
    token: 'Token',
    credential: 'Credential',
    'request-link': 'Request link',
    'request-object': 'Request object',
    'vp-token': 'vp_token',
    query: 'Presentation query',
    result: 'Verification result',
  },
  chipMissing: 'Not part of this run',
  skipped: (reason: string) => `This step was skipped: ${reason}.`,
  following: (label: string) => `Following: ${label}`,
  messages: {
    footer: (n: number) => `Showing ${n} messages of this step.`,
    footerRun: (n: number) => `Showing ${n} messages of this run.`,
    empty: 'No HTTP messages were recorded for this step.',
    emptyNone: 'It runs inside a library or by hand. See the Engine tab.',
    emptyPartial: (note: string) => `Part of it ran outside the playground's capture: ${note}.`,
    outbound: 'outbound',
    inbound: 'inbound',
    outboundTip: (actor: string, counterpart: string) => `${actor} called ${counterpart}.`,
    inboundTip: (actor: string, counterpart: string) =>
      `${actor} called ${counterpart} through the playground's gateway.`,
    gatewaySeen: "Seen by the playground's gateway",
    noResponse: (cls: string, ms: number) => `No response: ${cls} after ${ms} ms`,
    request: 'Request',
    response: 'Response',
    headers: 'Headers',
    noHeaders: 'No headers.',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    copyCurl: 'Copy as cURL',
    copyBody: 'Copy body',
    poll: (i: number, total: number | null) =>
      total !== null ? `Poll ${i} of ${total}` : `Poll ${i}`,
    pollNote: (n: number) => `${n} intermediate polls with no change were not stored.`,
    redacted: (name: string) => `hidden: ${name}`,
    redactedTip:
      'This is a secret of this installation, so the playground hides it. Protocol test material such as tokens and codes is never hidden.',
  },
  body: {
    modes: 'Body view',
    pretty: 'Pretty',
    raw: 'Raw',
    decoded: 'Decoded',
    region: (part: 'Request' | 'Response') => `${part} body`,
    none: 'No body.',
    loadFull: (kib: number) => `Load the full body (${kib} KiB)`,
    capped: (kib: number, sha: string) =>
      `Showing the first 256 KiB of ${kib} KiB. The playground stores at most 256 KiB per message. SHA-256 of the full body: ${sha}.`,
    pruned:
      'The body was removed by retention. Headers and timing are kept. Bodies of passing nightly runs are kept 14 days and of other runs 90 days; pin a run to keep it.',
    dropped:
      'This body was not stored: the run reached its 24 MiB body limit before this message. The step is marked Partial capture.',
    binary: (size: number) => `Binary, ${size} bytes`,
    sha: (hex: string) => `SHA-256 ${hex.slice(0, 16)}…`,
    copySha: 'Copy SHA-256',
    signature: 'Signature (not verified here)',
    header: 'Header',
    payload: 'Payload',
    disclosure: (n: number) => `Disclosure ${n}`,
    kbJwt: 'Key-binding JWT',
    issuerJwt: 'Issuer JWT',
    formName: 'Name',
    formValue: 'Value',
    state: {
      stored: 'Stored',
      truncated: 'Truncated',
      none: 'No body',
      pruned: 'Pruned',
      dropped_run_cap: 'Not stored',
    },
  },
  decoded: {
    empty: 'Nothing to decode in this step.',
    disclaimer:
      "Decoded here without checking the signature. The verifier's own result is on the Checks tab.",
    from: (where: string) => `From ${where}`,
    disclosed: (name: string, value: string) => `Disclosed claim: ${name} = ${value}`,
    x5c: (present: boolean) => `x5c ${present ? 'yes' : 'no'}`,
    fromEngine: (op: string, engine: string) => `From the engine call ${op} (${engine})`,
    inspected: (format: string) =>
      `Credential as the wallet decoded it${format ? ` (${INSPECT_FORMAT[format] ?? format})` : ''}`,
    inspectError: (message: string) => `The wallet could not decode the credential: ${message}`,
    bytesOnly: (n: number) => `${n} bytes. This format is decoded by the verifier side, not here.`,
    artifacts: 'Fields the diagnosis reads',
    kbJwt: (alg: string | null) => `Key-binding JWT${alg ? ` (${alg})` : ''}`,
    jwsSha256: (hash: string) => `SHA-256 of the signed JWT: ${hash}`,
    engineNote:
      'Built and signed inside the playground wallet. The holder key itself never leaves the server.',
  },
  checks: {
    empty: 'No checks were recorded for this step.',
    findings: 'Conformance findings',
    spec: (clause: string) => `Spec: ${clause}`,
    showMessage: (n: number) => `Show message ${n}`,
    outcome: { pass: 'Pass', fail: 'Fail', 'not-run': 'Not run', info: 'Info' },
    source: {
      'verifier-response': 'Verifier response',
      engine: 'Library',
      'playground-lint': 'Playground check (lint)',
    },
    lintTip: 'A check written by the playground, not an answer from the component under test.',
  },
  engine: {
    empty: 'No library calls in this step.',
    input: 'Input summary',
    output: 'Output summary',
    showQr: 'Show QR',
    endedStep: 'This ended the step',
    channel: (c: string) => `Channel: ${c}`,
  },
  events: {
    seq: 'seq',
    time: 'Time',
    type: 'Type',
    step: 'Step',
    summary: 'Summary',
    filterType: 'Event type',
    filterStep: 'Step key',
    allTypes: 'All types',
    copyEvent: 'Copy event',
    caption: (n: number) => `${n} events`,
  },
} as const;

/** UI-15 awaiting panel and UI-16 delivery copy, verbatim. */
export const deliveryCopy = {
  region: 'Waiting for you',
  timeLeft: (mmss: string) => `Time left ${mmss}`,
  announce: (heading: string) => `Waiting for you: ${heading}`,
  announceLeft: (s: number) => `${s} seconds left.`,
  expired: 'Time ran out. The run ended without a response from the phone.',
  headings: {
    issuance: 'Scan the offer with your phone.',
    presentation: 'Share the credential from your phone.',
    'card-status': 'Check the card in the wallet.',
    'dcapi-holder': 'Did a wallet answer?',
    'sdk-request-uri': 'Use the Verify SDK in the page below.',
  },
  steps: {
    issuance: [
      '1. Open Inji Wallet on the phone.',
      '2. Choose to scan a QR code and scan the code on this page, or open the link below on the phone.',
      '3. Accept the credential when the wallet asks.',
      '4. Come back here and tell the playground what the phone showed.',
    ],
    presentation: [
      '1. In Inji Wallet, scan the QR code on this page.',
      '2. Choose the credential and share it.',
      '3. The result appears here by itself. If the phone shows a message first, record it below.',
    ],
    'card-status': ['Open the credential in Inji Wallet and look at its status.'],
    'dcapi-holder': [
      'The browser asked for a credential through the Digital Credentials API. Say who answered, if anyone.',
    ],
    'sdk-request-uri': [
      'The Verify SDK draws the request here and the playground records its calls. This run starts when the SDK sends its first request.',
    ],
  },
  qrName: (kind: 'offer' | 'request') => `QR code for the ${kind} link`,
  tooLong: 'This link is too long for a QR code. Copy the link instead.',
  showFull: 'Show full link',
  showLink: 'Show link',
  copyLink: 'Copy link',
  copied: 'Copied',
  linkCopied: 'Link copied',
  copyFailed: 'Could not copy. Select the link and copy it by hand.',
  openHere: 'Open link on this computer',
  openHereTip: 'Opens the link in the default handler on this computer.',
  sameDevice: 'Same-device link',
  openLink: 'Open the link',
  adb: 'The playground sent the link to the connected phone with adb.',
  webWallet:
    'The browser is redirected to the wallet. After you share, the wallet sends you back here.',
  inProcess: 'Handed over inside the playground. No QR code is needed.',
  dialog: {
    title: 'Link sent to the wallet',
    offer: 'Credential offer',
    request: 'Verification request',
    close: 'Close',
    open: 'Delivery',
  },
  query: { param: 'Parameter', value: 'Value' },
} as const;

/** UI-03..UI-08 selector copy, verbatim. */
export const selectorCopy = {
  eyebrow: 'New interop run',
  title: 'Pick who plays each role',
  lead: 'Choose an issuer, a wallet and a verifier. The playground runs the whole credential journey and records every message.',
  groupLabel: 'Issuer, wallet and verifier',
  columns: { issuer: 'Issuer', wallet: 'Wallet', verifier: 'Verifier' },
  options: (n: number) => `${n} option${n === 1 ? '' : 's'}`,
  verifierUnused: 'not used when you only issue',
  names: {
    'issuer.certify-preauth': [
      'Inji Certify (pre-authorized)',
      'Local Inji Certify with a pre-authorized code. SD-JWT VC, JSON-LD and mDoc.',
    ],
    'issuer.certify-authcode': [
      'Inji Certify (authorization code)',
      'Local Inji Certify behind eSignet. JSON-LD and mock mDL.',
    ],
    'issuer.certify-mdoc': [
      'Inji Certify (mDoc, spec profile)',
      'Develop-class Certify that issues spec-shaped mDoc.',
    ],
    'issuer.certify-collab': [
      'Inji Certify (Collab sandbox)',
      'The MOSIP Collab Certify, reached through Inji Web. Read-only, best-effort.',
    ],
    'issuer.waltid': ['walt.id issuer', 'External issuer from another ecosystem. SD-JWT VC.'],
    'issuer.fixture': ['Saved credential', 'Replays a saved credential. No issuing traffic.'],
    'wallet.playground-ts': ['Playground wallet', 'The reference wallet. Records every message.'],
    'wallet.inji-jvm': [
      'Inji libraries (Kotlin)',
      "Inji's VCI client and OpenID4VP libraries in a JVM sidecar.",
    ],
    'wallet.inji-web': ['Inji Web + Mimoto', 'The browser wallet, driven by the playground.'],
    'wallet.inji-mobile': [
      'Inji Wallet (your phone)',
      'You scan QR codes with the phone. Needs the tunnel.',
    ],
    'wallet.credo': ['Credo wallet', 'Credo 0.7.1 holder with saved credentials.'],
    'verifier.inji-verify-local': [
      'Inji Verify (local)',
      'The Inji Verify service running in this bundle.',
    ],
    'verifier.inji-verify-collab': [
      'Inji Verify (Collab sandbox)',
      'The MOSIP Collab Verify. Calls are capped at 20 per minute.',
    ],
    'verifier.inji-verify-sdk': [
      'Inji Verify SDK (in this page)',
      'The Verify SDK component, drawn here; the playground records its calls.',
    ],
    'verifier.vcverifier-offline': [
      'Inji vc-verifier (library)',
      'Checks a credential on its own, without a presentation.',
    ],
    'verifier.waltid': ['walt.id verifier', 'External verifier from another ecosystem.'],
    'verifier.eudi': ['EUDI verifier', 'The EU reference verifier.'],
    'verifier.credo': ['Credo verifier', 'Checks a credential on its own, without a presentation.'],
  } as Record<string, [string, string]>,
  env: { local: 'Local', collab: 'Collab sandbox' },
  tier: {
    automated: [
      'Automated',
      'Runs without anyone touching a phone or a browser. Counts toward pass rates.',
    ],
    'best-effort': [
      'Best-effort',
      'Depends on a service the playground does not control. Counts toward pass rates but can be inconclusive.',
    ],
    manual: [
      'Manual',
      'You operate the phone. The result is recorded as evidence and is not counted in pass rates.',
    ],
  } as Record<string, [string, string]>,
  tierHint: {
    manual: 'You will need your phone.',
    'best-effort': 'Best-effort: may be inconclusive.',
  } as Record<string, string>,
  version: (v: string) => `version ${v}`,
  available: 'Running',
  notRunning: (reason: string) => `Not running: ${reason}`,
  /** API-02 unavailability: the release cut (ADR-95) is not a stopped service */
  unavailable: (reason: string) =>
    reason.startsWith('not in this release')
      ? `Not in this release (${reason.replace(/^not in this release \((.*)\)$/, '$1')})`
      : `Not running: ${reason}`,
  notAvailable: (reason: string, gap: string | null) =>
    `Not available with this selection: ${reason}${gap ? ` (${gap})` : ''}`,
  conflicts: (reason: string, gap: string | null) =>
    `Conflicts with the selection: ${reason}${gap ? ` (${gap})` : ''}`,
  whyNot: 'Why not?',
  gap: (id: string) => `Gap ${id}`,
  evidence: (list: string) => `Evidence: ${list}`,
  details: 'Details',
  partHop: (key: string, reason: string) => `Partly outside capture: ${key}: ${reason}`,
  tunnel: {
    phone: 'Needs the tunnel: The phone reaches the bundle only through the tunnel (G-105)',
    'collab-ldp': "Needs the tunnel: Collab resolves the issuer's did:web publicly",
    start: 'Start scripts/tunnel.sh first.',
  },
  checkFailed: 'Could not check compatibility. The playground will check again when you press Run.',
  recipe: {
    format: 'Format',
    mode: 'Mode',
    scope: 'Scope',
    formats: {
      'dc+sd-jwt': 'SD-JWT VC',
      ldp_vc: 'JSON-LD',
      mso_mdoc: 'mDoc',
    } as Record<string, string>,
    modes: {
      'cross-device': 'Cross-device (QR)',
      'same-device': 'Same-device (deep link)',
      'dc-api': 'Digital Credentials API (probe)',
      'credential-level': 'Credential only (no OID4VP)',
    } as Record<string, string>,
    modeHelp: {
      'cross-device': 'A QR code or link goes to the wallet.',
      'same-device': 'The wallet opens from a link on the same device.',
      'dc-api':
        'Only checks whether the browser and a wallet can answer. It never counts toward pass rates.',
      'credential-level':
        'The verifier checks the held credential directly (POST /v2/vc-verification). No wallet presentation.',
    } as Record<string, string>,
    fixtureCase: 'Fixture case',
    fixtureCases: {
      PlaygroundSdJwt: 'Valid',
      PlaygroundSdJwtExpired: 'Expired',
      PlaygroundSdJwtInvalid: 'Bad signature',
    } as Record<string, string>,
    fixtureCaseHelp:
      'Test-only credentials signed at run time: valid, expired yesterday, or with a broken signature.',
    scopes: { full: 'Issue, present and verify', issuance: 'Issue only' } as Record<string, string>,
    issueOnlyHelp: 'Stops after the credential is issued. The verifier is not used.',
    grant: (g: string) =>
      `Grant: ${g === 'authorization_code' ? 'authorization code' : 'pre-authorized code'}`,
    delivery: (d: string) => `Delivery: ${d}`,
  },
  grantWord: {
    'pre-authorized_code': 'pre-authorized code',
    authorization_code: 'authorization code',
  } as Record<string, string>,
  issueOnly: 'Issue only',
  run: 'Run',
  starting: 'Starting…',
  startBar: 'Start',
} as const;

/** UI-51 run report view copy, verbatim. */
export const reportCopy = {
  docTitle: (sid: string) => `Report ${sid}`,
  title: (sid: string, verdict: string) => `Run ${sid}: ${verdict}`,
  crumbRun: (sid: string) => `Run ${sid}`,
  crumb: 'Report',
  actions: {
    open: 'Open run screen',
    json: 'Download JSON',
    markdown: 'Download Markdown',
    copy: 'Copy Markdown',
    copied: 'Copied',
  },
  tabs: { report: 'Report', markdown: 'Markdown', json: 'JSON' } as Record<string, string>,
  tabsLabel: 'Report format',
  markdownLabel: 'Report as Markdown',
  jsonLabel: 'Report as JSON',
  sections: {
    combination: 'Combination',
    failing: 'Failing checks',
    diagnosis: 'Diagnosis',
    fixit: 'Fix-it',
    tamper: 'Tamper',
    coverage: 'Coverage',
    steps: 'Steps',
  },
  fields: {
    issuer: 'Issuer',
    wallet: 'Wallet',
    verifier: 'Verifier',
    format: 'Format',
    proofType: 'Proof type',
    grant: 'Grant',
    mode: 'Presentation mode',
    env: 'Environment',
    versions: 'Versions',
    knobs: 'Settings',
    verdict: 'Outcome',
    failedStep: 'Failed step',
    errorDetail: 'Error detail',
    none: 'None',
    defaults: 'All defaults',
  },
  checkCols: ['Check', 'Source', 'Code', 'Spec clause', 'Message'],
  noFailing: 'No failing checks.',
  unclassified:
    'Unclassified. No known fingerprint matched; the raw checks above are the evidence.',
  findingsOnPass: 'Findings on a passing run',
  noFindings: 'No findings.',
  confidence: { exact: 'exact', possible: 'possible', observed: 'observed' } as Record<
    string,
    string
  >,
  match: {
    gaps: 'Gaps',
    side: 'Deviating side',
    clause: 'Spec clause',
    confidence: 'Confidence',
    evidence: 'Evidence',
    exchanges: 'Matched exchanges',
  },
  noFix: {
    'no-proven-knob': 'No proven setting change fixes this. Diagnosis only.',
    'several-causes': 'Several possible causes. No fix is offered until one is confirmed.',
    unclassified: 'No fingerprint matched, so no fix is offered.',
    'tamper-run': 'Tamper runs are never re-run with a changed setting.',
    'observed-only': 'Observed on a manual leg only. No fix is offered.',
    'version-drift': 'A component version changed since this run. Re-run first.',
    'environment-changed': 'The environment changed since this run. Re-run first.',
  } as Record<string, string>,
  offer: (knob: string, from: string, to: string) => `${knob}: ${from} to ${to}`,
  offerProven: (by: string) => `Proven by ${by}`,
  noOffer: 'Nothing to fix.',
  coverageAll: 'Every step was fully captured.',
  coverageBanner: (hops: string) =>
    `Part of this run is outside capture: ${hops}. Diagnosis uses fully captured exchanges only.`,
  captureWord: { full: 'Full capture', partial: 'Partial capture', none: 'No capture (engine)' },
  failedRun: (code: string) =>
    `The run could not finish: ${code}. This is an environment fault, not a verdict on the combination.`,
  notTerminal: {
    title: 'This run is not finished',
    body: (state: string) => `The report is available when the run ends. Current state: ${state}.`,
  },
  notFound: {
    title: 'Run not found',
    body: 'It may have been deleted. Check History.',
    action: 'Go to History',
  },
  claim: 'Result of the change',
} as const;

/** Angle A on the run screen and the report (06 UI-24..UI-28, UI-07 KnobList), verbatim. */
export const angleCopy = {
  card: {
    region: 'Diagnosis',
    loading: 'Looking for a known cause…',
    loadError: 'The diagnosis could not be loaded. The run itself is unaffected. Try again.',
    heading: {
      exact: (title: string) => `Diagnosis: ${title}`,
      possible: 'Possible causes',
      observed: 'Observed, not diagnosed',
      unclassified: 'No known cause matched',
    },
    sub: {
      exact: 'The playground recognised this failure from captured traffic.',
      possible:
        'More than one known cause fits this failure, so the playground does not offer a re-run.',
      observed:
        "This was seen but part of the evidence is outside the playground's capture, so no cause is claimed.",
      unclassified: 'The failing check is shown as the upstream reported it.',
    },
    chip: {
      exact: 'Exact match',
      possible: 'Possible cause',
      observed: 'Observed only',
      unclassified: 'Unclassified',
    },
    chipTip: {
      exact: 'One known cause matched using fully captured traffic.',
      possible: 'Several known causes match; none is proven for this run.',
      observed: 'Seen, but not diagnosed: part of the evidence is not captured.',
      unclassified: 'No known cause matched this failure.',
    },
    partial: (capture: string, reason: string | null) =>
      `The failing step has ${capture}${reason ? ` (${reason})` : ''}. The playground does not diagnose from partial captures.`,
    side: (side: string, component: string, versions: string) =>
      `Deviating side: ${side}: ${component} ${versions}`,
    spec: (clause: string) => `Spec: ${clause}`,
    gaps: (ids: string) => `Known gaps: ${ids}`,
    evidence: 'Evidence: ',
    evidenceTip: 'Fingerprint file in the repository; its golden test reproduces the finding',
    /** public evidence of a fingerprint (ADR-98, ADR-100): its repo file, never a research S-ID */
    evidencePath: (fingerprintId: string) => `fingerprints/${fingerprintId}.json`,
    showMessages: 'Show matched messages',
    showCheck: 'Show the failing check',
    findings: 'Conformance findings',
    findingsSub: 'These are lint results on steps that passed. They never change the verdict.',
    none: 'none',
    check: (checkId: string, code: string | null, message: string) =>
      `${checkId}${code ? ` ${code}` : ''}: ${message}`,
  },
  fix: {
    region: 'Fix it and re-run',
    title: 'Try the fix',
    arrowTip: 'The only value that changes.',
    explainer:
      'Everything else stays the same: same issuer, wallet, verifier, format and holder key.',
    walletRuntime:
      "This is a simulated fix: the playground's own wallet is changed, so it shows where the defect is, not a change you can make to Inji.",
    peerRuntime: (name: string) => `This changes an option of the ${name} component, not of Inji.`,
    provenBy: 'Proven by an earlier re-run (recorded in the repository golden tests).',
    button: 'Fix it and re-run',
    sending: 'Starting…',
  },
  noFix: {
    'no-proven-knob':
      'Diagnosis only. No change has been proven to fix this for this wallet, verifier and format.',
    'several-causes':
      'Diagnosis only. More than one known cause fits, so no single change can be proven.',
    unclassified: 'Diagnosis only. No known cause matched, so there is nothing to re-run.',
    'tamper-run': 'Tamper runs are not re-run with a fix. See the tamper result.',
    'observed-only':
      'Diagnosis only. This was observed but not diagnosed, so no re-run is offered.',
    'version-drift':
      "A fix was found but a component's version changed since this run. Run the original combination again first.",
    'environment-changed':
      'A fix was found but the tunnel changed since this run. Restore the tunnel (scripts/tunnel.sh) or run the original combination again.',
    imported: 'Imported runs cannot be re-run with a fix: their holder key is not included.',
    'not-fixed-before':
      'The fix for this combination is switched off until it is re-verified (it did not hold last time).',
  } as Record<string, string>,
  versionDrift: (column: string, was: string, now: string) =>
    `A fix was found but the ${column} version changed since this run (${was} to ${now}). Run the original combination again first.`,
  child: {
    banner: (parent: string, knob: string, from: string, to: string, fp: string | null) =>
      `This run is a re-run of ${parent} with one change: ${knob} ${from} → ${to}.${fp ? ` It tests whether that change fixes ${fp}.` : ''}`,
    bannerShort: (parent: string, knob: string, from: string, to: string) =>
      `Re-run of ${parent}: ${knob} ${from} → ${to}`,
    region: 'Re-run result',
    chip: {
      fixed: 'Fixed',
      moved: 'Moved',
      'not-fixed': 'Not fixed',
      inconclusive: 'Inconclusive',
    },
    heading: {
      fixed: 'The change fixed it.',
      moved: 'The run now fails somewhere else.',
      'not-fixed': 'The change did not fix it.',
      inconclusive: 'The re-run did not settle it.',
    },
    moved: (checkId: string) =>
      `The run fails at a different check (${checkId}) or a different cause matches. Its own diagnosis is above. You can try one more change.`,
    notFixed: (fp: string) =>
      `The same cause (${fp}) still matches. This change is flagged for review for this combination, and its fix button is off until it is re-verified.`,
    inconclusive:
      "The re-run ended with an error or was cancelled, or a step the diagnosis relied on lost capture. Nothing is concluded; the original run's diagnosis still stands. Run the fix again.",
    runAgain: 'Run the fix again',
    compare: (parent: string) => `Compare with run ${parent}`,
    open: (parent: string) => `Open run ${parent}`,
    copyClaim: 'Copy claim sentence',
    copied: 'Copied the claim sentence.',
    parentDeleted: 'The parent run was deleted, so the comparison is no longer available.',
    notComparable: 'The runs cannot be compared.',
    announce: (word: string) => `Finished. Re-run result: ${word}.`,
  },
  strip: {
    disclosure: (parent: string) => `Compare with run ${parent}`,
    original: (parent: string) => `Run ${parent} (original)`,
    rerun: (child: string, knob: string, to: string) => `Run ${child} (with ${knob} = ${to})`,
    step: 'Step',
    change: 'Change',
    direct: (knobId: string) => `Changed by ${knobId}`,
    showUnchanged: (n: number) => `Show ${n} unchanged steps`,
    full: 'Open full comparison',
    volatile:
      'Volatile fields such as nonces and timestamps are hidden. Show them in the full comparison.',
    same: 'Same',
    differs: (n: number) => `Differs (${n} field${n === 1 ? '' : 's'})`,
    onlyParent: 'Only in original',
    onlyChild: 'Only in re-run',
    skipped: (side: 'parent' | 'child') =>
      `Skipped in ${side === 'parent' ? 'original' : 're-run'}`,
    empty: 'No step differs between the two runs.',
    parentDeleted: 'The original run was deleted.',
    notComparable: 'These runs cannot be compared.',
  },
  lineage: {
    heading: 'Re-run chain',
    current: 'current',
    deleted: 'run deleted',
    result: {
      fixed: 'Fixed',
      moved: 'Moved',
      'not-fixed': 'Not fixed',
      inconclusive: 'Inconclusive',
      running: 'Running',
    },
    run: (id: string) => `Run ${id}`,
  },
  knobs: {
    disclosure: 'Advanced options',
    label: 'Run label',
    heading: 'Settings for this combination',
    none: 'No settings apply to this combination.',
    loading: 'Loading the settings…',
    error: 'Could not load the settings list. You can still run with the defaults.',
    defaultMark: '(default)',
    status: { proven: 'Proven', unproven: 'Unproven', 'no-value-passes': 'No value passes' },
    statusTip: {
      proven: 'A re-run with this change was seen to fix the failure it targets.',
      unproven:
        'No re-run has proven this change yet. It can be set, but the playground will not offer it as a fix.',
      'no-value-passes': 'No value of this setting makes the combination pass.',
    },
    lockedCollab: 'Locked: the Collab sandbox is read-only, so issuer settings cannot change.',
    lockedMobile: 'Locked: the phone leg uses a fixed request profile.',
    summary: (n: number) =>
      `${n} setting(s) differ from the defaults. Runs with changed settings are kept in history but do not count in the matrix.`,
  },
} as const;

/** Run-screen words: the decoded view, the one-setting fix-it diff and the compare strip. */
export const screenCopy = {
  decoded: {
    copyPayload: 'Copy payload',
    disclosures: (n: number) => `${n} disclosed claim${n === 1 ? '' : 's'}`,
  },
  fix: {
    oneChange: 'One setting changes',
    from: 'Now',
    to: 'Re-run with',
  },
  strip: {
    flipped: 'Outcome flipped',
  },
} as const;
