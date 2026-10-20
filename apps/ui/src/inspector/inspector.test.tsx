/**
 * `ui.inspector` (plan/12 T-28 acceptance): on the FLOW-30 fixture the key-payload bar links offer,
 * token, credential, request/DCQL, `vp_token` and result JSON; SD-JWT disclosures are decoded;
 * `bodyState` and redaction chips render; the tabs are keyboard-reachable (UI-18..UI-23).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@interop-playground/api';
import { inspectorCopy } from '../copy.js';
import type { FlowLoad } from '../run/flows.js';
import { reduceAll } from '../run/reduce.js';
import { RunScreen } from '../run/RunScreen.js';
import { append, fixtureFlows, logFixture, withoutTerminal } from '../test/run-fixtures.js';
import { decodeJwt, decodeSdJwt, findDecodable, parseForm, splitRedactions } from './decode.js';
import { buildModel, chipTarget, CHIPS } from './model.js';
import { JsonCode } from './JsonCode.js';

const f = logFixture('FLOW-30-pass');

function show(events: EventEnvelope[] = f.events) {
  const flows: FlowLoad = { status: 'ready', flows: fixtureFlows(f) };
  render(
    <MemoryRouter>
      <RunScreen
        view={reduceAll(events)}
        events={events}
        flows={flows}
        run={null}
        stream={null}
        onRetryLive={() => {}}
        onCancel={() => {}}
      />
    </MemoryRouter>,
  );
  return screen.getByRole('region', { name: 'Inspector' });
}

const chip = (pane: HTMLElement, name: string) =>
  within(within(pane).getByRole('toolbar', { name: 'Key payloads' })).getByRole('button', {
    name,
  });
const ipanel = (pane: HTMLElement) => pane.querySelector<HTMLElement>('#ipanel')!;
const tab = (pane: HTMLElement, name: string) => within(pane).getByRole('tab', { name });

beforeEach(() => {
  window.history.replaceState(null, '', '/runs/x');
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
});
afterEach(cleanup);

describe('ui.inspector decoders', () => {
  it('decodes the issued SD-JWT VC: issuer JWT header, disclosures', () => {
    const resp = f.events.find(
      (e) => e.type === 'exchange.response' && e.stepKey === 'vci.credential',
    ) as EventEnvelope<'exchange.response'>;
    const items = findDecodable(resp.payload.body?.text ?? '');
    expect(items).toHaveLength(1);
    const sd = items[0]?.sdJwt;
    expect(items[0]?.path).toBe('credentials[0].credential');
    expect(sd?.issuerJwt.header.alg).toBeTypeOf('string');
    expect(sd?.disclosures.map((d) => d.name)).toContain('fullName');
    expect(sd?.disclosures.find((d) => d.name === 'fullName')?.value).toBe('Asha Rao');
  });

  it('finds the SD-JWT with KB-JWT inside the vp_token form field (JSON in a form value)', () => {
    const req = f.events.find(
      (e) => e.type === 'exchange.request' && e.stepKey === 'vp.response.post',
    ) as EventEnvelope<'exchange.request'>;
    const text = req.payload.body?.text ?? '';
    expect(parseForm(text)?.[0]?.[0]).toBe('vp_token');
    const items = findDecodable(text);
    expect(items[0]?.kind).toBe('sd-jwt');
    expect(items[0]?.path).toBe('vp_token.pg[0]');
    expect(items[0]?.sdJwt?.kbJwt?.header.typ).toBe('kb+jwt');
  });

  it('rejects non-JOSE strings and splits redaction markers', () => {
    expect(decodeJwt('a.b.c')).toBeNull();
    expect(decodeSdJwt('plain~text')).toBeNull();
    expect(splitRedactions('Bearer «redacted:ADMIN_TOKEN» tail')).toEqual([
      { text: 'Bearer ' },
      { redacted: 'ADMIN_TOKEN' },
      { text: ' tail' },
    ]);
  });

  it('resolves the fixed REQ-24 chip mapping on FLOW-30 (request object: by value, absent)', () => {
    const m = buildModel(f.events);
    const t = Object.fromEntries(CHIPS.map((c) => [c, chipTarget(m, c)?.stepKey ?? null]));
    expect(t).toEqual({
      offer: 'vci.offer.fetch',
      token: 'vci.token',
      credential: 'vci.credential',
      'request-link': 'vp.request.deliver',
      'request-object': null,
      'vp-token': 'vp.response.post',
      query: 'vp.request.create',
      result: 'vp.result.poll',
    });
  });
});

describe('ui.inspector pane on FLOW-30', () => {
  it('key-payload bar links offer, token, credential, request/DCQL, vp_token and result JSON', () => {
    const pane = show();
    const cases: [string, string, string][] = [
      ['Offer', 'vci.offer.fetch', '"credential_issuer"'],
      ['Token', 'vci.token', 'grant_type'],
      ['Credential', 'vci.credential', '"credentials"'],
      ['Presentation query', 'vp.request.create', '"dcqlQuery"'],
      ['vp_token', 'vp.response.post', 'vp_token'],
      ['Verification result', 'vp.result.poll', '"allChecksSuccessful"'],
    ];
    for (const [name, step, needle] of cases) {
      fireEvent.click(chip(pane, name));
      expect(window.location.hash, name).toBe(`#step=${step}`);
      expect(tab(pane, 'Messages').getAttribute('aria-selected'), name).toBe('true');
      const panel = ipanel(pane);
      const part = panel.querySelector('[data-part-panel]');
      expect(part, name).not.toBeNull();
      expect(part?.textContent, name).toContain(needle);
    }
    // the request link chip opens the engine call with the URI's query decoded in a table
    fireEvent.click(chip(pane, 'Request link'));
    expect(window.location.hash).toBe('#step=vp.request.deliver');
    expect(tab(pane, 'Engine').getAttribute('aria-selected')).toBe('true');
    const q = within(pane).getByRole('table');
    expect(q.textContent).toContain('request_uri');
    expect(q.textContent).toContain('https://192.0.2.10:8443/v1/verify/v2/vp-request/');
    // request object: carried by value in this run, so the chip is muted with the tooltip
    const ro = chip(pane, 'Request object');
    expect(ro.getAttribute('aria-disabled')).toBe('true');
    expect(ro.getAttribute('title')).toBe('Not part of this run');
  });

  it('Decoded tab lists the SD-JWT disclosures and the JOSE header chips', () => {
    window.history.replaceState(null, '', '/runs/x#step=vci.credential');
    const pane = show();
    fireEvent.click(tab(pane, 'Decoded'));
    const panel = ipanel(pane);
    expect(panel.textContent).toContain('Disclosed claim: fullName = Asha Rao');
    expect(panel.textContent).toContain('Issued credential (SD-JWT)');
    expect(panel.textContent).toContain('x5c yes');
    expect(panel.textContent).toContain(inspectorCopy.decoded.disclaimer);
    // the proof JWT of the credential request
    expect(panel.textContent).toContain('Proof JWT (ES256)');
  });

  it('vp_token in the Decoded tab shows the presentation with its key-binding JWT', () => {
    window.history.replaceState(null, '', '/runs/x#step=vp.response.post');
    const pane = show();
    fireEvent.click(tab(pane, 'Decoded'));
    const panel = ipanel(pane);
    expect(panel.textContent).toContain('vp_token (SD-JWT with key binding)');
    expect(panel.textContent).toContain('Key-binding JWT');
  });

  it('shows the wallet engine ops decoded (ADR-77): inspect-credential and build-kb-jwt', () => {
    let ev = append(
      withoutTerminal(f.events),
      'engine.call',
      {
        engine: 'playground-ts',
        op: 'inspect-credential',
        inputSummary: { format: 'dc+sd-jwt', bytes: 900 },
        outputSummary: {
          format: 'dc+sd-jwt',
          header: { alg: 'ES256', typ: 'dc+sd-jwt', kid: 'did:web:issuer#k1' },
          payload: { iss: 'https://issuer.example', vct: 'urn:eu.europa.ec.eudi:pid:1' },
          disclosures: [{ name: 'given_name', value: 'Asha', digest: 'd1' }],
          artifacts: { 'credential-header': { x5cPresent: false, x5cLength: 0 } },
        },
        durationMs: 3,
      },
      'vci.credential.inspect',
    );
    ev = append(
      ev,
      'engine.call',
      {
        engine: 'playground-ts',
        op: 'build-kb-jwt',
        inputSummary: { alg: 'ES256', kid: 'did:jwk:x', disclosures: 1 },
        outputSummary: {
          header: { alg: 'ES256', typ: 'kb+jwt' },
          payload: { iat: 1, aud: 'verifier.example', nonce: 'n-1', sd_hash: 'h' },
          jwsSha256: 'cd'.repeat(32),
        },
        durationMs: 2,
      },
      'vp.token.build',
    );
    window.history.replaceState(null, '', '/runs/x#step=vci.credential.inspect');
    let pane = show(ev);
    fireEvent.click(tab(pane, 'Decoded'));
    let panel = ipanel(pane);
    expect(panel.textContent).toContain('Credential as the wallet decoded it (SD-JWT VC)');
    expect(panel.textContent).toContain('From the engine call inspect-credential (playground-ts)');
    expect(panel.textContent).toContain('Disclosed claim: given_name = Asha');
    expect(panel.textContent).toContain('x5c no');
    expect(panel.textContent).toContain('urn:eu.europa.ec.eudi:pid:1');
    cleanup();
    window.history.replaceState(null, '', '/runs/x#step=vp.token.build');
    pane = show(ev);
    fireEvent.click(tab(pane, 'Decoded'));
    panel = ipanel(pane);
    expect(panel.textContent).toContain('Key-binding JWT (ES256)');
    expect(panel.textContent).toContain('typ: kb+jwt');
    expect(panel.textContent).toContain('"aud": "verifier.example"');
    expect(panel.textContent).toContain(`SHA-256 of the signed JWT: ${'cd'.repeat(32)}`);
  });

  it('renders bodyState chips and copy, and redaction chips', () => {
    const base = withoutTerminal(f.events);
    const sha = 'ab'.repeat(32);
    let ev = append(
      base,
      'step.started',
      { flowId: 'FLOW-30', order: 99, kind: 'http', label: 'synthetic' },
      'vp.result.fetch',
    );
    ev = append(
      ev,
      'exchange.request',
      {
        exchangeId: 'X:90',
        direction: 'outbound',
        actor: 'verifier.inji-verify-local',
        counterpart: 'inji-verify',
        method: 'POST',
        url: 'https://192.0.2.10:8443/v1/verify/v2/vp-session-results',
        headers: [['X-Admin-Token', '«redacted:ADMIN_TOKEN»']],
        body: null,
        bodyState: 'pruned',
        poll: null,
      },
      'vp.result.fetch',
    );
    ev = append(
      ev,
      'exchange.response',
      {
        exchangeId: 'X:90',
        status: 200,
        statusText: null,
        headers: [['content-type', 'application/json']],
        body: { encoding: 'utf8', text: '{"a":1', size: 300 * 1024, truncated: true, sha256: sha },
        bodyState: 'stored',
        durationMs: 4,
        poll: null,
      },
      'vp.result.fetch',
    );
    window.history.replaceState(null, '', '/runs/x#step=vp.result.fetch');
    const pane = show(ev);
    fireEvent.click(within(pane).getByRole('button', { name: /POST/ }));
    const panel = ipanel(pane);
    expect(within(panel).getByText('hidden: ADMIN_TOKEN').getAttribute('title')).toBe(
      inspectorCopy.messages.redactedTip,
    );
    expect(panel.textContent).toContain(inspectorCopy.body.pruned);
    fireEvent.click(within(panel).getByRole('tab', { name: 'Response' }));
    expect(panel.querySelector('[data-body-state="stored"]')?.textContent).toBe('Truncated');
    expect(panel.textContent).toContain(inspectorCopy.body.capped(300, sha));
    expect(panel.textContent).toContain(`SHA-256 ${sha.slice(0, 16)}…`);
  });

  it('a stored body shows the Stored chip; a step without HTTP says so', () => {
    window.history.replaceState(null, '', '/runs/x#step=vp.request.create');
    let pane = show();
    fireEvent.click(within(pane).getByRole('button', { name: /POST/ }));
    expect(pane.querySelector('[data-body-state="stored"]')?.textContent).toBe('Stored');
    cleanup();
    window.history.replaceState(null, '', '/runs/x#step=vp.token.build');
    pane = show();
    expect(ipanel(pane).textContent).toContain(inspectorCopy.messages.empty);
    fireEvent.click(tab(pane, 'Engine'));
    expect(ipanel(pane).textContent).toContain('sign-proof');
  });

  it('a skipped step shows its skip reason', () => {
    window.history.replaceState(null, '', '/runs/x#step=vp.request.fetch');
    const pane = show();
    expect(ipanel(pane).textContent).toBe(inspectorCopy.skipped('request carried by value'));
  });

  it('tabs follow the tablist pattern: arrows, Home/End, digits 1..5, remembered', () => {
    window.history.replaceState(null, '', '/runs/x#step=vp.verdict.evaluate');
    const pane = show();
    const messages = tab(pane, 'Messages');
    expect(messages.tabIndex).toBe(0);
    expect(tab(pane, 'Decoded').tabIndex).toBe(-1);
    messages.focus();
    fireEvent.keyDown(messages, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab(pane, 'Decoded'));
    expect(tab(pane, 'Decoded').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(tab(pane, 'Events'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(messages);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab(pane, 'Events'));
    fireEvent.keyDown(document.activeElement!, { key: '3' });
    expect(tab(pane, 'Checks').getAttribute('aria-selected')).toBe('true');
    const panel = ipanel(pane);
    expect(panel.textContent).toContain('vc.signature');
    expect(panel.textContent).toContain('Verifier response');
    expect(sessionStorage.getItem('pg.inspector.tab')).toBe('checks');
    // "Show message n" jumps to the exchange the check rests on
    fireEvent.click(within(panel).getAllByRole('button', { name: /Show message/ })[0]!);
    expect(window.location.hash).toBe('#step=vp.result.poll');
    expect(tab(pane, 'Messages').getAttribute('aria-selected')).toBe('true');
  });

  it('Whole run scope lists every exchange with step group headers; Events lists the log', () => {
    window.history.replaceState(null, '', '/runs/x#step=vci.token');
    const pane = show();
    fireEvent.click(within(pane).getByRole('radio', { name: 'Whole run' }));
    const panel = ipanel(pane);
    expect(panel.textContent).toContain(inspectorCopy.messages.footerRun(11));
    fireEvent.click(tab(pane, 'Events'));
    const rows = ipanel(pane).querySelectorAll('tbody tr');
    expect(rows).toHaveLength(f.events.length);
  });
});

describe('ui.inspector JSON colouring (ADR-119)', () => {
  it('keeps the pretty-printed text exactly and marks keys, strings, numbers and literals', () => {
    const value = { a: 'x "q"', n: -1.5e3, ok: true, z: null, list: [1, 'two'] };
    const { container } = render(<JsonCode value={value} />);
    const pre = container.querySelector('pre.json-code')!;
    expect(pre.textContent).toBe(JSON.stringify(value, null, 2));
    expect([...pre.querySelectorAll('.j-key')].map((e) => e.textContent)).toEqual([
      '"a"',
      '"n"',
      '"ok"',
      '"z"',
      '"list"',
    ]);
    expect(pre.querySelectorAll('.j-str')).toHaveLength(2);
    expect([...pre.querySelectorAll('.j-num')].map((e) => e.textContent)).toEqual(['-1500', '1']);
    expect(pre.querySelectorAll('.j-lit')).toHaveLength(2);
  });
});
