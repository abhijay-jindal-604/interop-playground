/**
 * The single error envelope of 04 §6 (ADR-33): every non-2xx of /api/v1/* carries
 * {error:{code,message,status,requestId,retryable,details?}}; the HTTP status per code is fixed.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_STATUS } from '@interop-playground/api';
import type { ErrorCode, ErrorEnvelope } from '@interop-playground/api';

/** Codes that carry `Retry-After` (04 §6.1 rule 5). */
const RETRY_AFTER_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'rate_limited',
  'queue_full',
  'env_not_ready',
]);

/** Safe one-sentence default messages; a throw site may give a more specific one. */
const DEFAULT_MESSAGE: Partial<Record<ErrorCode, string>> = {
  validation_failed: 'The request does not match its schema.',
  request_guard_failed: 'The request was refused by the local request guard.',
  unauthorized: 'The admin token is missing or wrong.',
  not_found: 'No such route or resource.',
  payload_too_large: 'The request body is larger than the limit.',
  unsupported_media_type: 'Non-GET requests must send Content-Type: application/json.',
  internal_error: 'The playground hit an unexpected fault; see the BFF log for this request id.',
};

/** `details` of `validation_failed` (04 §6.2): `{issues:[{path, message}]}`. */
export function issueDetails(list: { path: string; message: string }[]): Record<string, unknown> {
  return { issues: list };
}

export function statusOf(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

/** true for 429 and 503 only (04 §6.1). */
export function isRetryable(status: number): boolean {
  return status === 429 || status === 503;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterS: number | undefined;

  constructor(
    code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>,
    retryAfterS?: number,
  ) {
    super(message ?? DEFAULT_MESSAGE[code] ?? code.replace(/_/g, ' '));
    this.name = 'ApiError';
    this.code = code;
    this.status = statusOf(code);
    this.details = details;
    this.retryAfterS = retryAfterS;
  }
}

export function envelope(err: ApiError, requestId: string): ErrorEnvelope {
  const body: ErrorEnvelope = {
    error: {
      code: err.code,
      message: err.message,
      status: err.status,
      requestId,
      retryable: isRetryable(err.status),
    },
  };
  if (err.details !== undefined) body.error.details = err.details;
  return body;
}

export function sendError(reply: FastifyReply, err: ApiError): FastifyReply {
  if (RETRY_AFTER_CODES.has(err.code)) {
    const s =
      err.retryAfterS ??
      (typeof err.details?.retryAfterS === 'number' ? err.details.retryAfterS : 1);
    void reply.header('Retry-After', String(Math.max(1, Math.ceil(s))));
  }
  return reply
    .code(err.status)
    .header('Content-Type', 'application/json; charset=utf-8')
    .send(envelope(err, String(reply.request.id)));
}

/** Maps Fastify's own errors (body parser, limits) onto the 04 §6.2 codes. */
function fromFastifyError(err: FastifyError): ApiError {
  switch (err.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new ApiError('payload_too_large', undefined, { limit: 1024 * 1024 });
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new ApiError('unsupported_media_type', undefined, { expected: 'application/json' });
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return new ApiError(
        'validation_failed',
        'The request body is empty or malformed.',
        issueDetails([{ path: '$', message: err.message }]),
      );
    default:
      break;
  }
  if (err.validation !== undefined) {
    return new ApiError(
      'validation_failed',
      undefined,
      issueDetails(
        err.validation.map((v) => ({
          path: v.instancePath === '' ? '$' : `$${v.instancePath.replace(/\//g, '.')}`,
          message: v.message ?? 'invalid',
        })),
      ),
    );
  }
  if (err instanceof SyntaxError || err.statusCode === 400) {
    return new ApiError(
      'validation_failed',
      'The request body is not valid JSON.',
      issueDetails([{ path: '$', message: 'invalid JSON' }]),
    );
  }
  return new ApiError('internal_error');
}

/** Installs the error and not-found handlers (04 §6.1 rules 3, 4). */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const apiErr = err instanceof ApiError ? err : fromFastifyError(err);
    if (apiErr.code === 'internal_error') {
      // rule 4: exception text goes to the log with the requestId, never into the body
      request.log.error({ err, requestId: request.id }, 'internal_error');
    }
    return sendError(reply, apiErr);
  });
  // the not-found handler (404 envelope, SPA fallback) is installed by routes/static.ts
}
