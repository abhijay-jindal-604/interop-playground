/**
 * `ui.angle` (plan/12 T-45, 06 UI-07, UI-24..UI-28): the four diagnosis cases, the fix-it panel only
 * for an exact cause (no confirm dialog, one derive call, navigation to the child), the child banner
 * and result card (the word "fixed" only for `fixed`), the compact strip with the knob's direct
 * effect first, the lineage strip, all six `deviatingSide` values (G-151), and the knobs panel.
 * API-24/30/31/33 answer from the fixtures of test/angle-fixtures.ts.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompareResponse,
  DiagnosisResponse,
  EventEnvelope,
  Run,
} from '@interop-playground/api';
import { ApiError, setFetcher } from '../api/client.js';
import { reduceAll } from '../run/reduce.js';
import { RunScreen } from '../run/RunScreen.js';
import { initialState, store } from '../state/store.js';
import {
  CHILD_ID,
  CHILD_LINEAGE,
  CLAIM,
  EXACT_DIAGNOSIS,
  KNOB01,
  OBSERVED_DIAGNOSIS,
  PARENT_ID,
  PARENT_LINEAGE,
  POSSIBLE_DIAGNOSIS,
  UNCLASSIFIED_DIAGNOSIS,
  childCompare,
} from '../test/angle-fixtures.js';
import { fixtureFlows, logFixture } from '../test/run-fixtures.js';
import { ChildResultCard, CompareStrip, LineageStrip } from './ChildRun.js';
import { DiagnosisCard } from './DiagnosisCard.js';
import { applicableKnobs, changedKnobs, KnobsPanel } from './KnobsPanel.js';
import { SIDE_WORD, diagnosisCase, fixItDecision, orderCompareRows, sideWord } from './model.js';

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
const notFound = () =>
  json(
    { error: { code: 'not_found', message: 'x', status: 404, requestId: 'R', retryable: false } },
    404,
  );

const calls: { method: string; path: string; body: unknown; key: string | null }[] = [];
function serve(map: Record<string, unknown>) {
  calls.length = 0;
  setFetcher((input, init) => {
    const url = new URL(input, 'http://x');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      key: headers.get('Idempotency-Key'),
    });
    const body = map[`${method} ${url.pathname}`];
    return body === undefined ? notFound() : json(body, method === 'POST' ? 201 : 200);
  });
}

function ChildProbe() {
  const { runId } = useParams();
  return <p data-testid="child-page">{runId}</p>;
}

function card(diagnosis: DiagnosisResponse, origin: Run['origin'] = 'local', outcome = 'fail') {
  render(
    <MemoryRouter initialEntries={['/runs/P']}>
      <Routes>
        <Route
          path="/runs/P"
          element={
            <DiagnosisCard
              runId={PARENT_ID}
              diagnosis={diagnosis}
              origin={origin}
              outcome={outcome}
              failingStepKey="vp.verdict.evaluate"
              failingCheck={
                {
                  checkId: 'vc.signature',
                  outcome: 'fail',
                  source: 'verifier-response',
                  code: 'ERR_SIGNATURE_VERIFICATION_FAILED',
                  message: 'getX509CertChain failed',
                  specClause: 'SD-JWT VC §2.5',
                } as never
              }
              knobs={[KNOB01]}
              peerName={() => 'walt.id issuer'}
            />
          }
        />
        <Route path="/runs/:runId" element={<ChildProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  store.set(() => ({
    ...initialState(),
    catalog: { ...initialState().catalog, knobs: { status: 'ready', data: { knobs: [KNOB01] } } },
  }));
  serve({});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ui.angle model', () => {
  it('decides the four cases from role:cause matches only', () => {
    expect(diagnosisCase(EXACT_DIAGNOSIS).kind).toBe('exact');
    expect(diagnosisCase(UNCLASSIFIED_DIAGNOSIS).kind).toBe('unclassified');
    expect(diagnosisCase(POSSIBLE_DIAGNOSIS).kind).toBe('possible');
    expect(diagnosisCase(OBSERVED_DIAGNOSIS).kind).toBe('observed');
    const findingOnly = { matches: [{ ...EXACT_DIAGNOSIS.matches[0]!, role: 'finding' as const }] };
    expect(diagnosisCase(findingOnly).kind).toBe('unclassified');
  });

  it('offers the fix only for an exact cause on a local failed run', () => {
    const v = diagnosisCase(EXACT_DIAGNOSIS);
    expect(
      fixItDecision(EXACT_DIAGNOSIS, v, { origin: 'local', outcome: 'fail' }).offer,
    ).not.toBeNull();
    expect(fixItDecision(EXACT_DIAGNOSIS, v, { origin: 'imported', outcome: 'fail' })).toEqual({
      offer: null,
      noFix: 'imported',
    });
    expect(
      fixItDecision(EXACT_DIAGNOSIS, v, { origin: 'local', outcome: 'pass' }).offer,
    ).toBeNull();
    const chain = { ...EXACT_DIAGNOSIS, offers: [{ ...EXACT_DIAGNOSIS.offers[0]!, chain: [] }] };
    expect(fixItDecision(chain, v, { origin: 'local', outcome: 'fail' }).offer).toBeNull();
    const p = diagnosisCase(POSSIBLE_DIAGNOSIS);
    expect(fixItDecision(POSSIBLE_DIAGNOSIS, p, { origin: 'local', outcome: 'fail' }).noFix).toBe(
      'several-causes',
    );
  });

  it('names all six deviating sides (G-151)', () => {
    expect(Object.keys(SIDE_WORD).sort()).toEqual(
      ['environment', 'issuer', 'issuer+verifier', 'playground', 'verifier', 'wallet'].sort(),
    );
    expect(sideWord('issuer+verifier')).toBe('Issuer and verifier');
    expect(sideWord('environment')).toBe('Environment');
  });

  it('orders the strip: direct effect first, then changed, unchanged apart (volatile ignored)', () => {
    const { shown, unchanged } = orderCompareRows(childCompare({}, {}).steps);
    expect(shown.map((r) => r.stepKey)).toEqual(['vci.credential', 'vp.verdict.evaluate']);
    expect(unchanged.map((r) => r.stepKey)).toEqual(['vci.token']);
  });
});

describe('ui.angle DiagnosisCard + FixItPanel (UI-24, UI-25)', () => {
  it('exact: heading, side and component, one click derives with no confirm dialog', async () => {
    serve({ [`POST /api/v1/runs/${PARENT_ID}/derive`]: { runId: CHILD_ID } });
    const confirm = vi.spyOn(window, 'confirm');
    card(EXACT_DIAGNOSIS);
    expect(
      screen.getByRole('heading', { level: 2, name: /^Diagnosis: Inji Verify cannot verify/ }),
    ).toBeTruthy();
    expect(screen.getByText('Exact match')).toBeTruthy();
    expect(screen.getByTestId('deviating-side').textContent).toBe(
      'Deviating side: Verifier: inji-verify (vc-verifier) 1.0-alpha.1',
    );
    // ADR-98/ADR-100: public evidence is the fingerprint file, never a research S-ID
    expect(screen.getByText('fingerprints/FP-01.json')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/S-\d{3}/);
    const panel = screen.getByRole('region', { name: 'Fix it and re-run' });
    expect(within(panel).getByText('waltid.sdjwt.x5c')).toBeTruthy();
    expect(within(panel).getByText(/component, not of Inji/).textContent).toContain(
      'walt.id issuer',
    );
    const button = within(panel).getByRole('button', { name: 'Fix it and re-run' });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByTestId('child-page');
    expect(screen.getByTestId('child-page').textContent).toBe(CHILD_ID);
    const derives = calls.filter((x) => x.method === 'POST');
    expect(derives).toHaveLength(1);
    expect(derives[0]).toMatchObject({ body: { knobId: 'KNOB-01', value: 'present' } });
    expect(derives[0]?.key).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('possible: every cause, no button, the several-causes line', () => {
    card(POSSIBLE_DIAGNOSIS);
    expect(screen.getByRole('heading', { level: 2, name: 'Possible causes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fix it and re-run' })).toBeNull();
    expect(screen.queryByTestId('fixit-panel')).toBeNull();
    expect(screen.getByText(/More than one known cause fits, so no single change/)).toBeTruthy();
    // first cause open, second collapsed; toggle opens it
    const toggles = screen.getAllByRole('button', { expanded: false });
    fireEvent.click(toggles[0]!);
    expect(screen.getAllByTestId('deviating-side').map((n) => n.textContent)).toContain(
      'Deviating side: Issuer and verifier: waltid-issuer-api 0.18.2',
    );
  });

  it('unclassified: the failing check verbatim, no button', () => {
    card(UNCLASSIFIED_DIAGNOSIS);
    expect(screen.getByRole('heading', { level: 2, name: 'No known cause matched' })).toBeTruthy();
    expect(
      screen.getByText(/vc.signature ERR_SIGNATURE_VERIFICATION_FAILED: getX509CertChain/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fix it and re-run' })).toBeNull();
    expect(screen.getByText(/No known cause matched, so there is nothing to re-run/)).toBeTruthy();
  });

  it('observed: no button; environment side', () => {
    card(OBSERVED_DIAGNOSIS);
    expect(screen.getByRole('heading', { level: 2, name: 'Observed, not diagnosed' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fix it and re-run' })).toBeNull();
    expect(screen.getByTestId('deviating-side').textContent).toMatch(
      /^Deviating side: Environment:/,
    );
  });

  it('imported run: no panel, the imported line', () => {
    card(EXACT_DIAGNOSIS, 'imported');
    expect(screen.queryByTestId('fixit-panel')).toBeNull();
    expect(screen.getByText(/Imported runs cannot be re-run/)).toBeTruthy();
  });

  it('version_drift replaces the panel by the drift line', async () => {
    setFetcher(() =>
      json(
        {
          error: {
            code: 'version_drift',
            message: 'x',
            status: 409,
            requestId: 'R',
            retryable: false,
            details: { column: 'verifier', was: '1.0', now: '1.1' },
          },
        },
        409,
      ),
    );
    card(EXACT_DIAGNOSIS);
    fireEvent.click(screen.getByRole('button', { name: 'Fix it and re-run' }));
    await screen.findByText(/the verifier version changed since this run \(1.0 to 1.1\)/);
    expect(screen.queryByTestId('fixit-panel')).toBeNull();
  });
});

function child(
  classification: 'fixed' | 'moved' | 'not-fixed' | 'inconclusive',
  compare: CompareResponse | 'gone',
) {
  render(
    <MemoryRouter>
      <ChildResultCard
        childRunId={CHILD_ID}
        parentRunId={PARENT_ID}
        classification={classification}
        delta={{ knobId: 'KNOB-01', from: 'absent', to: 'present' }}
        knobs={[KNOB01]}
        compare={
          compare === 'gone'
            ? {
                status: 'error',
                error: new ApiError({
                  code: 'not_found',
                  message: 'x',
                  status: 404,
                  requestId: 'R',
                  retryable: false,
                }),
              }
            : { status: 'ready', data: compare }
        }
        fingerprintId="FP-01"
        childFailingCheckId="vp.kb-jwt.aud"
      />
    </MemoryRouter>,
  );
}

describe('ui.angle child run (UI-26..UI-28)', () => {
  it('fixed: the claim sentence verbatim and the compare link (parent first)', () => {
    child('fixed', childCompare({}, {}));
    expect(screen.getByRole('heading', { name: 'The change fixed it.' })).toBeTruthy();
    expect(screen.getByTestId('claim').textContent).toBe(CLAIM);
    expect(
      screen.getByRole('link', { name: 'Compare with run PPPPPPPP' }).getAttribute('href'),
    ).toBe(`/runs/${PARENT_ID}/compare/${CHILD_ID}`);
    expect(screen.getByRole('button', { name: 'Copy claim sentence' })).toBeTruthy();
  });

  for (const k of ['moved', 'not-fixed', 'inconclusive'] as const) {
    it(`${k}: never says fixed, proved or the fix works`, () => {
      const cmp = { ...childCompare({}, {}), classification: k, claimSentence: null };
      child(k, cmp);
      const text = screen.getByTestId('child-result').textContent?.toLowerCase() ?? '';
      expect(text).not.toMatch(/\bfixed\b|proved|the fix works/);
      expect(screen.queryByTestId('claim')).toBeNull();
    });
  }

  it('parent deleted: chip and heading, the deleted line, no buttons', () => {
    child('fixed', 'gone');
    expect(
      screen.getByText('The parent run was deleted, so the comparison is no longer available.'),
    ).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('the compact strip requests nothing until opened, shows the direct effect first', () => {
    const onRetry = vi.fn();
    render(
      <MemoryRouter>
        <CompareStrip
          parentRunId={PARENT_ID}
          childRunId={CHILD_ID}
          delta={{ knobId: 'KNOB-01', from: 'absent', to: 'present' }}
          knobs={[KNOB01]}
          compare={{ status: 'ready', data: childCompare({}, {}) }}
          stepLabel={(k) => k}
          onRetry={onRetry}
          onDiffers={() => undefined}
        />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole('button', { name: 'Compare with run PPPPPPPP' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]?.getAttribute('data-step-row')).toBe('vci.credential');
    expect(rows[0]?.textContent).toContain('Changed by the fix');
    expect(rows[0]?.querySelector('.compare-direct')?.getAttribute('title')).toBe('KNOB-01');
    expect(rows).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 unchanged steps' }));
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(screen.getByText(/Volatile fields such as nonces/)).toBeTruthy();
  });

  it('the lineage strip renders only for a chain, marks the current run', () => {
    const { unmount } = render(
      <MemoryRouter>
        <LineageStrip runId={PARENT_ID} lineage={PARENT_LINEAGE} knobs={[KNOB01]} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('navigation', { name: 'Re-run chain' })).toBeNull();
    unmount();
    render(
      <MemoryRouter>
        <LineageStrip runId={CHILD_ID} lineage={CHILD_LINEAGE} knobs={[KNOB01]} />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Re-run chain' });
    expect(nav.textContent).toContain('waltid.sdjwt.x5c absent → present · Fixed');
    expect(within(nav).getAllByRole('listitem')[1]?.getAttribute('aria-current')).toBe('step');
  });
});

describe('ui.angle on the run screen (UI-09 diagnosis region)', () => {
  const asRun = (events: EventEnvelope[], runId: string, extra: Partial<Run> = {}): Run => {
    const created = events[0] as EventEnvelope<'run.created'>;
    return {
      runId,
      spec: created.payload.spec,
      state: 'completed',
      origin: 'local',
      links: { parentRunId: null, controlRunId: null, childRunIds: [] },
      ...extra,
    } as Run;
  };

  it('a failed parent loads API-30 and API-33 and shows the exact card', async () => {
    const f = logFixture('FLOW-30-fail');
    serve({
      [`GET /api/v1/runs/${f.runId}/diagnosis`]: EXACT_DIAGNOSIS,
      [`GET /api/v1/runs/${f.runId}/lineage`]: PARENT_LINEAGE,
    });
    render(
      <MemoryRouter>
        <RunScreen
          view={reduceAll(f.events)}
          events={f.events}
          flows={{ status: 'ready', flows: fixtureFlows(f) }}
          run={asRun(f.events, f.runId)}
          stream={null}
          onRetryLive={() => undefined}
          onCancel={() => undefined}
        />
      </MemoryRouter>,
    );
    await screen.findByTestId('diagnosis-card');
    expect(screen.getByRole('button', { name: 'Fix it and re-run' })).toBeTruthy();
    expect(calls.map((x) => x.path)).toEqual(
      expect.arrayContaining([
        `/api/v1/runs/${f.runId}/diagnosis`,
        `/api/v1/runs/${f.runId}/lineage`,
      ]),
    );
    // "Show the failing check" selects the failing step in the inspector's Checks tab
    fireEvent.click(screen.getByRole('button', { name: 'Show the failing check' }));
    await waitFor(() => expect(window.location.hash).toContain('step='));
  });

  it('a derived child shows the banner, the fixed card from API-31 and the lineage strip', async () => {
    const f = logFixture('FLOW-30-pass');
    const delta = { knobId: 'KNOB-01', from: 'absent', to: 'present' } as const;
    const events = f.events.map((e, i): EventEnvelope => {
      if (i === 0) {
        const p = (e as EventEnvelope<'run.created'>).payload;
        return {
          ...e,
          payload: {
            ...p,
            spec: {
              ...p.spec,
              parentRunId: PARENT_ID,
              knobDelta: delta,
              causeFingerprintId: 'FP-01' as const,
            },
          },
        };
      }
      if (e.type === 'run.completed')
        return {
          ...e,
          payload: { ...(e.payload as object), counterfactualResult: 'fixed' },
        } as EventEnvelope;
      return e;
    });
    serve({
      [`GET /api/v1/runs/${PARENT_ID}/compare/${f.runId}`]: childCompare({}, {}),
      [`GET /api/v1/runs/${f.runId}/lineage`]: CHILD_LINEAGE,
    });
    render(
      <MemoryRouter>
        <RunScreen
          view={reduceAll(events)}
          events={events}
          flows={{ status: 'ready', flows: fixtureFlows(f) }}
          run={asRun(events, f.runId, { counterfactualResult: 'fixed' })}
          stream={null}
          onRetryLive={() => undefined}
          onCancel={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('child-banner').textContent).toBe(
      'Re-run of PPPPPPPP: waltid.sdjwt.x5c absent → present',
    );
    expect((await screen.findByTestId('claim')).textContent).toBe(CLAIM);
    // a passing child is not diagnosed (API-30 is never called)
    expect(calls.some((x) => x.path.endsWith('/diagnosis'))).toBe(false);
    expect(calls.some((x) => x.path === `/api/v1/runs/${PARENT_ID}/compare/${f.runId}`)).toBe(true);
    await screen.findByRole('navigation', { name: 'Re-run chain' });
  });
});

describe('ui.angle knobs panel (UI-07)', () => {
  it('lists only applicable knobs and sends only non-defaults', () => {
    expect(applicableKnobs([KNOB01], ['issuer.certify-preauth'] as never, 'dc+sd-jwt')).toEqual([]);
    expect(applicableKnobs([KNOB01], ['issuer.waltid'] as never, 'ldp_vc')).toEqual([]);
    expect(applicableKnobs([KNOB01], ['issuer.waltid'] as never, 'dc+sd-jwt')).toHaveLength(1);
    expect(changedKnobs({ 'KNOB-01': 'absent' }, [KNOB01])).toEqual({});
    expect(changedKnobs({ 'KNOB-01': 'present' }, [KNOB01])).toEqual({ 'KNOB-01': 'present' });
  });

  it('renders the row with default first, status chip, label and summary', () => {
    const onChoice = vi.fn();
    const { rerender } = render(
      <KnobsPanel
        adapters={['issuer.waltid', 'wallet.playground-ts'] as never}
        format="dc+sd-jwt"
        choice={{}}
        label=""
        onChoice={onChoice}
        onLabel={() => undefined}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Advanced options' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const select = screen.getByLabelText('waltid.sdjwt.x5c');
    expect([...(select as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      'absent (default)',
      'present',
    ]);
    expect(screen.getByText('Proven')).toBeTruthy();
    expect(screen.getByText('changed walt.id issuance option')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'present' } });
    expect(onChoice).toHaveBeenCalledWith({ 'KNOB-01': 'present' });
    rerender(
      <KnobsPanel
        adapters={['issuer.waltid', 'wallet.playground-ts'] as never}
        format="dc+sd-jwt"
        choice={{ 'KNOB-01': 'present' }}
        label=""
        onChoice={onChoice}
        onLabel={() => undefined}
      />,
    );
    expect(screen.getByText(/1 setting\(s\) differ from the defaults/)).toBeTruthy();
  });
});
