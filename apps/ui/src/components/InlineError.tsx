/**
 * `InlineError({error})` (06 UI-31 ErrorLine, UI-50): `role="alert"`, the fixed copy for the code,
 * then "Reference {requestId}" in muted mono; the server message only under "Details". Never a toast.
 */
import type { ReactNode } from 'react';
import { ApiError, NetworkError } from '../api/client.js';
import { copy, errorText } from '../copy.js';
import { Disclosure } from './Disclosure.js';

/** Shows an error in place, with a retry button when a retry is possible. */
export function InlineError({
  error,
  onRetry,
  alert = true,
}: {
  error: unknown;
  onRetry?: () => void;
  /** page-load errors in a region pass `false` and use the region's own heading */
  alert?: boolean;
}) {
  let text: string;
  let reference: ReactNode = null;
  let details: ReactNode = null;
  if (error instanceof ApiError) {
    text = errorText(error.code, error.details);
    const known = text !== errorText('internal_error') || error.code === 'internal_error';
    reference = (
      <span className="error-ref">
        {copy.reference(error.requestId)}
        {known ? null : ` (${error.code})`}
      </span>
    );
    details = (
      <Disclosure summary={copy.details}>
        <pre className="code-block" tabIndex={0} aria-label="Error details">
          {JSON.stringify(
            { code: error.code, message: error.serverMessage, details: error.details ?? null },
            null,
            2,
          )}
        </pre>
      </Disclosure>
    );
  } else if (error instanceof NetworkError) {
    text = copy.networkFailure;
  } else {
    text = errorText('internal_error');
  }
  return (
    <div className="inline-error" role={alert ? 'alert' : undefined}>
      <p className="inline-error-text">{text}</p>
      {reference}
      {details}
      {onRetry ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          {copy.tryAgain}
        </button>
      ) : null}
    </div>
  );
}
