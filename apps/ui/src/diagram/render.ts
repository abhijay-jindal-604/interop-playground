/**
 * The pinned-Mermaid path of the sequence diagram (06 UI-12 rendering steps 2-3, ADR-40, RISK-32).
 * This is the only module that may reach Mermaid (plan/10 §2: pinned 11.17.2). The production loader
 * imports the pinned `mermaid` lazily (its own chunk, ADR-78); a loader that answers `null` or a
 * render that throws hands the flow to the built-in SVG renderer, with the toolbar line "Using the
 * built-in diagram renderer.". Tests swap the loader to exercise the integrity check (jsdom has no
 * layout, so the ui test setup installs the `null` loader).
 */
import { expectedMessageCount, mermaidText, type DiagramFlow } from './model.js';

export const MERMAID_VERSION = '11.17.2';

/** the part of the Mermaid API the diagram uses */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

type Loader = () => Promise<MermaidApi | null>;
const NOT_INSTALLED: Loader = () => Promise.resolve(null);
/** ADR-78: the pinned dependency, loaded on first use */
export const MERMAID_IMPORT: Loader = () =>
  import('mermaid').then((m) => m.default as unknown as MermaidApi);
let loader: Loader = MERMAID_IMPORT;
let loaded: Promise<MermaidApi | null> | null = null;

/** replace the Mermaid loader (tests); `null` = Mermaid unavailable */
export function setMermaidLoader(next: Loader | null): void {
  loader = next ?? NOT_INSTALLED;
  loaded = null;
}

function mermaid(): Promise<MermaidApi | null> {
  loaded ??= loader().then((m) => {
    m?.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'neutral',
      // ADR-129 ("Quiet"): system type, smaller heads and labels; colours come from run-screen.css
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
      sequence: {
        showSequenceNumbers: true,
        mirrorActors: false,
        actorFontSize: 14,
        actorFontWeight: 600,
        messageFontSize: 14,
        messageMargin: 18,
        boxMargin: 4,
        actorMargin: 48,
        width: 150,
        height: 40,
        diagramMarginX: 12,
        diagramMarginY: 8,
      },
    });
    return m;
  });
  return loaded;
}

/**
 * Starts loading the renderer ahead of the run screen (ADR-89): a live run finishes in ~2 s, which
 * is less than the lazy chunk's load time, so without this the diagram first appears already
 * terminal and never shows the run's progress. Same loader and cache as rendering.
 */
export function preloadMermaid(): void {
  void mermaid().catch(() => undefined);
}

/** the integrity check failed: the SVG's message lines do not match the flow file (RISK-32) */
export class DiagramIndexError extends Error {
  constructor(
    readonly flowId: string,
    readonly found: number,
    readonly expected: number,
  ) {
    super(
      `diagram index check failed for ${flowId}: ${found} message lines in the SVG, ` +
        `${expected} in the flow file`,
    );
    this.name = 'DiagramIndexError';
  }
}

/** message lines and their labels in document order (Mermaid 11 sequence classes) */
export function messageElements(root: ParentNode): { lines: Element[]; texts: Element[] } {
  return {
    lines: [...root.querySelectorAll('.messageLine0, .messageLine1')],
    texts: [...root.querySelectorAll('.messageText')],
  };
}

/**
 * UI-12 rendering step 3: the number of message lines must equal the sum of `messages`, and each
 * line is tagged with its `messageIndex` and stepKey. Throws `DiagramIndexError` on a mismatch.
 */
