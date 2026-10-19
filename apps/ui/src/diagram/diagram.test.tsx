/**
 * `ui.diagram` (plan/12 T-29 acceptance): a render test per slice flow (FLOW-01, FLOW-04, FLOW-30)
 * from the recorded logs; a message-count mismatch fails the index check loudly and falls back; a
 * forced fallback shows "Using the built-in diagram renderer."; reduced motion disables animation;
 * `skipped` steps are greyed with their reason. Plus the UI-16 Delivery dialog trigger.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@interop-playground/api';
import { reduceAll } from '../run/reduce.js';
import { RunScreen } from '../run/RunScreen.js';
import {
  fixtureFlows,
  flowFile,
  logFixture,
  prefix,
  type FixtureId,
} from '../test/run-fixtures.js';
import {
  diagramFlow,
  diagramStates,
  expectedMessageCount,
  lifelineNames,
  mermaidText,
} from './model.js';
import { MERMAID_VERSION, setMermaidLoader, type MermaidApi } from './render.js';

const NOTICE = 'Using the built-in diagram renderer.';

function show(id: FixtureId, events?: EventEnvelope[]) {
  const f = logFixture(id);
  const flows = fixtureFlows(f);
  const view = reduceAll(events ?? f.events);
  render(
    <MemoryRouter>
      <RunScreen
        view={view}
        events={events ?? f.events}
        flows={{ status: 'ready', flows }}
        run={null}
        stream={null}
        onRetryLive={() => {}}
        onCancel={() => {}}
      />
    </MemoryRouter>,
  );
  return { flows, view };
}

const block = (flowId: string) =>
  document.querySelector<HTMLElement>(`.dg-block[data-flow="${flowId}"]`);
const msgs = (flowId: string, sel = '[data-msg]') => [
  ...(block(flowId)?.querySelectorAll<SVGElement>(sel) ?? []),
];

/** a stand-in Mermaid that draws `n` message lines (the real 11.17.2 needs layout, absent in jsdom) */
function fakeMermaid(lines: (text: string) => number): MermaidApi {
  return {
    initialize: () => undefined,
    render: (_id, text) => {
      const n = lines(text);
      const body = Array.from(
        { length: n },
        (_, i) =>
          `<line class="messageLine${i % 2}" x1="0" x2="10" y1="${i}" y2="${i}"></line>` +
          `<text class="messageText">m${i}</text>`,
      ).join('');
      return Promise.resolve({ svg: `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>` });
    },
  };
}
const arrowsIn = (text: string) => text.split('\n').filter((l) => /->>|-->>/.test(l)).length;

function mockMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/runs/x');
  setMermaidLoader(null);
  mockMotion(false);
});
afterEach(() => {
  cleanup();
  setMermaidLoader(null);
  vi.restoreAllMocks();
});

describe('ui.diagram model', () => {
  it('pins Mermaid 11.17.2 (plan/10 §2, RISK-32)', () => {
    expect(MERMAID_VERSION).toBe('11.17.2');
  });

  for (const id of ['FLOW-01', 'FLOW-04', 'FLOW-30'] as const) {
    it(`${id}: messageIndex → stepKey follows the messages counts, Mermaid text has one arrow per message`, () => {
      const def = flowFile(id);
      const flow = diagramFlow(def, def.extends ? flowFile(def.extends) : null);
      expect(flow.index).toHaveLength(expectedMessageCount(flow));
      let at = 0;
      for (const s of flow.steps) {
        for (let k = 0; k < s.messages; k++) expect(flow.index[at++]).toBe(s.stepKey);
      }
      const text = mermaidText(flow, lifelineNames(null));
      expect(text.startsWith('sequenceDiagram\n  autonumber\n')).toBe(true);
      expect(arrowsIn(text)).toBe(expectedMessageCount(flow));
      for (const l of def.lifelines) expect(text).toContain(`participant ${l} as `);
    });
  }

  it('fills placeholders from the events: {channel}, response {status}', () => {
    const f = logFixture('FLOW-30-pass');
    const flow = diagramFlow(flowFile('FLOW-30'), null);
    const states = diagramStates(flow, reduceAll(f.events), f.events);
    expect(states.get('vp.request.deliver')?.labels[0]).toBe(
      'in-process: openid4vp://authorize?...',
    );
    expect(states.get('vp.request.create')?.labels[1]).toMatch(/^\d{3}$/);
  });
});

