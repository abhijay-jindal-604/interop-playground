/**
 * `FakeSidecar` (plan/11 §3.1): a loopback HTTP server answering the JVM sidecar's API-60..69 with
 * the shapes of 04 §3.8, scripted per test. Errors use the 04 §6 envelope restricted to
 * `validation_failed` 400, `not_found` 404, `callback_not_pending` 409, `engine_exception` 422.
 *
 * VCI session: created `running` with the script's callbacks pending; `pending?after=n` returns the
 * callbacks with index >= n (long-polls up to `holdMs` when none); answering every callback makes the
 * session `done` (or `failed` when the script says so).
 *
 * This file is a test server, so it uses node:http directly (on the NO_RAW_HTTP_ALLOWED list, ADR-68).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CredentialFormat,
  ErrorEnvelope,
  SidecarHealth,
  VcVerifyResponse,
  VciCallback,
  VciPendingResponse,
  VciResult,
  VpAuthenticateResponse,
  VpResponseResponse,
  VpUnsignedTokenResponse,
} from '@interop-playground/api';

export interface FakeSidecarScript {
  callbacks?: VciCallback[];
  /** final state after every callback was answered */
  vciOutcome?:
    | { state: 'done'; credential: unknown; configId: string; format: CredentialFormat }
    | { state: 'failed'; exceptionClass: string; message: string };
  /** API-62 hold when no callback is pending (the real sidecar holds 25 s) */
  holdMs?: number;
  /** API-66..69: throw this jar exception (422 engine_exception) instead of answering */
  vpException?: { exceptionClass: string; message: string };
  verify?: VcVerifyResponse;
}

export interface FakeSidecar {
  url: string;
  /** every request seen, in order */
  calls: { method: string; path: string; body: unknown }[];
  close(): Promise<void>;
}

interface Session {
  callbacks: VciCallback[];
  answered: Set<string>;
  deleted: boolean;
}

