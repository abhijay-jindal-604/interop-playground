/**
 * The UI's one API client (06 §1 data layer). Every request goes to the page origin (the BFF at
 * http://127.0.0.1:3100, or the Vite proxy in dev) and every user-action request carries
 * `Content-Type: application/json` (the 02 §6.3 guard). Errors are the 04 §6 envelope (`ApiError`)
 * or a network failure (`NetworkError`, no envelope; UI-31 "Network failure").
 *
 * Typed by the contract types of `@interop-playground/api` (api.ts). The generated `paths` of
 * client.gen.ts are not exported by that package yet (G-133), so openapi-fetch is wired in when
 * they are; the call sites below do not change.
 */
import type { ErrorEnvelope } from '@interop-playground/api';

export const API_BASE = '/api/v1';

/** An API failure carrying the server's error code, HTTP status and request id. */
export class ApiError extends Error {
  /** an ErrorCode, or an unknown code from a newer server (UI-31 fallback) */
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly serverMessage: string;
  constructor(envelope: ErrorEnvelope['error']) {
    super(`${envelope.code}: ${envelope.message}`);
    this.name = 'ApiError';
    this.code = envelope.code;
    this.status = envelope.status;
    this.requestId = envelope.requestId;
    this.retryable = envelope.retryable;
    this.details = envelope.details;
    this.serverMessage = envelope.message;
  }
}

/** fetch rejected, or the answer was not the BFF (no JSON envelope): the backend is not reachable. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

let fetcher: Fetcher = (input, init) => globalThis.fetch(input, init);
/** Tests swap the transport; production uses the page's fetch. */
export function setFetcher(next: Fetcher): void {
  fetcher = next;
}

function isEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const e = value.error;
  return typeof e === 'object' && e !== null && 'code' in e && 'requestId' in e;
}

export type Query = Record<string, string | number | boolean | undefined | null>;

/** Appends the non-empty query parameters to a path. */
export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `${path}?${s}` : path;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  extra?: Record<string, string>,
) {
  const init: RequestInit = { method, headers: { Accept: 'application/json', ...extra } };
  if (signal) init.signal = signal;
  if (body !== undefined) {
    init.headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...extra };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetcher(`${API_BASE}${path}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new NetworkError(err instanceof Error ? err.message : 'fetch failed');
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    // Something other than the BFF answered (a static server's index.html, a proxy error page).
    throw new NetworkError(`unexpected ${res.status} ${type || 'response'} from ${path}`);
  }
  const data: unknown = await res.json().catch(() => {
    throw new NetworkError(`unreadable JSON from ${path}`);
  });
  if (!res.ok) {
    if (isEnvelope(data)) throw new ApiError(data.error);
    throw new NetworkError(`HTTP ${res.status} without an error envelope from ${path}`);
  }
  return data as T;
}

/** GET a JSON resource from the BFF; throws `ApiError` on a non-2xx response. */
export function apiGet<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
  return request<T>('GET', withQuery(path, query), undefined, signal);
}

/** Send a JSON body with POST, PATCH or DELETE; throws `ApiError` on a non-2xx response. */
export function apiSend<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown = {},
  headers?: Record<string, string>,
): Promise<T> {
  return request<T>(method, path, body, undefined, headers);
}

/** a non-JSON representation (API-45 `?format=markdown`); errors still arrive as the JSON envelope */
export async function apiGetText(path: string, query?: Query): Promise<string> {
  let res: Response;
  try {
    res = await fetcher(`${API_BASE}${withQuery(path, query)}`, {
      method: 'GET',
      headers: { Accept: 'text/markdown, application/json' },
    });
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : 'fetch failed');
  }
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    const data: unknown = type.includes('json') ? await res.json().catch(() => null) : null;
    if (isEnvelope(data)) throw new ApiError(data.error);
    throw new NetworkError(`HTTP ${res.status} without an error envelope from ${path}`);
  }
  if (type.includes('text/html')) throw new NetworkError(`unexpected ${type} from ${path}`);
  return res.text();
}
