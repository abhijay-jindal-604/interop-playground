/**
 * `ui.run-screen` (plan/12 T-27 acceptance, DoD-SCREEN 1): every UI-11 state renders its exact copy
 * from the recorded event-log fixtures (fixtures/events, T-10); live (SSE) and replay
 * (`?format=json` pages) of the same log reach the same reducer state; `#step=` selects a step.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope, EventPage, RunVerdict } from '@interop-playground/api';
import { setFetcher } from '../api/client.js';
import { replayRunLog, RunPage } from '../routes/RunPage.js';
import { StreamClient } from '../state/stream.js';
import { FakeEventSource } from '../test/fake-event-source.js';
import {
  append,
  fixtureFlows,
  logFixture,
  prefix,
  withoutTerminal,
  type FixtureId,
} from '../test/run-fixtures.js';
import type { FlowLoad } from './flows.js';
import { reduceAll, viewStateOf } from './reduce.js';
import { RunScreen } from './RunScreen.js';

function show(id: FixtureId, events?: EventEnvelope[]) {
  const f = logFixture(id);
  const flows: FlowLoad = { status: 'ready', flows: fixtureFlows(f) };
  const view = reduceAll(events ?? f.events);
  render(
    <MemoryRouter>
      <RunScreen
        view={view}
        flows={flows}
        run={null}
        stream={null}
        onRetryLive={() => {}}
        onCancel={() => {}}
      />
    </MemoryRouter>,
  );
  return { view, flows };
}

function withVerdict(id: FixtureId, patch: Partial<RunVerdict>): EventEnvelope[] {
  const f = logFixture(id);
  const last = f.events.at(-1) as EventEnvelope<'run.completed'>;
  return append(withoutTerminal(f.events), 'run.completed', {
    verdict: { ...last.payload.verdict, ...patch },
    counterfactualResult: null,
  });
}

const statusText = () =>
  screen
    .getAllByRole('status')
    .map((s) => s.textContent ?? '')
    .join(' ');
const resultText = () => screen.getByRole('region', { name: 'Result' }).textContent ?? '';
/** the verdict stamp's word key (ADR-137) */
const stampOfResult = () =>
  screen
    .getByRole('region', { name: 'Result' })
    .querySelector('.stamp')
    ?.getAttribute('data-stamp');

beforeEach(() => {
  window.history.replaceState(null, '', '/runs/x');
});
afterEach(() => cleanup());

