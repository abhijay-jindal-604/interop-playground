import { act, cleanup, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFetcher } from '../api/client.js';
import { copy } from '../copy.js';
import { routes } from '../routes/routes.js';
import { initialState, store } from '../state/store.js';
import { FakeEventSource, ev } from '../test/fake-event-source.js';
import { BOOT_FIXTURES } from '../test/fixtures.js';

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

function serveFixtures() {
  setFetcher((input) => {
    const path = input.split('?')[0] ?? input;
    const body = BOOT_FIXTURES[path];
    return body === undefined
      ? json(
          {
            error: {
              code: 'not_found',
              message: 'x',
              status: 404,
              requestId: 'R1',
              retryable: false,
            },
          },
          404,
        )
      : json(body);
  });
}

async function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  await act(async () => {
    await Promise.resolve();
  });
  return router;
}

describe('ui.app-shell', () => {
  beforeEach(() => {
    store.set(() => initialState());
    FakeEventSource.reset();
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    serveFixtures();
  });
  afterEach(() => cleanup());

  it('renders landmarks, skip link first, primary nav and the selector intro (UI-01, UI-73)', async () => {
    await renderAt('/');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Pick who plays each role' }),
    ).toBeTruthy();
    const links = screen.getAllByRole('link');
    expect(links[0]?.textContent).toBe(copy.skipLink);
    expect(links[0]?.getAttribute('href')).toBe('#main');
    const nav = screen.getByRole('navigation', { name: copy.nav.label });
    for (const label of ['Playground', 'History', 'Matrix', 'Tamper', 'Issue drafts']) {
      expect(nav.textContent).toContain(label);
    }
    expect(screen.getByRole('main').id).toBe('main');
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('contentinfo').textContent).toContain(copy.footer.local);
    expect(document.title).toBe('Interop Playground');
    expect(await screen.findByText('Inji Certify (pre-authorized code)')).toBeTruthy();
    expect(
      screen.getByText('Inji Verify (local) is not running (inji-verify is not ready).'),
    ).toBeTruthy();
    expect(document.getElementById('live-polite')?.getAttribute('aria-live')).toBe('polite');
    expect(document.getElementById('live-assertive')?.getAttribute('aria-live')).toBe('assertive');
  });

  it('opens the env stream after boot and shows the degraded banner on env.degraded (UI-02)', async () => {
    await renderAt('/');
    await screen.findByRole('heading', { level: 1 });
    const src = FakeEventSource.instances.find((s) => s.url.endsWith('/streams/env/events'));
    expect(src).toBeTruthy();
    act(() => {
      src?.open();
      src?.send({
        ...ev(1, 'env.degraded', 'env'),
        payload: { upstreams: ['certify', 'mimoto'], reasons: {} },
      });
    });
    expect(screen.getByText(copy.env.degradedBanner('certify, mimoto'))).toBeTruthy();
    // a replayed (historic) env.ready clears the banner without the recovery toast
    act(() => {
      src?.send({ ...ev(2, 'env.ready', 'env'), payload: { upstreams: ['certify', 'mimoto'] } });
    });
    expect(screen.queryByText(copy.env.degradedBanner('certify, mimoto'))).toBeNull();
    expect(screen.queryByText(copy.env.recovered)).toBeNull();
    // a live degraded → ready pair toasts
    const now = new Date().toISOString();
    act(() => {
      src?.send({
        ...ev(3, 'env.degraded', 'env'),
        ts: now,
        payload: { upstreams: ['certify'], reasons: {} },
      });
      src?.send({ ...ev(4, 'env.ready', 'env'), ts: now, payload: { upstreams: ['certify'] } });
    });
    expect(screen.getByText(copy.env.recovered)).toBeTruthy();
  });

  it('shows the not-found view for an unknown path', async () => {
    await renderAt('/nope');
    expect(
      await screen.findByRole('heading', { level: 1, name: copy.notFound.heading }),
    ).toBeTruthy();
    expect(screen.getByText(copy.notFound.body('/nope'))).toBeTruthy();
    expect(document.title).toBe('Page not found · Interop Playground');
  });

  it('renders a page for every route of UI-01 / UI-50', async () => {
    for (const path of [
      '/history',
      '/matrix',
      '/matrix/snapshots',
      '/matrix/snapshots/compare',
      '/tamper',
      '/drafts',
      '/drafts/D1',
      '/suites/S1',
      '/runs/01J8ZZZZZZZZZZZZZZZZZZZZZZ',
      '/runs/01J8ZZZZZZZZZZZZZZZZZZZZZZ/report',
      '/runs/A/compare/B',
      '/environment',
    ]) {
      store.set(() => initialState());
      await renderAt(path);
      expect(await screen.findAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(screen.queryByText(copy.notFound.heading)).toBeNull();
      cleanup();
    }
  });

  it('backend unreachable: full-page copy with Reload (UI-02)', async () => {
    setFetcher(() => Promise.reject(new TypeError('Failed to fetch')));
    await renderAt('/');
    expect(
      await screen.findByRole('heading', { level: 1, name: copy.boot.unreachableHeading }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: copy.boot.reload })).toBeTruthy();
  });

  it('a non-JSON answer (not the BFF) also counts as unreachable', async () => {
    setFetcher(() =>
      Promise.resolve(
        new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
      ),
    );
    await renderAt('/');
    expect(
      await screen.findByRole('heading', { level: 1, name: copy.boot.unreachableHeading }),
    ).toBeTruthy();
  });

  it('request_guard_failed on boot: the wrong-address page (UI-02)', async () => {
    setFetcher(() =>
      json(
        {
          error: {
            code: 'request_guard_failed',
            message: 'bad host',
            status: 403,
            requestId: 'R2',
            retryable: false,
          },
        },
        403,
      ),
    );
    await renderAt('/');
    expect(
      await screen.findByRole('heading', { level: 1, name: copy.boot.guardHeading }),
    ).toBeTruthy();
    expect(screen.getByText(copy.boot.guardBody)).toBeTruthy();
  });
});
