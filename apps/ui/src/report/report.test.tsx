/**
 * `ui.report` (plan/12 T-32 UI half, 06 UI-51): the view of a pass and of a forced-fail report
 * lists issuer, wallet, verifier, format, proof type, outcome and error detail; the empty and error
 * states of UI-51; the Markdown tab shows API-45 `?format=markdown`. API-45 answers from fixtures.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunReport } from '@interop-playground/api';
import { setFetcher } from '../api/client.js';
import { initialState, store } from '../state/store.js';
import { EXACT_DIAGNOSIS, FP01 } from '../test/angle-fixtures.js';
import { FAIL_MARKDOWN, FAIL_REPORT, PASS_REPORT } from '../test/report-fixtures.js';
import { ReportPage } from './ReportPage.js';

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
const envelope = (code: string, status: number, details?: Record<string, unknown>) =>
  json(
    { error: { code, message: code, status, requestId: 'R1', retryable: false, details } },
    status,
  );

function serve(reports: Record<string, RunReport | 'not-terminal' | 'not-found'>) {
  setFetcher((input) => {
    const url = new URL(input, 'http://x');
    const m = /^\/api\/v1\/reports\/runs\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const r = reports[m[1]!];
      if (r === 'not-terminal') return envelope('run_not_terminal', 409, { state: 'running' });
      if (!r || r === 'not-found') return envelope('not_found', 404);
      if (url.searchParams.get('format') === 'markdown')
        return Promise.resolve(
          new Response(FAIL_MARKDOWN, { headers: { 'content-type': 'text/markdown' } }),
        );
      return json(r);
    }
    return envelope('not_found', 404);
  });
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/runs/:runId/report" element={<ReportPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const combination = () => screen.getByRole('region', { name: 'Combination' });
const row = (label: string) =>
  within(combination()).getByRole('rowheader', { name: label }).closest('tr')?.textContent ?? '';

beforeEach(() => {
  store.set(() => initialState());
  serve({
    [PASS_REPORT.runId]: PASS_REPORT,
    [FAIL_REPORT.runId]: FAIL_REPORT,
    '01J8RUNNINGRUNNINGRUNNINGR': 'not-terminal',
  });
});
afterEach(() => cleanup());

describe('ui.report REQ-26 fields', () => {
  it('a pass report lists issuer, wallet, verifier, format, proof type, outcome and error detail', async () => {
    renderAt(`/runs/${PASS_REPORT.runId}/report`);
    expect(await screen.findByRole('heading', { level: 1, name: /^Run No\. / })).toBeTruthy();
    expect(screen.getByTestId('stamp').getAttribute('data-status')).toBe('pass');
    expect(row('Issuer')).toContain('issuer.certify-preauth');
    expect(row('Wallet')).toContain('wallet.playground-ts');
    expect(row('Verifier')).toContain('verifier.inji-verify-local');
    expect(row('Format')).toContain('SD-JWT VC (dc+sd-jwt)');
    expect(row('Proof type')).toContain('jwt (ES256, P1363)');
    expect(row('Outcome')).toContain('pass');
    expect(row('Error detail')).toContain('None');
    expect(row('Failed step')).toContain('None');
    expect(screen.getByRole('region', { name: 'Failing checks' }).textContent).toContain(
      'No failing checks.',
    );
    expect(screen.getByRole('region', { name: 'Steps' }).textContent).toContain(
      'request carried by value',
    );
  });

  it('a forced-fail report adds the failed step, error detail, failing checks and the diagnosis', async () => {
    renderAt(`/runs/${FAIL_REPORT.runId}/report`);
    expect(await screen.findByRole('heading', { level: 1, name: /^Run No\. / })).toBeTruthy();
    expect(screen.getByTestId('stamp').getAttribute('data-status')).toBe('fail');
    expect(row('Issuer')).toContain('issuer.certify-preauth');
    expect(row('Wallet')).toContain('wallet.playground-ts');
    expect(row('Verifier')).toContain('verifier.inji-verify-local');
    expect(row('Format')).toContain('dc+sd-jwt');
    expect(row('Proof type')).toContain('jwt (ES256, P1363)');
    expect(row('Outcome')).toContain('fail');
    expect(row('Failed step')).toContain('vp.response.post');
    expect(row('Error detail')).toContain(
      '400 invalid_request: Client id validation failed due to invalid client_id/domain.',
    );
    const checks = screen.getByRole('region', { name: 'Failing checks' }).textContent ?? '';
    expect(checks).toContain('vp.response.status');
    expect(checks).toContain('invalid_request');
    const diag = screen.getByRole('region', { name: 'Diagnosis' }).textContent ?? '';
    expect(diag).toContain('FP-11');
    expect(diag).toContain('Verifier rejects the client id the wallet echoed');
    expect(screen.getByRole('region', { name: 'Fix-it' }).textContent).toContain(
      'No proven setting change fixes this. Diagnosis only.',
    );
  });

  it('a failed run without a match reads "Unclassified"', async () => {
    serve({
      [FAIL_REPORT.runId]: { ...FAIL_REPORT, diagnosis: { ...FAIL_REPORT.diagnosis, matches: [] } },
    });
    renderAt(`/runs/${FAIL_REPORT.runId}/report`);
    await screen.findByRole('heading', { level: 1, name: /^Run No\. / });
    expect(screen.getByRole('region', { name: 'Diagnosis' }).textContent).toContain(
      'Unclassified. No known fingerprint matched; the raw checks above are the evidence.',
    );
  });

  it('T-45: an exact FP-01 with one offer renders the fix-it panel; the side word is spelled out', async () => {
    serve({
      [FAIL_REPORT.runId]: {
        ...FAIL_REPORT,
        diagnosis: { ...EXACT_DIAGNOSIS, matches: [{ ...FP01, deviatingSide: 'issuer+verifier' }] },
      },
    });
    renderAt(`/runs/${FAIL_REPORT.runId}/report`);
    await screen.findByRole('heading', { level: 1, name: /^Run No\. / });
    expect(screen.getByRole('region', { name: 'Diagnosis' }).textContent).toContain(
      'Issuer and verifier: inji-verify (vc-verifier) 1.0-alpha.1',
    );
    const fix = screen.getByRole('region', { name: 'Fix-it' });
    expect(within(fix).getByRole('button', { name: 'Fix it and re-run' })).toBeTruthy();
    expect(fix.textContent).toContain('KNOB-01 · absent → present');
  });

  it('the Markdown tab shows API-45 ?format=markdown', async () => {
    renderAt(`/runs/${FAIL_REPORT.runId}/report?tab=markdown`);
    const pre = await screen.findByLabelText('Report as Markdown');
    expect(pre.textContent).toContain('# Run 01J8FAILFAILFAILFAILFAILFA: FAIL');
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    expect((await screen.findByLabelText('Report as JSON')).textContent).toContain(
      '"failedStepKey": "vp.response.post"',
    );
  });
});

describe('ui.report states', () => {
  it('run_not_terminal → "This run is not finished"', async () => {
    renderAt('/runs/01J8RUNNINGRUNNINGRUNNINGR/report');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This run is not finished' }),
    ).toBeTruthy();
    expect(
      screen.getByText('The report is available when the run ends. Current state: running.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open run screen' }).getAttribute('href')).toBe(
      '/runs/01J8RUNNINGRUNNINGRUNNINGR',
    );
  });

  it('not_found → "Run not found"', async () => {
    renderAt('/runs/01J8GONEGONEGONEGONEGONEGO/report');
    expect(await screen.findByRole('heading', { level: 1, name: 'Run not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to History' })).toBeTruthy();
  });
});