export function indexMessages(root: ParentNode, flow: DiagramFlow): Element[] {
  const { lines, texts } = messageElements(root);
  const expected = expectedMessageCount(flow);
  if (lines.length !== expected || texts.length !== expected)
    throw new DiagramIndexError(flow.flowId, lines.length, expected);
  lines.forEach((line, i) => {
    const key = flow.index[i] ?? '';
    line.setAttribute('data-msg', String(i));
    line.setAttribute('data-step', key);
    texts[i]?.setAttribute('data-msg', String(i));
    texts[i]?.setAttribute('data-step', key);
  });
  return lines;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const nums = (v: string | null): number[] =>
  (v ?? '')
    .match(/-?\d+(?:\.\d+)?/g)
    ?.map(Number)
    .filter((n) => Number.isFinite(n)) ?? [];

/**
 * ADR-119: paints a lane band behind each lifeline and a row band behind each message of the
 * indexed Mermaid SVG (inserted first, so they sit under the drawing). Rows carry `data-msg` and
 * `data-row-step` (not `data-step`, which stays on the message line and label) so `applyStates`
 * can tint the running, selected and failed rows, and a `dg-mark` circle under each sequence
 * number that carries the step's status (ADR-129). Purely decorative; the SVG stays aria-hidden.
 */
export function decorateLanes(root: ParentNode): void {
  const svg = root.querySelector('svg');
  if (!svg || svg.querySelector('.dg-decor')) return;
  const [vx = 0, vy = 0, vw = 0, vh = 0] = nums(svg.getAttribute('viewBox'));
  if (vw <= 0 || vh <= 0) return;
  const decor = document.createElementNS(SVG_NS, 'g');
  decor.setAttribute('class', 'dg-decor');
  // one band under each lifeline head, as wide as the head, down to the bottom of the drawing
  [...svg.querySelectorAll('rect.actor-top')].forEach((head, i) => {
    const x = Number(head.getAttribute('x'));
    const w = Number(head.getAttribute('width'));
    const y = Number(head.getAttribute('y'));
    if (![x, w, y].every(Number.isFinite)) return;
    const lane = document.createElementNS(SVG_NS, 'rect');
    lane.setAttribute('class', `dg-lane dg-lane-${i % 2 === 0 ? 'even' : 'odd'}`);
    lane.setAttribute('x', String(x));
    lane.setAttribute('y', String(y));
    lane.setAttribute('width', String(w));
    lane.setAttribute('height', String(Math.max(0, vy + vh - y)));
    lane.setAttribute('rx', '8');
    decor.appendChild(lane);
  });
  const { lines, texts } = messageElements(svg);
  lines.forEach((line, i) => {
    const ys =
      line.tagName.toLowerCase() === 'line'
        ? [Number(line.getAttribute('y1')), Number(line.getAttribute('y2'))]
        : nums(line.getAttribute('d')).filter((_, k) => k % 2 === 1);
    const ty = Number(texts[i]?.getAttribute('y'));
    const all = [...ys, ...(Number.isFinite(ty) ? [ty] : [])].filter((n) => Number.isFinite(n));
    if (all.length === 0) return;
    const top = Math.min(...all) - 6;
    const bottom = Math.max(...ys.filter((n) => Number.isFinite(n)), top + 12) + 10;
    const row = document.createElementNS(SVG_NS, 'rect');
    row.setAttribute('class', 'dg-row');
    row.setAttribute('x', String(vx));
    row.setAttribute('y', String(top));
    row.setAttribute('width', String(vw));
    row.setAttribute('height', String(bottom - top));
    row.setAttribute('rx', '6');
    row.setAttribute('data-msg', line.getAttribute('data-msg') ?? String(i));
    row.setAttribute('data-row-step', line.getAttribute('data-step') ?? '');
    decor.appendChild(row);
  });
  svg.insertBefore(decor, svg.firstChild);
  // ADR-129: a status marker per message, drawn over Mermaid's sequence-number circle and under
  // its number, so a step's outcome shows on the small marker while the arrow stays neutral
  const numbers = [...svg.querySelectorAll('text.sequenceNumber')];
  if (numbers.length !== lines.length) return;
  numbers.forEach((num, i) => {
    const x = Number(num.getAttribute('x'));
    const y = Number(num.getAttribute('y'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const mark = document.createElementNS(SVG_NS, 'circle');
    mark.setAttribute('class', 'dg-mark');
    mark.setAttribute('cx', String(x));
    mark.setAttribute('cy', String(y - 4));
    mark.setAttribute('r', '8');
    mark.setAttribute('data-msg', lines[i]?.getAttribute('data-msg') ?? String(i));
    num.parentNode?.insertBefore(mark, num);
  });
}

let seq = 0;
/** Mermaid's SVG text for one flow, or `null` when Mermaid is not available. Throws on a render error. */
export async function renderMermaid(
  flow: DiagramFlow,
  names: Record<string, string>,
): Promise<string | null> {
  const m = await mermaid();
  if (!m) return null;
  seq += 1;
  const { svg } = await m.render(`seq-${flow.flowId}-${seq}`, mermaidText(flow, names));
  return svg;
}