describe('ui.diagram render per slice flow (built-in renderer)', () => {
  it('FLOW-01 pass: every message drawn, skipped step greyed with its reason', async () => {
    const { flows } = show('FLOW-01-pass');
    await screen.findByText(NOTICE);
    const flow = diagramFlow(flows.issuance!, null);
    expect(msgs('FLOW-01')).toHaveLength(expectedMessageCount(flow));
    expect(block('FLOW-01')?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const token = msgs('FLOW-01', '[data-step="vci.token"]');
    expect(token.map((m) => m.getAttribute('data-state'))).toEqual(['pass', 'pass']);
    const variant = msgs('FLOW-01', '[data-step="vci.setup.variant"]');
    expect(variant[0]?.getAttribute('data-state')).toBe('skipped');
    expect(variant[0]?.querySelector('title')?.textContent).toContain('Skipped:');
  });

  it('FLOW-04 + FLOW-30 pass: merged delta steps and the presentation block', async () => {
    const { flows } = show('FLOW-30-pass');
    await screen.findByText(NOTICE);
    const issuance = diagramFlow(flows.issuance!, flowFile('FLOW-01'));
    const presentation = diagramFlow(flows.presentation!, null);
    expect(msgs('FLOW-04')).toHaveLength(expectedMessageCount(issuance));
    expect(msgs('FLOW-30')).toHaveLength(expectedMessageCount(presentation));
    expect(
      msgs('FLOW-04', '[data-step="vci.credential.inspect"] .dg-label')[0]?.textContent,
    ).toContain('decode SD-JWT');
    const fetch = msgs('FLOW-30', '[data-step="vp.request.fetch"]');
    expect(fetch.map((m) => m.getAttribute('data-state'))).toEqual(['skipped', 'skipped']);
    expect(fetch[0]?.querySelector('title')?.textContent).toContain('request carried by value');
    expect(
      msgs('FLOW-30', '[data-step="vp.verdict.evaluate"]')[0]?.getAttribute('data-state'),
    ).toBe('pass');
  });

  it('FLOW-30 fail: the failing step is drawn as fail; clicking an arrow selects the step', async () => {
    show('FLOW-30-fail');
    await screen.findByText(NOTICE);
    const post = msgs('FLOW-30', '[data-step="vp.response.post"]');
    expect(post[0]?.getAttribute('data-state')).toBe('fail');
    fireEvent.click(post[0]!);
    expect(window.location.hash).toBe('#step=vp.response.post');
    const rail = screen.getByRole('navigation', { name: 'Steps' });
    expect(rail.querySelector('[aria-current="true"]')?.getAttribute('data-step')).toBe(
      'vp.response.post',
    );
  });

  it('a live run: running step active, unreached steps pending; terminal freezes them as Not reached', async () => {
    const f = logFixture('FLOW-30-pass');
    const live = prefix(f.events, (e) => e.type === 'step.started' && e.stepKey === 'vci.token');
    show('FLOW-30-pass', live);
    await screen.findByText(NOTICE);
    expect(msgs('FLOW-04', '[data-step="vci.token"]')[0]?.getAttribute('data-state')).toBe(
      'active',
    );
    expect(msgs('FLOW-30', '[data-step="vp.result.poll"]')[0]?.getAttribute('data-state')).toBe(
      'pending',
    );
    expect(document.querySelector('.diagram')?.getAttribute('data-motion')).toBe('on');
    cleanup();
    const cancelled = [
      ...live,
      {
        ...live.at(-1)!,
        seq: live.at(-1)!.seq + 1,
        type: 'run.cancelled',
        stepKey: undefined,
        payload: { reason: 'user', atStepKey: 'vci.token' },
      } as unknown as EventEnvelope,
    ];
    show('FLOW-30-pass', cancelled);
    await screen.findByText(NOTICE);
    const poll = msgs('FLOW-30', '[data-step="vp.result.poll"]')[0];
    expect(poll?.getAttribute('data-state')).toBe('skipped');
    expect(poll?.querySelector('title')?.textContent).toContain('Skipped: Cancelled');
  });
});

describe('ui.diagram Mermaid path and the integrity check (RISK-32)', () => {
  it('a matching SVG is used and every message line carries its stepKey', async () => {
    setMermaidLoader(() => Promise.resolve(fakeMermaid(arrowsIn)));
    const { flows } = show('FLOW-30-pass');
    await waitFor(() =>
      expect(document.querySelectorAll('[data-renderer="mermaid"]')).toHaveLength(2),
    );
    expect(screen.queryByText(NOTICE)).toBeNull();
    const flow = diagramFlow(flows.presentation!, null);
    const lines = [...(block('FLOW-30')?.querySelectorAll('.messageLine0, .messageLine1') ?? [])];
    expect(lines.map((l) => l.getAttribute('data-step'))).toEqual(flow.index);
    const at = flow.index.indexOf('vp.request.fetch');
    expect(lines[at]?.getAttribute('data-state')).toBe('skipped');
  });

  it('a message-count mismatch fails loudly and the built-in renderer takes over', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setMermaidLoader(() => Promise.resolve(fakeMermaid((t) => arrowsIn(t) - 1)));
    show('FLOW-30-pass');
    await screen.findByText(NOTICE);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^diagram index check failed for FLOW-30: 29 message lines in the SVG, 30 in the flow file$/,
      ),
    );
    expect(document.querySelectorAll('[data-renderer="mermaid"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-renderer="builtin"]')).toHaveLength(2);
  });

  it('forced fallback (Mermaid throws) renders with the notice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setMermaidLoader(() =>
      Promise.resolve({
        initialize: () => undefined,
        render: () => Promise.reject(new Error('boom')),
      }),
    );
    show('FLOW-01-pass');
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(document.querySelectorAll('[data-renderer="builtin"]')).toHaveLength(1);
  });
});

