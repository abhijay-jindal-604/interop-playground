/**
 * Inspector model (06 UI-18..UI-23): a pure index over the run's ordered event log (ADR-41, the
 * same log the run reducer reads). Exchanges join `exchange.request` with its response or error;
 * engine calls, checks and findings are grouped by step; the key-payload bar is resolved here.
 */
import type {
  BodyRef,
  BodyState,
  CheckResult,
  EventEnvelope,
  FingerprintMatchedPayload,
  Headers,
  PayloadOf,
  PollInfo,
} from '@interop-playground/api';

export interface MessagePart {
  headers: Headers;
  body: BodyRef | null;
  bodyState: BodyState;
}

export interface ExchangeView {
  exchangeId: string;
  stepKey: string | null;
  /** 1-based position in the run (the "message {n}" of UI-22 links) */
  n: number;
  direction: 'outbound' | 'inbound';
  actor: string;
  counterpart: string;
  method: string;
  url: string;
  request: MessagePart;
  response:
    (MessagePart & { status: number; statusText: string | null; durationMs: number }) | null;
  error: { errorClass: string; message: string; durationMs: number } | null;
  poll: PollInfo | null;
}

export interface EngineRowView {
  seq: number;
  stepKey: string | null;
  call: PayloadOf<'engine.call'> | null;
  exception: PayloadOf<'engine.exception'> | null;
}

export interface CheckView {
  seq: number;
  stepKey: string | null;
  check: CheckResult;
}

export interface FindingView {
  seq: number;
  stepKey: string | null;
  finding: FingerprintMatchedPayload;
}

export interface InspectorModel {
  exchanges: ExchangeView[];
  byId: Map<string, ExchangeView>;
  engines: EngineRowView[];
  checks: CheckView[];
  findings: FindingView[];
  /** stepKey → label from `step.started` */
  labels: Map<string, string>;
  events: readonly EventEnvelope[];
}

/** Builds the inspector's exchange and engine-call lists from the event log; each request is joined to its response by exchange id. */
export function buildModel(events: readonly EventEnvelope[]): InspectorModel {
  const exchanges: ExchangeView[] = [];
  const byId = new Map<string, ExchangeView>();
  const engines: EngineRowView[] = [];
  const checks: CheckView[] = [];
  const findings: FindingView[] = [];
  const labels = new Map<string, string>();
  for (const e of events) {
    const stepKey = e.stepKey ?? null;
    switch (e.type) {
      case 'step.started':
        if (stepKey) labels.set(stepKey, (e as EventEnvelope<'step.started'>).payload.label);
        break;
      case 'exchange.request': {
        const p = (e as EventEnvelope<'exchange.request'>).payload;
        if (byId.has(p.exchangeId)) break;
        const x: ExchangeView = {
          exchangeId: p.exchangeId,
          stepKey,
          n: exchanges.length + 1,
          direction: p.direction,
          actor: p.actor,
          counterpart: p.counterpart,
          method: p.method,
          url: p.url,
          request: { headers: p.headers, body: p.body, bodyState: p.bodyState },
          response: null,
          error: null,
          poll: p.poll,
        };
        exchanges.push(x);
        byId.set(x.exchangeId, x);
        break;
      }
      case 'exchange.response': {
        const p = (e as EventEnvelope<'exchange.response'>).payload;
        const x = byId.get(p.exchangeId);
        if (!x) break;
        x.response = {
          status: p.status,
          statusText: p.statusText,
          headers: p.headers,
          body: p.body,
          bodyState: p.bodyState,
          durationMs: p.durationMs,
        };
        if (p.poll) x.poll = p.poll;
        break;
      }
      case 'exchange.error': {
        const p = (e as EventEnvelope<'exchange.error'>).payload;
        const x = byId.get(p.exchangeId);
        if (x) x.error = { errorClass: p.errorClass, message: p.message, durationMs: p.durationMs };
        break;
      }
      case 'engine.call':
        engines.push({
          seq: e.seq,
          stepKey,
          call: (e as EventEnvelope<'engine.call'>).payload,
          exception: null,
        });
        break;
      case 'engine.exception':
        engines.push({
          seq: e.seq,
          stepKey,
          call: null,
          exception: (e as EventEnvelope<'engine.exception'>).payload,
        });
        break;
      case 'verdict.check':
        checks.push({
          seq: e.seq,
          stepKey,
          check: (e as EventEnvelope<'verdict.check'>).payload.check,
        });
        break;
      case 'fingerprint.matched':
        findings.push({
          seq: e.seq,
          stepKey,
          finding: (e as EventEnvelope<'fingerprint.matched'>).payload,
        });
        break;
      default:
        break;
    }
  }
  return { exchanges, byId, engines, checks, findings, labels, events };
}

