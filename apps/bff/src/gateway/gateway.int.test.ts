/**
 * L3 (plan/11 §2): a 55 s long poll (Verify's INJI_VP_REQUEST_LONG_POLLING_TIMEOUT, S-202)
 * completes through a real gateway listener under the default PROXY_UPSTREAM_TIMEOUT_MS.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { generateSelfToken } from '../capture/self-token.js';
import { openStore } from '../store/index.js';
import { startGateway } from './index.js';
import { listenerFor, PROXY_UPSTREAM_TIMEOUT_MS } from './listeners.js';

const HOLD_MS = 55_000;

it(
  'a 55 s long poll completes through the proxy (65 000 ms constant)',
  { timeout: 75_000 },
  async () => {
    const upstream = http.createServer((req, res) => {
      // the fake upstream holds the request like Verify does while the VP is pending
      void delay(HOLD_MS).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"VP_SUBMITTED"}');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const store = openStore(':memory:');
    const gw = await startGateway({
      sink: store.sink,
      selfToken: generateSelfToken(),
      onUnattributed: () => undefined,
      host: '127.0.0.1',
      listeners: [{ ...listenerFor(8099), upstream: base }],
      bindPort: () => 0,
      log: { info: () => undefined, warn: () => undefined },
    });
    try {
      expect(PROXY_UPSTREAM_TIMEOUT_MS).toBe(65000);
      const port = gw.listening[0]?.boundPort ?? 0;
      const t0 = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/v1/mimoto/long-poll`);
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"status":"VP_SUBMITTED"}');
      expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS);
      expect(elapsed).toBeLessThan(PROXY_UPSTREAM_TIMEOUT_MS);
    } finally {
      await gw.close();
      upstream.closeAllConnections();
      upstream.close();
      store.close();
    }
  },
);
