import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { NETWORK_DISABLED_MESSAGE, isLoopbackHost } from './network-guard.js';

describe('testkit.network-guard', () => {
  it('classifies loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('192.0.2.10')).toBe(false);
    expect(isLoopbackHost('example.org')).toBe(false);
  });

  it('rejects fetch to a non-loopback host (guard installed by setupFiles)', async () => {
    await expect(fetch('https://example.org/')).rejects.toThrow(NETWORK_DISABLED_MESSAGE);
  });

  it('rejects a raw socket connect to a non-loopback host', () => {
    const socket = new net.Socket();
    expect(() => socket.connect(443, '192.0.2.10')).toThrow(NETWORK_DISABLED_MESSAGE);
    socket.destroy();
  });
});