export type ChipId =
  | 'offer'
  | 'token'
  | 'credential'
  | 'request-link'
  | 'request-object'
  | 'vp-token'
  | 'query'
  | 'result';

export interface ChipTarget {
  stepKey: string;
  /** the exchange to expand; null for an engine.call target (the request link) */
  exchangeId: string | null;
  part: 'request' | 'response' | 'engine';
}

const firstExchange = (
  m: InspectorModel,
  stepKeys: string[],
  last = false,
): ExchangeView | null => {
  for (const k of stepKeys) {
    const xs = m.exchanges.filter((x) => x.stepKey === k);
    const x = last ? xs.at(-1) : xs[0];
    if (x) return x;
  }
  return null;
};

/** 06 UI-18 key-payload bar mapping (fixed): chip → the step, exchange and part it jumps to */
export function chipTarget(m: InspectorModel, chip: ChipId): ChipTarget | null {
  const ex = (keys: string[], part: 'request' | 'response', last = false): ChipTarget | null => {
    const x = firstExchange(m, keys, last);
    return x && x.stepKey ? { stepKey: x.stepKey, exchangeId: x.exchangeId, part } : null;
  };
  switch (chip) {
    case 'offer':
      return ex(['vci.offer.fetch', 'vci.offer.mint'], 'response');
    case 'token':
      return ex(['vci.token'], 'request');
    case 'credential':
      return ex(['vci.credential'], 'response');
    case 'request-link': {
      const row = m.engines.find((r) => r.call?.op === 'deliver-request' && r.stepKey);
      return row?.stepKey ? { stepKey: row.stepKey, exchangeId: null, part: 'engine' } : null;
    }
    case 'request-object':
      return ex(['vp.request.fetch', 'vp.dcapi.request.fetch'], 'response');
    case 'vp-token':
      return ex(['vp.response.post', 'vp.dcapi.response.post'], 'request');
    case 'query':
      return ex(['vp.request.create', 'vp.dcapi.request.create'], 'request');
    case 'result': {
      // the last response of the result steps, in run order
      const keys = ['vp.result.poll', 'vp.result.fetch', 'vp.vc.verify'];
      const xs = m.exchanges.filter((x) => x.stepKey && keys.includes(x.stepKey));
      const x = xs.at(-1);
      return x && x.stepKey
        ? { stepKey: x.stepKey, exchangeId: x.exchangeId, part: 'response' }
        : null;
    }
  }
}

export const CHIPS: ChipId[] = [
  'offer',
  'token',
  'credential',
  'request-link',
  'request-object',
  'vp-token',
  'query',
  'result',
];

/** the `deliver-request` / `deliver-offer` output (UI-16 data source); the latest one wins */
export interface DeliveryOutput {
  op: 'deliver-offer' | 'deliver-request';
  stepKey: string | null;
  channel: string;
  uri: string;
  uriSha256: string | null;
}

/** The most recent offer or request delivery, which the awaiting panel shows as a QR code and link. */
export function latestDelivery(events: readonly EventEnvelope[]): DeliveryOutput | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== 'engine.call') continue;
    const d = deliveryOf(e as EventEnvelope<'engine.call'>);
    if (d) return d;
  }
  return null;
}

/** Reads a delivery (channel and URI) from an `engine.call` event, or null for other operations. */
export function deliveryOf(e: EventEnvelope<'engine.call'>): DeliveryOutput | null {
  const p = e.payload;
  if (p.op !== 'deliver-offer' && p.op !== 'deliver-request') return null;
  const o = p.outputSummary as { channel?: unknown; uri?: unknown; uriSha256?: unknown } | null;
  if (typeof o?.uri !== 'string') return null;
  return {
    op: p.op,
    stepKey: e.stepKey ?? null,
    channel: typeof o.channel === 'string' ? o.channel : 'qr',
    uri: o.uri,
    uriSha256: typeof o.uriSha256 === 'string' ? o.uriSha256 : null,
  };
}
