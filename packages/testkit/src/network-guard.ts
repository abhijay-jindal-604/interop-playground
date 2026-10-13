/**
 * No accidental network in `unit` and `contract` tests (plan/11 §2): global `fetch` and
 * `node:net` connects reject every host except loopback.
 */
import net from 'node:net';

export const NETWORK_DISABLED_MESSAGE = 'network disabled in unit tests';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string | undefined | null): boolean {
  if (host === undefined || host === null || host === '') return true; // unix socket / default
  return LOOPBACK.has(host.toLowerCase());
}

function hostOfFetchInput(input: unknown): string | null {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input !== null && typeof input === 'object' && 'url' in input) {
      const url = input.url;
      if (typeof url === 'string') return new URL(url).hostname;
    }
  } catch {
    return null;
  }
  return null;
}

function hostOfConnectArgs(args: unknown[]): string | undefined {
  const first = args[0];
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    const opts = first as { host?: unknown; path?: unknown };
    if (typeof opts.path === 'string') return undefined; // IPC socket
    return typeof opts.host === 'string' ? opts.host : undefined;
  }
  if (typeof first === 'number' || typeof first === 'string') {
    if (typeof first === 'string' && !/^\d+$/.test(first)) return undefined; // IPC path
    const second = args[1];
    return typeof second === 'string' ? second : undefined;
  }
  return undefined;
}

let installed = false;

/** Idempotent; returns a function that restores the original globals. */
export function installNetworkGuard(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const originalFetch = globalThis.fetch;
  const socketProto = net.Socket.prototype as unknown as {
    connect: (this: net.Socket, ...args: unknown[]) => net.Socket;
  };
  const originalConnect = socketProto.connect;

  globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = hostOfFetchInput(input);
    if (host === null || !isLoopbackHost(host)) {
      return Promise.reject(new Error(NETWORK_DISABLED_MESSAGE));
    }
    return originalFetch(input, init);
  };

  socketProto.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const host = hostOfConnectArgs(args);
    if (!isLoopbackHost(host)) {
      throw new Error(NETWORK_DISABLED_MESSAGE);
    }
    return originalConnect.apply(this, args);
  };

  return () => {
    globalThis.fetch = originalFetch;
    socketProto.connect = originalConnect;
    installed = false;
  };
}
