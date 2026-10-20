/**
 * DiagramPane (06 UI-12): one SequenceBlock per flow of the run ("1. Issue", "2. Present and
 * verify"), rendered once with pinned Mermaid when it is available and passes the integrity check,
 * else by the built-in SVG renderer with the muted toolbar line "Using the built-in diagram
 * renderer.". The run's events only change `data-state` attributes; the SVG is never re-rendered.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope, FlowDefinition } from '@interop-playground/api';
import { Skeleton } from '../components/Skeleton.js';
import { runCopy } from '../copy.js';
import type { RunFlows } from '../run/flows.js';
import { isTerminal, type RunView } from '../run/reduce.js';
import { BuiltinSequence } from './BuiltinSequence.js';
import { diagramFlow, diagramStates, type DiagramFlow, type StepDiagramState } from './model.js';
import { DiagramIndexError, decorateLanes, indexMessages, renderMermaid } from './render.js';

const c = runCopy.diagram;

/** prefers-reduced-motion (UI-73 motion rules), live */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const get = () =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false;
  const [reduced, setReduced] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

type Mode = { kind: 'pending' } | { kind: 'mermaid'; svg: string } | { kind: 'builtin' };

function applyStates(
  root: HTMLElement,
  flow: DiagramFlow,
  states: Map<string, StepDiagramState>,
  selected: string | null,
): void {
  const lines = root.querySelectorAll<SVGElement>(
    '[data-msg].messageLine0, [data-msg].messageLine1',
  );
  const texts = root.querySelectorAll<SVGElement>('.messageText[data-msg]');
  const rows = new Map(
    [...root.querySelectorAll<SVGElement>('.dg-row[data-msg]')].map((r) => [
      r.getAttribute('data-msg'),
      r,
    ]),
  );
  flow.messages.forEach((m, i) => {
    const st = states.get(m.stepKey);
    const state = st?.messageStates[m.part] ?? 'pending';
    for (const el of [lines[i], texts[i], rows.get(String(i))]) {
      if (!el) continue;
      el.setAttribute('data-state', state);
      el.setAttribute('data-step-state', st?.state ?? 'pending');
      el.classList.toggle('is-selected', selected === m.stepKey);
    }
    const t = texts[i];
    if (t && st) {
      t.textContent = st.labels[m.part];
      t.querySelector('title')?.remove();
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent =
        st.titles[m.part] +
        (st.state === 'skipped' && st.skipReason ? `. Skipped: ${st.skipReason}` : '');
      t.appendChild(title);
    }
  });
}