describe('ui.run-screen UI-11 states', () => {
  it('queued (local and Collab reasons)', () => {
    const f = logFixture('FLOW-01-pass');
    const { view } = show('FLOW-01-pass', f.events.slice(0, 1));
    expect(viewStateOf(view, true)).toBe('queued');
    expect(statusText()).toContain(
      'Queued. At most 4 runs execute at once. You can leave this page; the run starts by itself.',
    );
    cleanup();
    const created = f.events[0] as EventEnvelope<'run.created'>;
    const collab = {
      ...created,
      payload: {
        ...created.payload,
        spec: {
          ...created.payload.spec,
          env: { issuer: 'local', wallet: 'local', verifier: 'collab' },
        },
      },
    } as EventEnvelope;
    show('FLOW-01-pass', [collab]);
    expect(statusText()).toContain('Queued. Only one run at a time can use the Collab sandbox.');
  });

  it('running: "Running. Step n of N: label."', () => {
    const f = logFixture('FLOW-30-pass');
    const events = prefix(
      f.events,
      (e) => e.type === 'step.started' && e.stepKey === 'vp.response.post',
    );
    const { view } = show('FLOW-30-pass', events);
    expect(viewStateOf(view, true)).toBe('running');
    expect(statusText()).toContain('Running. Step 18 of 31: Wallet sends the presentation.');
  });

  it('awaiting: "Waiting for you. {UI-15 heading}"', () => {
    const f = logFixture('FLOW-30-pass');
    const events = append(
      prefix(f.events, (e) => e.type === 'step.started' && e.stepKey === 'vp.response.post'),
      'engine.call',
      {
        engine: 'playground-ts',
        op: 'await-observation',
        inputSummary: null,
        outputSummary: { expects: ['presentation'], deadline: '2026-10-19T10:05:00.000Z' },
        durationMs: 0,
      },
      'vp.response.post',
    );
    const { view } = show('FLOW-30-pass', events);
    expect(viewStateOf(view, true)).toBe('awaiting');
    expect(statusText()).toContain('Waiting for you. Share the credential from your phone.');
  });

  it.each([
    ['user', 'Cancelled. You stopped this run. No verdict was recorded.'],
    ['suite', 'Cancelled. The suite this run belongs to was cancelled. No verdict was recorded.'],
    ['shutdown', 'Cancelled. The playground was shutting down. No verdict was recorded.'],
  ] as const)('cancelled (%s)', (reason, text) => {
    const f = logFixture('FLOW-30-pass');
    const events = append(withoutTerminal(f.events), 'run.cancelled', {
      reason,
      atStepKey: 'vp.result.poll',
    });
    show('FLOW-30-pass', events);
    expect(statusText()).toContain(text);
  });

  const lead =
    'Run error. This is a problem with the playground or an upstream service, not a protocol result.';
  it.each([
    [
      'env_not_ready',
      'inji-verify',
      `${lead} A service this run needs was not ready: inji-verify. Check the Environment page, then run again.`,
    ],
    [
      'sidecar_unavailable',
      'x',
      `${lead} The Inji library sidecar could not be reached. Check that the sidecar container is running, then run again.`,
    ],
    [
      'engine_exception',
      'IllegalStateException',
      `${lead} A library threw an exception outside a protocol step: IllegalStateException. The Engine tab shows it.`,
    ],
    [
      'ui_not_connected',
      'x',
      `${lead} This run uses the Verify SDK in the browser, and no request arrived from the page within 120 seconds. Keep this page open while the run starts, then run again.`,
    ],
    [
      'bff_restarted',
      'x',
      `${lead} The playground restarted while this run was in progress. Run it again.`,
    ],
    [
      'internal_error',
      'x',
      `${lead} The playground hit an unexpected error. Reference not given. Run it again; if it repeats, export the run and report it.`,
    ],
  ])('error (%s)', (errorCode, message, text) => {
    const f = logFixture('FLOW-01-pass');
    const events = append(withoutTerminal(f.events), 'run.failed', {
      errorCode,
      message,
      stepKey: null,
    });
    const { view } = show('FLOW-01-pass', events);
    expect(viewStateOf(view, true)).toBe('error');
    expect(statusText()).toContain(text);
  });

  it('done-pass: issuance only, valid, valid-but-expired', () => {
    show('FLOW-01-pass');
    expect(resultText()).toContain('The credential was issued. No verification was run.');
    expect(stampOfResult()).toBe('issued');
    cleanup();
    show('FLOW-30-pass');
    expect(resultText()).toContain('The verifier accepted the credential.');
    expect(stampOfResult()).toBe('valid');
    cleanup();
    show('FLOW-30-pass', withVerdict('FLOW-30-pass', { verification: 'valid-but-expired' }));
    expect(resultText()).toContain(
      'The signature checks out, but the credential is past its expiry date.',
    );
    expect(stampOfResult()).toBe('expired');
  });

  it('done-fail: invalid at the failing step with the recorded code and message', () => {
    const { view } = show('FLOW-30-fail');
    expect(viewStateOf(view, true)).toBe('done-fail');
    expect(resultText()).toContain(
      'The verifier rejected the credential at “Wallet sends the presentation”.',
    );
    expect(stampOfResult()).toBe('invalid');
    expect(resultText()).toContain('Failing step');
    // the verbatim error is its own field (ADR-136), not part of the sentence
    expect(resultText()).toContain(
      'Error detailinvalid_request Client id validation failed due to invalid client_id/domain',
    );
    cleanup();
    show('FLOW-30-fail', withVerdict('FLOW-30-fail', { verification: null, issuanceOk: false }));
    expect(resultText()).toContain('The run failed at “Wallet sends the presentation”.');
    expect(stampOfResult()).toBe('fail');
    expect(resultText()).toContain(
      'invalid_request Client id validation failed due to invalid client_id/domain',
    );
  });

  it('done-blocked, done-lenient, done-inconclusive, done-no-submission and the probe', () => {
    show('FLOW-30-fail', withVerdict('FLOW-30-fail', { outcome: 'blocked' }));
    expect(resultText()).toContain(
      "“Record the verifier's verdict” did not run because “Wallet sends the presentation” failed first. Counted as not working in pass rates.",
    );
    cleanup();
    show('FLOW-30-pass', withVerdict('FLOW-30-pass', { outcome: 'lenient' }));
    expect(resultText()).toContain(
      'The component accepted something the specification leaves to policy. Counted as conformant.',
    );
    cleanup();
    show('FLOW-30-pass', withVerdict('FLOW-30-pass', { outcome: 'inconclusive' }));
    expect(resultText()).toContain(
      'The playground could not tell: a manual observation never arrived. Not counted in pass rates.',
    );
    cleanup();
    show(
      'FLOW-30-pass',
      withVerdict('FLOW-30-pass', { outcome: 'no-submission', verification: 'no-submission' }),
    );
    expect(resultText()).toContain(
      'The wallet never answered the verifier before the request expired. Not counted in pass rates.',
    );
    cleanup();
    show('FLOW-30-pass', withVerdict('FLOW-30-pass', { outcome: 'no-submission', kind: 'probe' }));
    expect(resultText()).toContain(
      'Probe result: no wallet answered. Inji Wallet cannot answer the Digital Credentials API yet. Not counted in pass rates.',
    );
  });
});

