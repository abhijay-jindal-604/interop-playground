/**
 * `ui.delivery` (plan/12 T-31 acceptance): the QR decodes to exactly the `deliver-request` URI
 * (independent decoder, test/qr-decode.ts); copy/open buttons; countdown per UI-15 deadlines.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@interop-playground/api';
import { deliveryCopy } from '../copy.js';
import { resetAnnouncer } from '../lib/announce.js';
import { latestDelivery, type DeliveryOutput } from '../inspector/model.js';
import type { FlowLoad } from '../run/flows.js';
import { reduceAll } from '../run/reduce.js';
import { RunScreen } from '../run/RunScreen.js';
import { decodeQr, decodeQrSvg } from '../test/qr-decode.js';
import { append, fixtureFlows, logFixture, prefix } from '../test/run-fixtures.js';
import { AwaitingPanel, mmss } from './AwaitingPanel.js';
import { DeliveryBlock, QrCode } from './Delivery.js';
import { qrMatrix } from './qr.js';

const f = logFixture('FLOW-30-pass');
const recorded = latestDelivery(f.events)!;
const URI = recorded.uri;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ui.delivery QR', () => {
  it('the fixture carries the deliver-request URI', () => {
    expect(recorded.op).toBe('deliver-request');
    expect(URI.startsWith('openid4vp://authorize?client_id=')).toBe(true);
  });

  it('the drawn QR decodes to exactly the deliver-request URI (level M, quiet zone 4)', () => {
    render(<QrCode uri={URI} kind="request" />);
    const svg = screen.getByRole('img', { name: 'QR code for the request link' });
    expect(svg.getAttribute('data-qr-level')).toBe('M');
    expect(svg.getAttribute('shape-rendering')).toBe('crispEdges');
    const size = Number(svg.getAttribute('data-qr-size'));
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${size + 8} ${size + 8}`);
    expect(decodeQrSvg(svg as unknown as SVGElement)).toBe(URI);
  });

  it('decodes across versions and block layouts; level L above 2,000 bytes; none above 2,900', () => {
    for (const n of [40, 140, 400, 1_000, 1_900, 2_100, 2_600, 2_900]) {
      const uri = `openid4vp://authorize?request_uri=${'x'.repeat(n - 34)}`;
      expect(uri).toHaveLength(n);
      const m = qrMatrix(uri)!;
      expect(m.level, String(n)).toBe(n > 2_000 ? 'L' : 'M');
      expect(
        decodeQr(m.size, (r, c) => m.modules[r * m.size + c] === 1),
        String(n),
      ).toBe(uri);
    }
    const tooLong = `openid4vp://${'y'.repeat(2_890)}`;
    expect(qrMatrix(tooLong)).toBeNull();
    render(<QrCode uri={tooLong} kind="request" />);
    expect(screen.getByText(deliveryCopy.tooLong)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('non-ASCII URIs round-trip as UTF-8 bytes', () => {
    const uri = 'openid-credential-offer://?name=Ásha%20Rāo';
    const m = qrMatrix(uri)!;
    expect(decodeQr(m.size, (r, c) => m.modules[r * m.size + c] === 1)).toBe(uri);
  });
});

describe('ui.delivery buttons', () => {
  const qr: DeliveryOutput = { ...recorded, channel: 'qr' };

  it('Copy link copies the URI and turns into "Copied" for 2 s; open link is an anchor to it', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<DeliveryBlock delivery={qr} />);
    const open = screen.getByRole('link', { name: deliveryCopy.openHere });
    expect(open.getAttribute('href')).toBe(URI);
    expect(open.getAttribute('title')).toBe(deliveryCopy.openHereTip);
    const copyBtn = screen.getByRole('button', { name: deliveryCopy.copyLink });
    await act(async () => {
      fireEvent.click(copyBtn);
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(URI);
    expect(copyBtn.textContent).toBe(deliveryCopy.copied);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(copyBtn.textContent).toBe(deliveryCopy.copyLink);
  });

  it('clipboard failure shows the hand-copy sentence', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    render(<DeliveryBlock delivery={qr} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: deliveryCopy.copyLink }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toBe(deliveryCopy.copyFailed);
  });

  it('renders by channel: deep-link, in-process, adb-intent, web-wallet-redirect', () => {
    const { rerender } = render(<DeliveryBlock delivery={{ ...qr, channel: 'deep-link' }} />);
    expect(screen.getByRole('link', { name: deliveryCopy.openLink }).getAttribute('href')).toBe(
      URI,
    );
    expect(screen.queryByRole('img')).toBeNull();
    rerender(<DeliveryBlock delivery={{ ...qr, channel: 'in-process' }} />);
    expect(screen.getByText(deliveryCopy.inProcess)).toBeTruthy();
    rerender(<DeliveryBlock delivery={{ ...qr, channel: 'adb-intent' }} />);
    expect(screen.getByText(deliveryCopy.adb)).toBeTruthy();
    rerender(<DeliveryBlock delivery={{ ...qr, channel: 'web-wallet-redirect' }} />);
    expect(screen.getByText(deliveryCopy.webWallet)).toBeTruthy();
  });
});

describe('ui.delivery awaiting panel (UI-15)', () => {
  const T0 = Date.parse('2026-10-19T10:00:00.000Z');
  let liveP: HTMLElement;
  let liveA: HTMLElement;
  beforeEach(() => {
    // an earlier test announced on the real clock; the fake clock below starts before it
    resetAnnouncer();
    liveP = Object.assign(document.createElement('div'), { id: 'live-polite' });
    liveA = Object.assign(document.createElement('div'), { id: 'live-assertive' });
    document.body.append(liveP, liveA);
  });
  afterEach(() => {
    liveP.remove();
    liveA.remove();
  });

  it('formats mm:ss', () => {
    expect(mmss(300)).toBe('05:00');
    expect(mmss(1_800)).toBe('30:00');
    expect(mmss(9.2)).toBe('00:10');
    expect(mmss(-3)).toBe('00:00');
  });

  it('presentation: 5 min countdown, announced at 60/30/10 s, then the expired copy', () => {
    vi.useFakeTimers({ now: T0 });
    const deadline = new Date(T0 + 5 * 60_000).toISOString();
    render(
      <AwaitingPanel
        awaiting={{ stepKey: 'vp.wallet.observe', expects: ['presentation'], deadline }}
        delivery={{ ...recorded, channel: 'qr' }}
      />,
    );
    const region = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(region).getByRole('heading').textContent).toBe(
      deliveryCopy.headings.presentation,
    );
    expect(region.textContent).toContain('Time left 05:00');
    expect(region.querySelector('[aria-live="off"]')).not.toBeNull();
    expect(within(region).getByRole('img', { name: 'QR code for the request link' })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(liveA.textContent).toBe(`Waiting for you: ${deliveryCopy.headings.presentation}`);
    const said: string[] = [];
    for (let s = 0; s < 300; s++) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      if (liveP.textContent && said.at(-1) !== liveP.textContent) said.push(liveP.textContent);
    }
    expect(said).toEqual(['60 seconds left.', '30 seconds left.', '10 seconds left.']);
    expect(region.textContent).toBe(deliveryCopy.expired);
  });

  it('issuance: 30 min deadline shows 30:00 and the four instruction steps', () => {
    vi.useFakeTimers({ now: T0 });
    render(
      <AwaitingPanel
        awaiting={{
          stepKey: 'vci.offer.deliver',
          expects: ['issuance'],
          deadline: new Date(T0 + 30 * 60_000).toISOString(),
        }}
        delivery={null}
      />,
    );
    const region = screen.getByRole('region', { name: 'Waiting for you' });
    expect(region.textContent).toContain('Time left 30:00');
    expect(within(region).getAllByRole('listitem')).toHaveLength(4);
  });

  it('the run screen fills the awaiting slot from Run.awaiting and the deliver-request call', () => {
    vi.useFakeTimers({ now: T0 });
    const upTo = prefix(
      f.events,
      (e) => e.type === 'engine.call' && e.stepKey === 'vp.request.deliver',
    );
    // the recorded run delivered in-process; the manual tier delivers by QR
    const events = upTo.map((e) =>
      e.type === 'engine.call' && e.stepKey === 'vp.request.deliver'
        ? {
            ...e,
            payload: {
              ...(e as EventEnvelope<'engine.call'>).payload,
              outputSummary: { channel: 'qr', uri: URI, uriSha256: recorded.uriSha256 },
            },
          }
        : e,
    );
    const awaiting = append(
      events,
      'engine.call',
      {
        engine: 'playground-ts',
        op: 'await-observation',
        inputSummary: null,
        outputSummary: {
          expects: ['presentation'],
          deadline: new Date(T0 + 300_000).toISOString(),
        },
        durationMs: 0,
      },
      'vp.wallet.observe',
    );
    const flows: FlowLoad = { status: 'ready', flows: fixtureFlows(f) };
    render(
      <MemoryRouter>
        <RunScreen
          view={reduceAll(awaiting)}
          events={awaiting}
          flows={flows}
          run={null}
          stream={null}
          onRetryLive={() => {}}
          onCancel={() => {}}
        />
      </MemoryRouter>,
    );
    const slot = document.querySelector<HTMLElement>('[data-slot="awaiting"]')!;
    const svg = within(slot).getByRole('img', { name: 'QR code for the request link' });
    expect(decodeQrSvg(svg as unknown as SVGElement)).toBe(URI);
    expect(within(slot).getByRole('button', { name: deliveryCopy.copyLink })).toBeTruthy();
  });
});