/** Inserts the rendered Mermaid SVG and wires its messages to step selection and state attributes. */
function MermaidSvg({
  svg,
  flow,
  states,
  selected,
  onSelect,
}: {
  svg: string;
  flow: DiagramFlow;
  states: Map<string, StepDiagramState>;
  selected: string | null;
  onSelect: (stepKey: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) applyStates(el, flow, states, selected);
  }, [flow, states, selected]);
  return (
    <div
      ref={ref}
      className="dg-mermaid"
      data-renderer="mermaid"
      aria-hidden="true"
      onClick={(e) => {
        const hit = (e.target as Element).closest('[data-step], [data-row-step]');
        const key = hit?.getAttribute('data-step') ?? hit?.getAttribute('data-row-step');
        if (key) onSelect(key);
      }}
      // the SVG was indexed (data-msg/data-step) before it is mounted; see SequenceBlock
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** One flow's diagram with its title, rendered by Mermaid or the fallback. */
function SequenceBlock({
  title,
  flow,
  names,
  states,
  selected,
  deliveryStep,
  onSelect,
  onDelivery,
  onFallback,
}: {
  title: string;
  flow: DiagramFlow;
  names: Record<string, string>;
  states: Map<string, StepDiagramState>;
  selected: string | null;
  deliveryStep: string | null;
  onSelect: (stepKey: string) => void;
  onDelivery: () => void;
  onFallback: (flowId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: 'pending' });
  useEffect(() => {
    let live = true;
    const fallback = () => {
      if (!live) return;
      setMode({ kind: 'builtin' });
      onFallback(flow.flowId);
    };
    renderMermaid(flow, names)
      .then((svg) => {
        if (svg === null) return fallback();
        // index in a detached element first: a mismatch never reaches the page (RISK-32)
        const probe = document.createElement('div');
        probe.innerHTML = svg;
        indexMessages(probe, flow);
        decorateLanes(probe);
        if (live) setMode({ kind: 'mermaid', svg: probe.innerHTML });
      })
      .catch((err: unknown) => {
        // loud on purpose: an index mismatch means a Mermaid DOM change (RISK-32 trigger)
        if (err instanceof DiagramIndexError) console.error(err.message);
        else console.error('diagram: Mermaid render failed, using the built-in renderer', err);
        fallback();
      });
    return () => {
      live = false;
    };
    // render once per flow (UI-12 step 2): names are fixed by the immutable spec
  }, [flow]);
  return (
    <div className="dg-block" data-flow={flow.flowId}>
      <p className="dg-block-title">{title}</p>
      {mode.kind === 'pending' ? (
        <div className="dg-skeleton" aria-hidden="true">
          {flow.lifelines.map((l) => (
            <Skeleton key={l} height="2rem" />
          ))}
        </div>
      ) : mode.kind === 'mermaid' ? (
        <MermaidSvg
          svg={mode.svg}
          flow={flow}
          states={states}
          selected={selected}
          onSelect={onSelect}
        />
      ) : (
        <BuiltinSequence
          flow={flow}
          names={names}
          states={states}
          selected={selected}
          deliveryStep={deliveryStep}
          onSelect={onSelect}
          onDelivery={onDelivery}
        />
      )}
    </div>
  );
}

const NO_BASES: Record<string, FlowDefinition> = {};

/** The sequence diagram pane: one diagram per flow, drawn once with Mermaid when it is available and passes its integrity check, else by the built-in SVG renderer. Run events only change state attributes; the diagram is never redrawn. */
export function DiagramPane({
  flows,
  view,
  events,
  names,
  selected,
  deliveryStep,
  onSelect,
  onDelivery,
}: {
  flows: RunFlows;
  view: RunView;
  events: readonly EventEnvelope[];
  names: Record<string, string>;
  selected: string | null;
  /** the stepKey whose `deliver-*` event exists (QR icon, UI-16) */
  deliveryStep: string | null;
  onSelect: (stepKey: string) => void;
  onDelivery: () => void;
}) {
  const bases = flows.bases ?? NO_BASES;
  const blocks = useMemo(() => {
    const out: { title: string; flow: DiagramFlow }[] = [];
    const add = (def: FlowDefinition | null, title: string) => {
      if (def)
        out.push({
          title,
          flow: diagramFlow(def, def.extends ? (bases[def.extends] ?? null) : null),
        });
    };
    add(flows.issuance, c.issue);
    add(flows.presentation, c.present);
    return out;
  }, [flows, bases]);
  const states = useMemo(() => {
    const all = new Map<string, StepDiagramState>();
    for (const b of blocks) for (const [k, v] of diagramStates(b.flow, view, events)) all.set(k, v);
    return all;
  }, [blocks, view, events]);
  const [fallbacks, setFallbacks] = useState<string[]>([]);
  const reduced = useReducedMotion();
  const motion = !reduced && !isTerminal(view);
  return (
    <div className="diagram" data-motion={motion ? 'on' : 'off'}>
      <div className="dg-toolbar">
        <ul className="dg-legend" aria-label={c.legend}>
          <li data-state="pass">{c.pass}</li>
          <li data-state="fail">{c.fail}</li>
          <li data-state="skipped">{c.skipped}</li>
          <li data-state="pending">{c.pending}</li>
        </ul>
        {fallbacks.length > 0 ? (
          <p className="dg-notice muted small" data-testid="diagram-fallback">
            {c.builtin}
          </p>
        ) : null}
      </div>
      {blocks.map((b) => (
        <SequenceBlock
          key={b.flow.flowId}
          title={b.title}
          flow={b.flow}
          names={names}
          states={states}
          selected={selected}
          deliveryStep={deliveryStep}
          onSelect={onSelect}
          onDelivery={onDelivery}
          onFallback={(id) => setFallbacks((f) => (f.includes(id) ? f : [...f, id]))}
        />
      ))}
    </div>
  );
}