describe('ui.diagram motion', () => {
  it('reduced motion disables animation on a live run', async () => {
    mockMotion(true);
    const f = logFixture('FLOW-30-pass');
    show(
      'FLOW-30-pass',
      prefix(f.events, (e) => e.type === 'step.started'),
    );
    await screen.findByText(NOTICE);
    expect(document.querySelector('.diagram')?.getAttribute('data-motion')).toBe('off');
  });

  it('a terminal run renders its final state without animation', async () => {
    show('FLOW-30-pass');
    await screen.findByText(NOTICE);
    expect(document.querySelector('.diagram')?.getAttribute('data-motion')).toBe('off');
  });
});

describe('ui.delivery dialog trigger (UI-16 "Where it appears")', () => {
  it('the deliver step row has a Delivery button that opens the dialog; Close returns focus', async () => {
    show('FLOW-30-pass');
    await screen.findByText(NOTICE);
    const rail = screen.getByRole('navigation', { name: 'Steps' });
    const buttons = within(rail).getAllByRole('button', { name: 'Delivery' });
    expect(buttons).toHaveLength(1);
    const opener = buttons[0]!;
    expect(opener.closest('li')?.querySelector('[data-step]')?.getAttribute('data-step')).toBe(
      'vp.request.deliver',
    );
    opener.focus();
    act(() => {
      fireEvent.click(opener);
    });
    const dialog = document.querySelector('dialog.delivery-dialog[open]')!;
    expect(dialog).not.toBeNull();
    expect(within(dialog as HTMLElement).getByRole('heading').textContent).toBe(
      'Verification request',
    );
    expect(dialog.querySelector('svg.qr')).not.toBeNull();
    act(() => {
      fireEvent.click(within(dialog as HTMLElement).getByRole('button', { name: 'Close' }));
    });
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('the QR icon on the deliver arrow opens the same dialog', async () => {
    show('FLOW-30-pass');
    await screen.findByText(NOTICE);
    const icon = block('FLOW-30')?.querySelector('[data-action="delivery"]');
    expect(icon).not.toBeNull();
    act(() => {
      fireEvent.click(icon!);
    });
    expect(document.querySelector('dialog.delivery-dialog[open] svg.qr')).not.toBeNull();
  });

  it('no delivery event yet: no Delivery button', async () => {
    show('FLOW-01-pass');
    await screen.findByText(NOTICE);
    expect(screen.queryByRole('button', { name: 'Delivery' })).toBeNull();
  });
});