let counter = 0;
/** a valid Crockford ULID (26 chars), unique per call */
function fakeUlid(): string {
  counter += 1;
  return `01K7FAKE${String(counter).padStart(18, '0')}`;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function fail(
  res: ServerResponse,
  code: 'validation_failed' | 'not_found' | 'callback_not_pending' | 'engine_exception',
  message: string,
  details?: Record<string, unknown>,
): void {
  const status = {
    validation_failed: 400,
    not_found: 404,
    callback_not_pending: 409,
    engine_exception: 422,
  }[code];
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      status,
      requestId: fakeUlid(),
      retryable: false,
      ...(details ? { details } : {}),
    },
  };
  send(res, status, body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return Symbol.for('invalid-json');
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const DEFAULT_PROOF_CALLBACK: VciCallback = {
  id: 'cb-1',
  type: 'proof',
  aud: 'https://192.0.2.10',
  nonce: 'fake-c-nonce-0001',
  alg: ['ES256'],
};

export async function startFakeSidecar(script: FakeSidecarScript = {}): Promise<FakeSidecar> {
  const sessions = new Map<string, Session>();
  const vpSessions = new Set<string>();
  const calls: FakeSidecar['calls'] = [];
  const holdMs = script.holdMs ?? 25_000;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const pendingOf = (s: Session, after: number): VciPendingResponse => {
    const list = s.callbacks.slice(after).filter((c) => !s.answered.has(c.id));
    return { callbacks: list, next: after + list.length };
  };
  const resultOf = (s: Session): VciResult => {
    if (s.answered.size < s.callbacks.length) return { state: 'running' };
    return (
      script.vciOutcome ?? {
        state: 'done',
        credential: 'eyJ.fake.credential',
        configId: 'PlaygroundSdJwt',
        format: 'dc+sd-jwt',
      }
    );
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://sidecar');
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    calls.push({ method: req.method ?? 'GET', path: url.pathname + url.search, body });
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      const h: SidecarHealth = {
        status: 'ok',
        version: '0.1.0-fake',
        jars: {
          vciClient: 'inji-vci-client 0.4.0',
          openid4vp: 'inji-openid4vp 0.3.0',
          vcverifier: 'vcverifier-jar 1.9.0',
        },
      };
      return send(res, 200, h);
    }
    if (parts[0] === 'vci' && parts[1] === 'sessions') {
      if (method === 'POST' && parts.length === 2) {
        if (
          !isObj(body) ||
          typeof body.offerUri !== 'string' ||
          !body.offerUri.startsWith('openid-credential-offer://')
        ) {
          return fail(
            res,
            'validation_failed',
            'offerUri must be an openid-credential-offer:// URI.',
          );
        }
        const sessionId = fakeUlid();
        sessions.set(sessionId, {
          callbacks: script.callbacks ?? [DEFAULT_PROOF_CALLBACK],
          answered: new Set(),
          deleted: false,
        });
        return send(res, 201, { sessionId });
      }
      const s = sessions.get(parts[2] ?? '');
      if (!s || s.deleted) {
        if (method === 'DELETE') return send(res, 204);
        return fail(res, 'not_found', 'No such session.');
      }
      if (method === 'GET' && parts[3] === 'pending') {
        const after = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isInteger(after) || after < 0)
          return fail(res, 'validation_failed', 'after must be a cursor.');
        const now = pendingOf(s, after);
        if (now.callbacks.length > 0 || holdMs === 0) return send(res, 200, now);
        const t = setTimeout(() => {
          timers.delete(t);
          send(res, 200, pendingOf(s, after));
        }, holdMs);
        timers.add(t);
        return;
      }
      if (method === 'POST' && parts[3] === 'answers') {
        const cb = s.callbacks.find((c) => c.id === parts[4]);
        if (!cb) return fail(res, 'not_found', 'No such callback.');
        if (s.answered.has(cb.id))
          return fail(res, 'callback_not_pending', 'That callback is no longer pending.');
        const field = cb.type === 'proof' ? 'jws' : 'txCode';
        if (!isObj(body) || typeof body[field] !== 'string')
          return fail(res, 'validation_failed', `${field} is required.`);
        if (cb.type === 'proof' && 'privateKey' in body)
          return fail(res, 'validation_failed', 'The sidecar never accepts a key.');
        s.answered.add(cb.id);
        return send(res, 204);
      }
      if (method === 'GET' && parts[3] === 'result') {
        const r = resultOf(s);
        return send(res, r.state === 'running' ? 202 : 200, r);
      }
      if (method === 'DELETE' && parts.length === 3) {
        s.deleted = true;
        return send(res, 204);
      }
    }
    if (method === 'POST' && (parts[0] === 'vp' || parts[0] === 'vc')) {
      if (!isObj(body)) return fail(res, 'validation_failed', 'A JSON body is required.');
      if (script.vpException)
        return fail(res, 'engine_exception', 'A library threw an exception.', {
          ...script.vpException,
        });
      const route = parts.join('/');
      if (route === 'vp/authenticate') {
        if (typeof body.urlEncodedRequest !== 'string')
          return fail(res, 'validation_failed', 'urlEncodedRequest is required.');
        const sessionId = fakeUlid();
        vpSessions.add(sessionId);
        const r: VpAuthenticateResponse = {
          sessionId,
          authorizationRequest: {
            clientId: 'playground-verifier',
            responseUri: 'https://192.0.2.10:8443/v1/verify/v2/vp-submission/direct-post',
            nonce: 'fake-nonce-0123456789',
            state: 'fake-state',
            responseMode: 'direct_post',
            dcqlQuery: { credentials: [{ id: 'pg', format: 'dc+sd-jwt' }] },
          },
        };
        return send(res, 200, r);
      }
      if (route === 'vp/unsigned-token' || route === 'vp/response') {
        if (typeof body.sessionId !== 'string' || !vpSessions.has(body.sessionId))
          return fail(res, 'not_found', 'No such VP session.');
        if (route === 'vp/unsigned-token') {
          const r: VpUnsignedTokenResponse = { toSign: 'eyJhbGciOiJFUzI1NiJ9.e30', alg: 'ES256' };
          return send(res, 200, r);
        }
        if (typeof body.signature !== 'string')
          return fail(res, 'validation_failed', 'signature is required.');
        const r: VpResponseResponse = {
          vpToken: '{"pg":["eyJ.fake~"]}',
          state: 'fake-state',
          responseUri: 'https://192.0.2.10:8443/v1/verify/v2/vp-submission/direct-post',
        };
        return send(res, 200, r);
      }
      if (route === 'vc/verify') {
        if (typeof body.format !== 'string' || typeof body.raw !== 'string')
          return fail(res, 'validation_failed', 'format and raw are required.');
        const r: VcVerifyResponse = script.verify ?? {
          verificationStatus: true,
          code: null,
          message: null,
          rawResult: { verificationStatus: true },
        };
        return send(res, 200, r);
      }
    }
    return fail(res, 'not_found', `No route ${method} ${url.pathname}.`);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() =>
      send(res, 500, {
        error: {
          code: 'internal_error',
          message: 'fake failed',
          status: 500,
          requestId: fakeUlid(),
          retryable: false,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
