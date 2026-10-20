/**
 * T-46 live ldp_vc e2e (plan/12 T-46; 03 FLOW-03 + FLOW-31; ADR-96, ADR-97): on the real bundle,
 * select issuer.certify-preauth × wallet.playground-ts × verifier.inji-verify-local with the
 * format "W3C VC (JSON-LD, ldp_vc)" and cross-device mode, Run, and expect Pass. Then the run's
 * steps and events (API-21, API-41) must show FLOW-03 → FLOW-31, tier 1 `vp.vc.verify` pass
 * (`/v2/vc-verification` allChecksSuccessful) and tier 2 vp-results `allChecksSuccessful:true` with
 * `holderProofCheck.valid:true`. Runs only through e2e/playwright.live.config.ts (PLAYGROUND_LIVE=1).
 */
import { expect, test } from '@playwright/test';
import { maskPrivate } from './take.ts';

const COMBINATION = {
  issuer: 'issuer.certify-preauth',
  wallet: 'wallet.playground-ts',
  verifier: 'verifier.inji-verify-local',
} as const;
const LABEL = 'W3C VC (JSON-LD, ldp_vc)'; // run screen (06 §1); the selector says 'JSON-LD'

interface Step {
  stepKey: string;
  outcome: string;
  flowId: string;
  checks: { checkId: string; outcome: string }[];
}
interface Event {
  type: string;
  payload: { exchangeId?: string; status?: number; body?: { text?: string } | null; url?: string };
}

test.skip(process.env.PLAYGROUND_LIVE !== '1', 'live bundle only (e2e/playwright.live.config.ts)');

test('ldp_vc: FLOW-03 → FLOW-31 Pass at the real Verify, tier 1 + tier 2 valid', async ({
  page,
  request,
}) => {
  await maskPrivate(page);
  await page.goto('/');
  for (const id of Object.values(COMBINATION)) {
    const radio = page.locator(`[data-adapter="${id}"] input[type="radio"]`);
    await expect(radio).toBeEnabled({ timeout: 30_000 });
    await radio.check();
  }
  await page.getByRole('radio', { name: 'JSON-LD', exact: true }).check();
  await page.getByRole('radio', { name: 'Cross-device (QR)', exact: true }).check();
  const run = page.getByRole('region', { name: 'Start' }).getByRole('button', { name: 'Run' });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await run.click();
  await page.waitForURL(/\/runs\/[0-9A-HJKMNP-TV-Z]{26}$/);
  const runId = new URL(page.url()).pathname.split('/').pop()!;

  const result = page.getByRole('region', { name: 'Result' });
  await expect(result).toBeVisible({ timeout: 120_000 });
  await expect(result.locator('.result-word')).toHaveText('Pass');
  await expect(page.getByText(LABEL).first()).toBeVisible();

  const headers = { host: '127.0.0.1:3100' };
  const r = (await (await request.get(`/api/v1/runs/${runId}`, { headers })).json()) as {
    spec: { issuanceFlowId: string; presentationFlowId: string };
    verdict: unknown;
  };
  expect(r.spec.issuanceFlowId).toBe('FLOW-03');
  expect(r.spec.presentationFlowId).toBe('FLOW-31');
  expect(r.verdict).toMatchObject({ outcome: 'pass', verification: 'valid' });

  const { steps } = (await (
    await request.get(`/api/v1/runs/${runId}/steps`, { headers })
  ).json()) as { steps: Step[] };
  const step = (k: string): Step => steps.find((s) => s.stepKey === k)!;
  expect(step('vci.issuer.did').outcome).toBe('pass');
  // tier 1: /v2/vc-verification on the held credential
  expect(step('vp.vc.verify').outcome).toBe('pass');
  expect(step('vp.vc.verify').checks.map((c) => [c.checkId, c.outcome])).toEqual(
    expect.arrayContaining([['vc.signature', 'pass']]),
  );
  // tier 2: the VP Verify received
  expect(step('vp.result.poll').checks.map((c) => [c.checkId, c.outcome])).toEqual(
    expect.arrayContaining([['vp.holder-proof', 'pass']]),
  );

  const { events } = (await (
    await request.get(`/api/v1/streams/${runId}/events?format=json&limit=1000`, { headers })
  ).json()) as { events: Event[] };
  const urls = new Map<string, string>();
  for (const e of events)
    if (e.type === 'exchange.request' && e.payload.exchangeId)
      urls.set(e.payload.exchangeId, e.payload.url ?? '');
  const answer = (part: string): Record<string, unknown> => {
    const e = events.find(
      (x) =>
        x.type === 'exchange.response' &&
        (urls.get(x.payload.exchangeId ?? '') ?? '').includes(part) &&
        x.payload.status === 200 &&
        (x.payload.body?.text ?? '').includes('allChecksSuccessful'),
    );
    expect(e, `${part} answer`).toBeTruthy();
    return JSON.parse(e!.payload.body!.text!) as Record<string, unknown>;
  };
  const vp = answer('/v2/vp-results/') as {
    allChecksSuccessful: boolean;
    credentialResults: { holderProofCheck: { valid: boolean } }[];
  };
  expect(vp.allChecksSuccessful).toBe(true);
  expect(vp.credentialResults[0]!.holderProofCheck.valid).toBe(true);
  expect(answer('/v2/vc-verification').allChecksSuccessful).toBe(true);
  test.info().annotations.push({ type: 'runId', description: runId });
});
