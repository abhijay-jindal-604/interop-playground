/**
 * The built-in SVG renderer (ADR-40 fallback, RISK-32): draws the same flow model as the Mermaid
 * path, one lifeline per column and one row per message in definition order, so the diagram keeps
 * working when Mermaid is missing, throws, or fails the integrity check. `aria-hidden`: the StepRail
 * is the accessible twin (UI-13).
 */
import type { DiagramFlow, DiagramMessage, MessageState, StepDiagramState } from './model.js';

const COL = 150;
const HEAD = 40;
const ROW = 30;
const SELF = 38;

function suffix(st: StepDiagramState | undefined, m: DiagramMessage): string {
  if (!st || m.part !== 0) return '';
  const bits: string[] = [];
  if (st.capture === 'partial') bits.push('Partial');
  if (st.capture === 'none') bits.push('Engine');
  if (st.checks > 0) bits.push(`${st.checks} check${st.checks === 1 ? '' : 's'}`);
  if (st.pollTotal && st.pollTotal > 1) bits.push(`×${st.pollTotal}`);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

/** Fallback renderer: draws the flow as SVG (one lifeline per actor, one row per message) when Mermaid is unavailable. */
export function BuiltinSequence({
  flow,
  names,
  states,
  selected,
  deliveryStep,
  onSelect,
  onDelivery,
}: {
  flow: DiagramFlow;
  names: Record<string, string>;
  states: Map<string, StepDiagramState>;
  selected: string | null;
  deliveryStep: string | null;
  onSelect: (stepKey: string) => void;
  onDelivery: () => void;
}) {
  const xOf = (l: string) => COL / 2 + Math.max(0, flow.lifelines.indexOf(l as never)) * COL;
  const width = flow.lifelines.length * COL;
  let y = HEAD + 24;
  const rows = flow.messages.map((m) => {
    const self = m.from === m.to;
    const at = y;
    y += self ? SELF : ROW;
    return { m, y: at, self };
  });
  const height = y + 8;
  return (
    <svg
      className="dg-svg"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      aria-hidden="true"
      focusable="false"
      data-renderer="builtin"
    >
      <g className="dg-decor">
        {flow.lifelines.map((l, i) => (
          <rect
            key={l}
            className={`dg-lane dg-lane-${i % 2 === 0 ? 'even' : 'odd'}`}
            x={i * COL}
            y={0}
            width={COL}
            height={height}
          />
        ))}
      </g>
      {flow.lifelines.map((l) => (
        <g key={l} className="dg-lifeline">
          <line x1={xOf(l)} x2={xOf(l)} y1={HEAD} y2={height - 4} />
          <rect x={xOf(l) - COL / 2 + 6} y={6} width={COL - 12} height={HEAD - 12} rx={4} />
          <text x={xOf(l)} y={HEAD / 2 + 4} textAnchor="middle">
            {cutName(names[l] ?? l)}
          </text>
        </g>
      ))}
      {rows.map(({ m, y: ry, self }) => {
        const st = states.get(m.stepKey);
        const state: MessageState = st?.messageStates[m.part] ?? 'pending';
        const label = (st?.labels[m.part] ?? m.template) + suffix(st, m);
        const title =
          (st?.titles[m.part] ?? m.template) +
          (st?.state === 'skipped' && st.skipReason ? `. Skipped: ${st.skipReason}` : '');
        const x1 = xOf(m.from);
        const x2 = xOf(m.to);
        const dir = x2 >= x1 ? 1 : -1;
        const tx = self ? x1 + 30 : Math.min(Math.max((x1 + x2) / 2, 150), width - 150);
        const path = self ? `M${x1} ${ry} h24 v14 h-22` : `M${x1} ${ry} H${x2 - dir * 6}`;
        const end = self ? { x: x1 + 2, y: ry + 14, d: -1 } : { x: x2, y: ry, d: dir };
        const isDelivery = deliveryStep === m.stepKey && m.part === 0;
        return (
          <g
            key={m.index}
            className={`dg-msg${selected === m.stepKey ? ' is-selected' : ''}`}
            data-msg={m.index}
            data-step={m.stepKey}
            data-state={state}
            data-step-state={st?.state ?? 'pending'}
            data-dashed={m.dashed || undefined}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(m.stepKey);
            }}
          >
            <title>{title}</title>
            <rect
              className="dg-hit dg-row"
              x={0}
              y={ry - 18}
              width={width}
              height={self ? SELF : ROW}
              rx={4}
            />
            <path className="dg-line" d={path} />
            <path className="dg-head" d={`M${end.x} ${end.y} l${-end.d * 7} -4 v8 z`} />
            {state === 'active' ? <circle className="dg-spin" cx={x1} cy={ry} r={4} /> : null}
            <text
              className="dg-num"
              x={x1 + (self ? -4 : dir * 4)}
              y={self ? ry - 4 : ry + 11}
              textAnchor={self || dir < 0 ? 'end' : 'start'}
            >
              {m.index + 1}
            </text>
            <text
              className="dg-label"
              x={tx}
              y={self ? ry + 4 : ry - 6}
              textAnchor={self ? 'start' : 'middle'}
            >
              {label}
            </text>
            {isDelivery ? (
              <g
                className="dg-qr"
                data-action="delivery"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelivery();
                }}
              >
                <rect x={x1 + dir * 10 - 7} y={ry + 3} width={14} height={14} rx={2} />
                <path
                  d={`M${x1 + dir * 10 - 4} ${ry + 6}h3v3h-3z M${x1 + dir * 10 + 1} ${ry + 6}h3v3h-3z M${x1 + dir * 10 - 4} ${ry + 11}h3v3h-3z M${x1 + dir * 10 + 1} ${ry + 11}h3v3h-3z`}
                />
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

const cutName = (s: string): string => (s.length > 22 ? `${s.slice(0, 21)}…` : s);
