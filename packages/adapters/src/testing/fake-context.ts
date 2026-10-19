/**
 * Test support for adapter unit tests (no network): an `AdapterContext` whose `CapturingHttp`
 * dispatches to an in-process handler and records every exchange and event.
 */
import type {
  AdapterContext,
  AdapterEvent,
  CaptureContext,
  CapturingHttp,
  CorrelationKey,
  RunSpec,
} from '../contracts.js';

export interface Recorded {
  ctx: CaptureContext;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  status: number;
  response: string;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
export type Handler = (req: {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
}) => FakeResponse | Promise<FakeResponse>;

export interface FakeRun {
  ctx: AdapterContext;
  exchanges: Recorded[];
  events: AdapterEvent[];
  correlations: CorrelationKey[];
  closed: string[];
}

export const SLICE_SPEC = {
  issuer: 'issuer.certify-preauth',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
  grant: 'pre-authorized_code',
  presentationMode: 'cross-device',
  format: 'dc+sd-jwt',
  configurationId: 'PlaygroundSdJwt',
  env: { issuer: 'local', wallet: 'local', verifier: 'local' },
  versions: { issuer: 't', wallet: 't', verifier: 't' },
  tamperCase: null,
  knobs: {},
  parentRunId: null,
  knobDelta: null,
  tunnelHost: null,
  scope: 'full',
  issuanceFlowId: 'FLOW-04',
  presentationFlowId: 'FLOW-30',
  delivery: 'in-process',
  withTxCode: false,
  withIae: false,
  disclosure: { claimPaths: [['fullName']] },
  clientIdScheme: 'plain',
  suiteId: null,
  controlRunId: null,
  causeFingerprintId: null,
} as const satisfies RunSpec;

export function fakeRun(
  handler: Handler,
  opts: { spec?: Partial<RunSpec>; signal?: AbortSignal } = {},
): FakeRun {
  const exchanges: Recorded[] = [];
  const events: AdapterEvent[] = [];
  const correlations: CorrelationKey[] = [];
  const closed: string[] = [];
  const http: CapturingHttp = {
    async fetch(ctx, url, init = {}) {
      const u = new URL(url);
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : null;
      const r = await handler({ method, url: u, headers, body });
      const text =
        r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      exchanges.push({
        ctx,
        method,
        url: u.toString(),
        headers: Object.fromEntries(headers.entries()),
        body,
        status: r.status,
        response: text,
      });
      return new Response(r.status === 204 ? null : text, {
        status: r.status,
        headers: { 'content-type': 'application/json', ...r.headers },
      });
    },
    closePoll(_ctx, group) {
      closed.push(group);
      return Promise.resolve();
    },
  };
  const spec = { ...SLICE_SPEC, ...opts.spec } as RunSpec;
  const ctx: AdapterContext = {
    runId: '01JTESTRUN0000000000000000',
    spec,
    knobs: spec.knobs,
    http,
    signal: opts.signal ?? new AbortController().signal,
    emit: (ev) => {
      events.push(ev);
      return Promise.resolve();
    },
    correlate: (k) => correlations.push(k),
    holderKey: () => Promise.reject(new Error('no keys in this test')),
    sign: () => Promise.reject(new Error('no keys in this test')),
  };
  return { ctx, exchanges, events, correlations, closed };
}

/** `stepKey:type[:outcome]` lines of the step events, in order */
export function stepTrail(events: readonly AdapterEvent[]): string[] {
  return events
    .filter((e) => e.type === 'step.started' || e.type === 'step.completed')
    .map((e) =>
      e.type === 'step.completed' ? `${e.stepKey}:${e.outcome}:${e.capture}` : `${e.stepKey}:start`,
    );
}
