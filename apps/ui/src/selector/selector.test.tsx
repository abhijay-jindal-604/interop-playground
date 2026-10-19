/**
 * `ui.selector` (plan/12 T-30 acceptance): greyed cards show reason text + gap ID (UI-05); Start
 * creates a run (API-20, Idempotency-Key) and opens `/runs/:runId`; the deep link
 * `/?issuer&wallet&verifier&format&grant&mode` preselects. API-03 answers from a fake rule.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdapterEntry,
  AdapterListResponse,
  CreateRunRequest,
  PreviewResponse,
} from '@interop-playground/api';
import { setFetcher } from '../api/client.js';
import { initialState, store } from '../state/store.js';
import { env } from '../test/fixtures.js';
import { STORAGE_KEY } from './model.js';
import { SelectorPage } from './SelectorPage.js';

const entry = (
  id: string,
  role: 'issuer' | 'wallet' | 'verifier',
  displayName: string,
  available = true,
): AdapterEntry =>
  ({
    descriptor: {
      id,
      role,
      vendor: 'inji',
      displayName,
      envClass: 'local',
      tier: 'automated',
      formats: ['dc+sd-jwt', 'ldp_vc'],
      knobs: [],
      coverage: { default: 'full', partialHops: [] },
    },
    availability: available
      ? { available: true, versionFingerprint: `${id}@1` }
      : { available: false, reason: 'container not reachable', versionFingerprint: '' },
    probedAt: null,
  }) as unknown as AdapterEntry;

const adapters: AdapterListResponse = {
  // out of 02 §5.3 order on purpose: the column sorts
  issuers: [
    entry('issuer.certify-authcode', 'issuer', 'Inji Certify (authorization code)'),
    entry('issuer.certify-preauth', 'issuer', 'Inji Certify (pre-authorized)'),
  ],
  wallets: [
    entry('wallet.playground-ts', 'wallet', 'Playground wallet'),
    entry('wallet.inji-jvm', 'wallet', 'Inji libraries (Kotlin)'),
  ],
  verifiers: [
    entry('verifier.inji-verify-local', 'verifier', 'Inji Verify (local)'),
    entry('verifier.waltid', 'verifier', 'walt.id verifier'),
    entry('verifier.eudi', 'verifier', 'EUDI verifier', false),
  ],
};

/** a stand-in for the 04 §4.3 rules: inji-jvm × dc+sd-jwt is out (G-103) */
function preview(req: CreateRunRequest): PreviewResponse {
  if (req.wallet === 'wallet.inji-jvm' && req.format === 'dc+sd-jwt')
    return {
      ok: false,
      hit: { ruleId: 'jvm-http-issuer', reason: 'VCIClient refuses http issuers.', gapId: 'G-103' },
    };
  return {
    ok: true,
    spec: { delivery: 'in-process' } as never,
    warnings: [],
    tamperApplicable: [],
    controlRequired: false,
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

let created: { body: CreateRunRequest; key: string | null }[] = [];

function serve() {
  setFetcher((input, init) => {
    const path = input.split('?')[0] ?? input;
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as CreateRunRequest) : null;
    if (path === '/api/v1/runs/preview' && body) return json(preview(body));
    if (path === '/api/v1/runs' && init?.method === 'POST' && body) {
      const key = new Headers(init.headers).get('Idempotency-Key');
      created.push({ body, key });
      return json({ runId: '01J8NEWRUNNEWRUNNEWRUNNEWR', spec: {}, state: 'queued' }, 201);
    }
    return json(
      { error: { code: 'not_found', message: 'x', status: 404, requestId: 'R', retryable: false } },
      404,
    );
  });
}

function RunStub() {
  const { runId } = useParams();
  return <h1>Run page {runId}</h1>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<SelectorPage />} />
        <Route path="/runs/:runId" element={<RunStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

const column = (name: string) => screen.getByRole('radiogroup', { name });
const card = (id: string) => document.querySelector<HTMLElement>(`[data-adapter="${id}"]`)!;
const radio = (id: string) => card(id).querySelector<HTMLInputElement>('input[type="radio"]')!;

beforeEach(() => {
  created = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  store.set(() => {
    const s = initialState();
    s.catalog.adapters = { status: 'ready', data: adapters };
    s.env.snapshot = { status: 'ready', data: env };
    return s;
  });
  serve();
});
afterEach(() => cleanup());

describe('ui.selector cards (UI-04, UI-05)', () => {
  it('orders each column by 02 §5.3 and preselects the defaults', () => {
    renderAt('/');
    const issuers = within(column('Issuer')).getAllByRole('radio');
    expect(issuers.map((r) => (r as HTMLInputElement).value)).toEqual([
      'issuer.certify-preauth',
      'issuer.certify-authcode',
    ]);
    expect(radio('issuer.certify-preauth').checked).toBe(true);
    expect(radio('wallet.playground-ts').checked).toBe(true);
    expect(radio('verifier.inji-verify-local').checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'SD-JWT VC' })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'Cross-device (QR)' })).toHaveProperty(
      'checked',
      true,
    );
  });

  it('greyed cards show the reason text and the gap ID; Why not? names the rule', async () => {
    renderAt('/');
    await waitFor(() =>
      expect(card('wallet.inji-jvm').textContent).toContain(
        'Not available with this selection: VCIClient refuses http issuers. (G-103)',
      ),
    );
    expect(radio('wallet.inji-jvm').disabled).toBe(true);
    expect(card('verifier.eudi').textContent).toContain('Not running: container not reachable');
    expect(radio('verifier.eudi').disabled).toBe(true);
    const why = within(card('wallet.inji-jvm')).getByRole('button', { name: 'Why not?' });
    fireEvent.click(why);
    expect(card('wallet.inji-jvm').textContent).toContain('jvm-http-issuer');
    expect(card('wallet.inji-jvm').textContent).toContain('Gap G-103');
    // switching the format makes the card selectable again
    fireEvent.click(screen.getByRole('radio', { name: 'JSON-LD' }));
    await waitFor(() => expect(radio('wallet.inji-jvm').disabled).toBe(false));
    expect(card('wallet.inji-jvm').textContent).not.toContain('Not available');
  });

  it('a conflicting selected card disables Run with the reason', async () => {
    renderAt('/?wallet=wallet.inji-jvm');
    await waitFor(() =>
      expect(card('wallet.inji-jvm').textContent).toContain(
        'Conflicts with the selection: VCIClient refuses http issuers.',
      ),
    );
    const bar = screen.getByRole('region', { name: 'Start' });
    expect(within(bar).getByRole('button', { name: 'Run' })).toHaveProperty('disabled', true);
    expect(bar.textContent).toContain('VCIClient refuses http issuers. (G-103)');
  });
});