describe('ui.run-screen reducer', () => {
  it.each(['FLOW-01-pass', 'FLOW-04-pass', 'FLOW-30-pass', 'FLOW-30-fail'] as const)(
    '%s: live (SSE with duplicates) and replay (JSON pages) reach the same state',
    async (id) => {
      const f = logFixture(id);
      FakeEventSource.reset();
      const live: EventEnvelope[] = [];
      const client = new StreamClient({
        streamId: f.runId,
        onEvent: (e) => live.push(e),
        createSource: (url) => new FakeEventSource(url),
      });
      client.start();
      const src = FakeEventSource.last;
      src.open();
      for (const e of f.events) {
        src.send(e);
        if (e.seq % 7 === 0) src.send(e); // a resent frame is applied once
      }
      src.end(f.end);
      await act(async () => {
        await Promise.resolve();
      });
      expect(client.current.state).toBe('closed');
      const pages = (after: number): Promise<EventPage> => {
        const events = f.events.filter((e) => e.seq > after).slice(0, 10);
        const closed = (events.at(-1)?.seq ?? after) >= f.end.lastSeq;
        return Promise.resolve({
          streamId: f.runId,
          events,
          nextAfter: closed ? null : (events.at(-1)?.seq ?? null),
          closed,
        });
      };
      const replay = await replayRunLog(pages);
      expect(replay.events).toEqual(f.events);
      expect(reduceAll(live)).toEqual(replay.view);
      expect(replay.view.state).toBe('completed');
    },
  );
});

