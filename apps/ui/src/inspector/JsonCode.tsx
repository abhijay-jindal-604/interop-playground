/**
 * Read-only JSON with token colours (ADR-119): the text is exactly `pretty(value)`, split into
 * spans for keys, strings, numbers and literals, so copy, search and tests see the same text.
 */
import { Fragment } from 'react';
import { pretty } from './decode.js';

const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

/** Splits pretty-printed JSON into coloured spans; the concatenated text is unchanged. */
export function jsonTokens(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) {
      out.push(
        <span key={at} className={m[2] !== undefined ? 'j-key' : 'j-str'}>
          {m[1]}
        </span>,
      );
      if (m[2] !== undefined) out.push(<Fragment key={`${at}:`}>{m[2]}</Fragment>);
    } else if (m[3] !== undefined) {
      out.push(
        <span key={at} className="j-num">
          {m[3]}
        </span>,
      );
    } else {
      out.push(
        <span key={at} className="j-lit">
          {m[4]}
        </span>,
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A `<pre class="body-code">` with the value pretty-printed and token-coloured. */
export function JsonCode({ value }: { value: unknown }) {
  return <pre className="body-code json-code">{jsonTokens(pretty(value))}</pre>;
}