describe('ui.selector deep link and Start (UI-08)', () => {
  it('the deep link preselects issuer, wallet, verifier, format, grant and mode', async () => {
    renderAt(
      '/?issuer=issuer.certify-authcode&wallet=wallet.inji-jvm&verifier=verifier.waltid&format=ldp_vc&grant=authorization_code&mode=same-device',
    );
    expect(radio('issuer.certify-authcode').checked).toBe(true);
    expect(radio('wallet.inji-jvm').checked).toBe(true);
    expect(radio('verifier.waltid').checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'JSON-LD' })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'Same-device (deep link)' })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.getByText('Grant: authorization code')).toBeTruthy();
    const bar = screen.getByRole('region', { name: 'Start' });
    expect(bar.textContent).toContain(
      'Inji Certify (authorization code) → Inji libraries (Kotlin) → walt.id verifier · JSON-LD · authorization code · Same-device (deep link)',
    );
    // the preselection is what Start sends
    await waitFor(() =>
      expect(within(bar).getByRole('button', { name: 'Run' })).toHaveProperty('disabled', false),
    );
    await act(async () => {
      fireEvent.click(within(bar).getByRole('button', { name: 'Run' }));
      await Promise.resolve();
    });
    await screen.findByRole('heading', { name: /^Run page / });
    expect(created[0]?.body).toMatchObject({
      issuer: 'issuer.certify-authcode',
      wallet: 'wallet.inji-jvm',
      verifier: 'verifier.waltid',
      format: 'ldp_vc',
      grant: 'authorization_code',
      presentationMode: 'same-device',
      scope: 'full',
    });
  });

  it('Start creates the run with an Idempotency-Key and opens /runs/:runId', async () => {
    renderAt('/');
    const run = within(screen.getByRole('region', { name: 'Start' })).getByRole('button', {
      name: 'Run',
    });
    await waitFor(() => expect(screen.getByText('Delivery: in-process')).toBeTruthy());
    fireEvent.click(radio('issuer.certify-authcode'));
    await act(async () => {
      fireEvent.click(run);
      await Promise.resolve();
    });
    expect(
      await screen.findByRole('heading', { name: 'Run page 01J8NEWRUNNEWRUNNEWRUNNEWR' }),
    ).toBeTruthy();
    expect(created).toHaveLength(1);
    expect(created[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(created[0]?.body).toMatchObject({
      issuer: 'issuer.certify-authcode',
      wallet: 'wallet.playground-ts',
      verifier: 'verifier.inji-verify-local',
      grant: 'authorization_code',
      format: 'dc+sd-jwt',
      presentationMode: 'cross-device',
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      issuer: 'issuer.certify-authcode',
    });
  });

  it('Ctrl+Enter starts the run from anywhere on the page', async () => {
    renderAt('/');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
      await Promise.resolve();
    });
    await screen.findByRole('heading', { name: /^Run page / });
    expect(created).toHaveLength(1);
  });
});
