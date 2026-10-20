/**
 * The sequence diagram's pure model (06 UI-12, 03 §3.1, ADR-40): the messages of one flow
 * definition in definition order, the `messageIndex → stepKey` array built from the `messages`
 * counts, the Mermaid text, and the per-message visual state reduced from the run's events.
 * Both renderers (pinned Mermaid and the built-in SVG renderer) draw from this model.
 */
import type {
  EventEnvelope,
  FlowDefinition,
  FlowStep,
  Lifeline,
  RunSpec,
} from '@interop-playground/api';
import { mergeSteps } from '../run/flows.js';
import type { RunView } from '../run/reduce.js';

export interface DiagramMessage {
  /** 0-based position in document order (Mermaid `autonumber` N = index + 1) */
  index: number;
  stepKey: string;
  /** 0 = request (or the single message), 1 = dashed response */
  part: 0 | 1;
  from: string;
  to: string;
  dashed: boolean;
  /** label template of the flow file */
  template: string;
}

export interface DiagramFlow {
  flowId: string;
  lifelines: Lifeline[];
  steps: FlowStep[];
  messages: DiagramMessage[];
  /** `messageIndex → stepKey` (03 §3.1 item 1) */
  index: string[];
}

/** the flow file's steps (format deltas merged with their base), deprecated ones dropped */
export function diagramFlow(def: FlowDefinition, base: FlowDefinition | null): DiagramFlow {
  const steps = mergeSteps(def, base).filter((s) => !s.deprecated);
  const messages: DiagramMessage[] = [];
  for (const s of steps) {
    const [req, res] = splitLabel(s.label);
    messages.push({
      index: messages.length,
      stepKey: s.stepKey,
      part: 0,
      from: s.from,
      to: s.to,
      dashed: false,
      template: req,
    });
    if (s.messages === 2) {
      messages.push({
        index: messages.length,
        stepKey: s.stepKey,
        part: 1,
        from: s.to,
        to: s.from,
        dashed: true,
        template: res,
      });
    }
  }
  return {
    flowId: def.flowId,
    lifelines: def.lifelines,
    steps,
    messages,
    index: messages.map((m) => m.stepKey),
  };
}

/** `request / response` label templates (03 §3.3); an http step without one answers `{status}` */
export function splitLabel(label: string): [string, string] {
  const at = label.indexOf(' / ');
  if (at < 0) return [label, '{status}'];
  return [label.slice(0, at), label.slice(at + 3)];
}

/** sum of `messages` over the steps: what the integrity check expects */
export const expectedMessageCount = (flow: DiagramFlow): number =>
  flow.steps.reduce((n, s) => n + s.messages, 0);

export const LIFELINE_ROLE: Record<Lifeline, string> = {
  IUI: 'Issuer UI',
  I: 'Issuer',
  VUI: 'Verifier UI',
  V: 'Verifier',
  W: 'Wallet',
  L: 'Library',
};

/** lifeline display names: the chosen adapters' names where a lifeline is an adapter (03 §3.1 item 2) */
export function lifelineNames(
  spec: RunSpec | null,
  name: (id: string) => string = (id) => id,
): Record<Lifeline, string> {
  return {
    ...LIFELINE_ROLE,
    ...(spec
      ? { I: name(spec.issuer), W: name(spec.wallet), V: name(spec.verifier) }
      : ({} as Partial<Record<Lifeline, string>>)),
  };
}

/** Mermaid's message text cannot carry `;` or `#` raw (entity codes are its escape) */
export function mermaidEscape(text: string): string {
  return text
    .replace(/#/g, '#35;')
    .replace(/;/g, '#59;')
    .replace(/[\r\n]+/g, ' ');
}

/** UI-12 rendering step 1: the `sequenceDiagram` text of one flow */
export function mermaidText(flow: DiagramFlow, names: Record<string, string>): string {
  const lines = ['sequenceDiagram', '  autonumber'];
  for (const l of flow.lifelines)
    lines.push(`  participant ${l} as ${mermaidEscape(names[l] ?? l)}`);
  for (const m of flow.messages) {
    const arrow = m.dashed ? '-->>' : '->>';
    lines.push(`  ${m.from}${arrow}${m.to}: ${mermaidEscape(cut(placeholderless(m.template)))}`);
  }
  return `${lines.join('\n')}\n`;
}

const MAX_LABEL = 48;
/** Shortens a diagram label to fit, ending with an ellipsis. */
export function cut(text: string, n = MAX_LABEL): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}
const placeholderless = (t: string): string => t.replace(/\{\w+\}/g, '…');

// ---------------------------------------------------------------- state from events

export type MessageState = 'pending' | 'active' | 'drawn' | 'error' | 'pass' | 'fail' | 'skipped';

export interface StepDiagramState {
  stepKey: string;
  /** step-level state: drives every message of the step once the step completes */
  state: 'pending' | 'active' | 'pass' | 'fail' | 'skipped';
  skipReason: string | null;
  capture: 'full' | 'partial' | 'none' | null;
  failedChecks: number;
  checks: number;
  pollTotal: number | null;
  /** filled labels per message part (UI-12 rendering step 5), already cut to 48 characters */
  labels: [string, string];
  /** full labels for the `<title>` child */
  titles: [string, string];
  messageStates: [MessageState, MessageState];
  engineOp: string | null;
}

interface StepFacts {
  path: string | null;
  status: number | null;
  error: string | null;
  channel: string | null;
  shown: string | null;
  allChecksSuccessful: string | null;
  requestId: string | null;
  n: number | null;
  requested: boolean;
  responded: boolean;
  errored: boolean;
  engineCalled: boolean;
  engineFailed: boolean;
  engineOp: string | null;
}

