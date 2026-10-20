/** `Disclosure` (06 UI-50): a native `<details>` with a styled summary. */
import type { ReactNode } from 'react';

/** A collapsible section built on the native `details` element. */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="disclosure">
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