describe('ui.run-screen step rail and deep links', () => {
  it('#step= selects that step; selecting another replaces the hash without a history entry', () => {
    window.history.replaceState(null, '', '/runs/x#step=vci.token');
    const before = window.history.length;
    show('FLOW-30-pass');
    const rail = screen.getByRole('navigation', { name: 'Steps' });
    const current = within(rail)
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-current') === 'true');
    expect(current.map((b) => b.dataset.step)).toEqual(['vci.token']);
    fireEvent.click(within(rail).getByText('POST /v2/vp-request'));
    expect(window.location.hash).toBe('#step=vp.request.create');
    expect(window.history.length).toBe(before);
    expect(screen.getByRole('region', { name: 'Inspector' }).textContent).toContain(
      'POST /v2/vp-request',
    );
  });

  it('terminal load preselects the first failing step; ↓ moves, Enter focuses the inspector', () => {
    show('FLOW-30-fail');
    const rail = screen.getByRole('navigation', { name: 'Steps' });
    const selected = within(rail)
      .getAllByRole('button')
      .find((b) => b.getAttribute('aria-current') === 'true');
    expect(selected?.dataset.step).toBe('vp.response.post');
    expect(selected?.tabIndex).toBe(0);
    if (!selected) throw new Error('no selection');
    selected.focus();
    fireEvent.keyDown(selected, { key: 'ArrowDown' });
    expect(window.location.hash).toBe('#step=vp.error.dispatch');
    const next = within(rail)
      .getAllByRole('button')
      .find((b) => b.dataset.step === 'vp.error.dispatch');
    expect(document.activeElement).toBe(next);
    if (next) fireEvent.keyDown(next, { key: 'Enter' });
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Inspector' }));
  });

  it('rows show a plain title, the HTTP line, outcome and skip reason; capture and counts sit in the inspector Details (UI-13, UI-14, ADR-136)', () => {
    show('FLOW-30-pass');
    const rail = screen.getByRole('navigation', { name: 'Steps' });
    expect(within(rail).getByRole('heading', { name: 'Issuance' })).toBeTruthy();
    expect(within(rail).getByRole('heading', { name: 'Presentation' })).toBeTruthy();
    const fetchRow = within(rail)
      .getAllByRole('button')
      .find((b) => b.dataset.step === 'vp.request.fetch');
    expect(fetchRow?.textContent).toContain('Skipped');
    expect(fetchRow?.textContent).toContain('request carried by value');
    expect(fetchRow?.textContent).not.toContain('capture');
    const post = within(rail)
      .getAllByRole('button')
      .find((b) => b.dataset.step === 'vp.response.post');
    expect(post?.textContent).toContain('Pass');
    expect(post?.querySelector('.step-label')?.textContent).toBe('Wallet sends the presentation');
    expect(post?.querySelector('.step-detail')?.textContent).toBe('POST response_uri vp_token');
    expect(post?.textContent).not.toContain('vp.response.post');
    expect(post?.textContent).not.toContain('capture');
    if (!post) throw new Error('no row');
    fireEvent.click(post);
    const details = () => {
      const inspector = screen.getByRole('region', { name: 'Inspector' });
      const d = inspector.querySelector('details.inspector-details');
      if (!d) throw new Error('no step Details');
      return d.textContent ?? '';
    };
    expect(details()).toContain('Step IDvp.response.post');
    expect(details()).toContain('Full capture');
    expect(details()).toContain('Messages1');
    const sign = within(rail)
      .getAllByRole('button')
      .find((b) => b.dataset.step === 'vci.proof.sign');
    if (!sign) throw new Error('no row');
    fireEvent.click(sign);
    expect(details()).toContain('Not recorded (library step)');
  });

  it('a partial step raises the CoverageBanner; engine steps are listed but not counted', () => {
    const f = logFixture('FLOW-30-pass');
    const events = f.events.map((e) =>
      e.type === 'step.completed' && e.stepKey === 'vp.result.poll'
        ? ({
            ...e,
            payload: {
              ...(e.payload as object),
              capture: 'partial',
              coverageNote: 'the phone posted directly',
            },
          } as EventEnvelope)
        : e,
    );
    show('FLOW-30-pass', events);
    expect(screen.getByText('Partial evidence: 1 step(s) ran outside full capture.')).toBeTruthy();
    expect(
      screen.getByText("Read the verifier's answer: partly recorded: the phone posted directly"),
    ).toBeTruthy();
    expect(screen.getByText('Library steps (never recorded)')).toBeTruthy();
    expect(
      screen.getByText(
        'A diagnosis never rests on these steps. Anything seen only here is reported as an observation.',
      ),
    ).toBeTruthy();
  });

  it('no CoverageBanner when every non-engine step had full capture', () => {
    show('FLOW-30-pass');
    expect(screen.queryByText(/Partial evidence/)).toBeNull();
  });
});

describe('ui.run-page', () => {
  it('API-22 not_found shows the not-found view (UI-09)', async () => {
    FakeEventSource.reset();
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    setFetcher(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'not_found',
              message: 'x',
              status: 404,
              requestId: 'R1',
              retryable: false,
            },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/runs/01K7X0F1XA0000000000000099']}>
        <Routes>
          <Route path="/runs/:runId" element={<RunPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This run does not exist.' }),
    ).toBeTruthy();
    expect(screen.getByText('It may have been deleted. Run 00000099 was not found.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the playground' })).toBeTruthy();
  });
});