const emptyFacts = (): StepFacts => ({
  path: null,
  status: null,
  error: null,
  channel: null,
  shown: null,
  allChecksSuccessful: null,
  requestId: null,
  n: null,
  requested: false,
  responded: false,
  errored: false,
  engineCalled: false,
  engineFailed: false,
  engineOp: null,
});

function jsonField(text: string | null | undefined, field: string): unknown {
  if (!text) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[field] : undefined;
  } catch {
    return undefined;
  }
}

/** the facts each step's label placeholders and arrow states need, in one pass over the log */
export function stepFacts(events: readonly EventEnvelope[]): Map<string, StepFacts> {
  const facts = new Map<string, StepFacts>();
  const of = (k: string) => {
    let f = facts.get(k);
    if (!f) facts.set(k, (f = emptyFacts()));
    return f;
  };
  for (const e of events) {
    const k = e.stepKey;
    if (!k) continue;
    switch (e.type) {
      case 'exchange.request': {
        const p = (e as EventEnvelope<'exchange.request'>).payload;
        const f = of(k);
        f.requested = true;
        if (f.path === null) {
          try {
            f.path = new URL(p.url).pathname;
          } catch {
            f.path = p.url;
          }
        }
        if (p.body?.text) {
          const err = /(?:^|&)error=([^&]*)/.exec(p.body.text);
          if (err?.[1]) f.error = decodeURIComponent(err[1].replace(/\+/g, ' '));
        }
        break;
      }
      case 'exchange.response': {
        const p = (e as EventEnvelope<'exchange.response'>).payload;
        const f = of(k);
        f.responded = true;
        f.status = p.status;
        if (p.poll?.total) f.n = p.poll.total;
        const ok = jsonField(p.body?.text, 'allChecksSuccessful');
        if (typeof ok === 'boolean') f.allChecksSuccessful = String(ok);
        const rid = jsonField(p.body?.text, 'requestId');
        if (typeof rid === 'string' && f.requestId === null) f.requestId = rid;
        break;
      }
      case 'exchange.error': {
        const f = of(k);
        f.errored = true;
        f.error = (e as EventEnvelope<'exchange.error'>).payload.errorClass;
        break;
      }
      case 'engine.call': {
        const p = (e as EventEnvelope<'engine.call'>).payload;
        const f = of(k);
        f.engineCalled = true;
        f.engineOp = p.op;
        const o = p.outputSummary as { channel?: unknown; shown?: unknown } | null;
        if (typeof o?.channel === 'string') f.channel = o.channel;
        if (typeof o?.shown === 'string') f.shown = o.shown;
        break;
      }
      case 'engine.exception':
        of(k).engineFailed = true;
        break;
      default:
        break;
    }
  }
  return facts;
}

/** Fills a message template's placeholders from the step's captured facts and the run spec; unknown placeholders become an ellipsis. */
export function fillLabel(
  template: string,
  f: StepFacts | undefined,
  spec: RunSpec | null,
): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (name === 'id' && spec) return spec.configurationId;
    const v = f ? (f as unknown as Record<string, unknown>)[name] : undefined;
    if (name === 'channel' && (v === null || v === undefined) && spec) return spec.delivery;
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '…';
  });
}

/** reason text for steps a terminal run never reached (UI-12 event table, last row) */
export function notReachedReason(view: RunView): string | null {
  if (view.state === 'cancelled') return 'Cancelled';
  if (view.state === 'failed') return 'Run error';
  if (view.state === 'completed') return 'Not reached';
  return null;
}

/** Works out the state of every diagram message (pending, done, failed) from the run view and events. */
export function diagramStates(
  flow: DiagramFlow,
  view: RunView,
  events: readonly EventEnvelope[],
): Map<string, StepDiagramState> {
  const facts = stepFacts(events);
  const frozen = notReachedReason(view);
  const out = new Map<string, StepDiagramState>();
  for (const step of flow.steps) {
    const s = view.steps[step.stepKey];
    const f = facts.get(step.stepKey);
    const [reqT, resT] = splitLabel(step.label);
    const full: [string, string] = [fillLabel(reqT, f, view.spec), fillLabel(resT, f, view.spec)];
    let state: StepDiagramState['state'] = 'pending';
    let skipReason: string | null = null;
    if (s?.state === 'running') state = 'active';
    else if (s?.state === 'done') {
      state = s.outcome ?? 'pass';
      skipReason = s.outcome === 'skipped' ? (s.skipReason ?? step.skipReason ?? null) : null;
    } else if (frozen) {
      state = 'skipped';
      skipReason = frozen;
    }
    const ms: [MessageState, MessageState] = ['pending', 'pending'];
    if (state === 'active') {
      ms[0] = f?.requested || f?.engineCalled ? 'drawn' : 'active';
      ms[1] = f?.errored || f?.engineFailed ? 'error' : f?.responded ? 'drawn' : 'active';
      if (step.messages === 1 && f?.engineFailed) ms[0] = 'error';
    } else if (state !== 'pending') {
      ms[0] = state;
      ms[1] = state;
    }
    const checks = s?.checks.filter((c) => c.outcome !== 'info') ?? [];
    out.set(step.stepKey, {
      stepKey: step.stepKey,
      state,
      skipReason,
      capture: s?.state === 'done' && s.outcome !== 'skipped' ? s.capture : null,
      failedChecks: checks.filter((c) => c.outcome === 'fail').length,
      checks: checks.length,
      pollTotal: f?.n ?? null,
      labels: [cut(full[0]), cut(full[1])],
      titles: full,
      messageStates: ms,
      engineOp: f?.engineOp ?? null,
    });
  }
  return out;
}
