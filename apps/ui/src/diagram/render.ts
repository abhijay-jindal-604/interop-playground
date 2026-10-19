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
      sequence: { showSequenceNumbers: true, mirrorActors: false },
    });
    return m;
  });
  return loaded;
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
