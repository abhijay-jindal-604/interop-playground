/**
 * Body viewer (06 UI-20): Pretty / Raw / Decoded modes, every `bodyState` named in words, redaction
 * chips (UI-19), SHA-256 footer. Bodies are shown as they were on the wire; nothing is decorated.
 */
import { useState, type ReactNode } from 'react';
import type { BodyRef, BodyState, CapturedMessage } from '@interop-playground/api';
import { ApiError, apiGet } from '../api/client.js';
import { CopyButton } from '../components/CopyButton.js';
import { inspectorCopy as c } from '../copy.js';
import {
  bodyKind,
  decodeJwt,
  decodeSdJwt,
  parseForm,
  parseJson,
  pretty,
  splitRedactions,
  type DecodedJwt,
} from './decode.js';

const KIB = 1024;
const INLINE_CAP = 64 * KIB;
const STORE_CAP = 256 * KIB;
const kib = (n: number) => Math.ceil(n / KIB);

export type BodyMode = 'pretty' | 'raw' | 'decoded';

/** text with `«redacted:NAME»` shown as chips (UI-19) */
export function Redacted({ text }: { text: string }) {
  const parts = splitRedactions(text);
  if (parts.length === 1 && 'text' in parts[0]!) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        'text' in p ? (
          <span key={i}>{p.text}</span>
        ) : (
          <span key={i} className="chip chip-redacted" title={c.messages.redactedTip}>
            {c.messages.redacted(p.redacted)}
          </span>
        ),
      )}
    </>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="body-block">
      <p className="body-block-title">{title}</p>
      {children}
    </div>
  );
}

const Code = ({ text }: { text: string }) => (
  <pre className="body-code">
    <Redacted text={text} />
  </pre>
);

export function JwtBlocks({ jwt, title }: { jwt: DecodedJwt; title?: string }) {
  return (
    <div className="body-jwt" data-jwt={title ?? 'jwt'}>
      {title ? <p className="body-block-title">{title}</p> : null}
      <Block title={c.body.header}>
        <Code text={pretty(jwt.header)} />
      </Block>
      <Block title={c.body.payload}>
        <Code text={typeof jwt.payload === 'string' ? jwt.payload : pretty(jwt.payload)} />
      </Block>
      <Block title={c.body.signature}>
        <Code text={jwt.signature} />
      </Block>
    </div>
  );
}

function FormTable({ rows }: { rows: [string, string][] }) {
  return (
    <div className="table-scroll">
      <table className="data-table form-table">
        <thead>
          <tr>
            <th scope="col">{c.body.formName}</th>
            <th scope="col">{c.body.formValue}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i}>
              <th scope="row" className="mono">
                {k}
              </th>
              <td className="mono wrap">
                <Redacted text={v} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** the decoded rendering of a JWT / SD-JWT / form / JSON-in-form body (Decoded mode) */
export function DecodedBody({ text }: { text: string }) {
  const t = text.trim();
  const sd = decodeSdJwt(t);
  if (sd) {
    return (
      <>
        <JwtBlocks jwt={sd.issuerJwt} title={c.body.issuerJwt} />
        {sd.disclosures.map((d, i) => (
          <Block key={d.raw} title={c.body.disclosure(i + 1)}>
            <Code
              text={JSON.stringify(d.name === null ? [d.salt, d.value] : [d.salt, d.name, d.value])}
            />
          </Block>
        ))}
        {sd.kbJwt ? <JwtBlocks jwt={sd.kbJwt} title={c.body.kbJwt} /> : null}
      </>
    );
  }
  const jwt = decodeJwt(t);
  if (jwt) return <JwtBlocks jwt={jwt} />;
  const form = parseForm(t);
  if (form) {
    return (
      <>
        {form.map(([k, v]) => (
          <Block key={k} title={k}>
            {decodeSdJwt(v) || decodeJwt(v) ? (
              <DecodedBody text={v} />
            ) : (
              <Code text={parseJson(v) !== undefined ? pretty(parseJson(v)) : v} />
            )}
          </Block>
        ))}
      </>
    );
  }
  return <Code text={t} />;
}

function PrettyBody({ text, mediaType }: { text: string; mediaType: string | null }) {
  const kind = bodyKind(text);
  if (kind === 'json') return <Code text={pretty(parseJson(text))} />;
  if (kind === 'form' || mediaType?.includes('x-www-form-urlencoded')) {
    const rows = parseForm(text);
    if (rows) return <FormTable rows={rows} />;
  }
  if (kind === 'jwt' || kind === 'sd-jwt') return <DecodedBody text={text} />;
  return <Code text={text} />;
}

const decodable = (text: string, mediaType: string | null): boolean => {
  const k = bodyKind(text);
  return k === 'jwt' || k === 'sd-jwt' || k === 'form' || mediaType === 'application/cbor';
};

export function BodyStateChip({ state, truncated }: { state: BodyState; truncated: boolean }) {
  const word = state === 'stored' && truncated ? c.body.state.truncated : c.body.state[state];
  const tone =
    state === 'stored'
      ? truncated
        ? 'tone-warn'
        : 'tone-neutral'
      : state === 'none'
        ? 'tone-skipped'
        : 'tone-warn';
  return (
    <span className={`badge ${tone}`} data-body-state={state}>
      {word}
    </span>
  );
}

export function BodyViewer({
  runId,
  exchangeId,
  part,
  body,
  bodyState,
  mediaType,
}: {
  runId: string | null;
  exchangeId: string;
  part: 'Request' | 'Response';
  body: BodyRef | null;
  bodyState: BodyState;
  mediaType: string | null;
}) {
  const [full, setFull] = useState<BodyRef | null>(null);
  const [loading, setLoading] = useState<'idle' | 'loading' | 'gone' | 'missing'>('idle');
  const shown = full ?? body;
  const text = shown?.encoding === 'utf8' ? shown.text : null;
  const big = (shown?.size ?? 0) > 100 * KIB;
  const [mode, setMode] = useState<BodyMode>(big ? 'raw' : 'pretty');
  const [name] = useState(() => `bm-${exchangeId}-${part}`);

  if (bodyState === 'none' || (bodyState === 'stored' && !shown)) {
    return <p className="muted body-note">{c.body.none}</p>;
  }
  if (bodyState === 'pruned' || loading === 'gone') {
    return <p className="muted body-note">{c.body.pruned}</p>;
  }
  if (bodyState === 'dropped_run_cap') {
    return <p className="muted body-note">{c.body.dropped}</p>;
  }
  if (!shown) return null;

  const canDecode = text !== null && decodable(text, mediaType);
  const effective: BodyMode = mode === 'decoded' && !canDecode ? 'pretty' : mode;
  const loadFull = () => {
    if (!runId) return;
    setLoading('loading');
    apiGet<CapturedMessage>(`/runs/${runId}/exchanges/${encodeURIComponent(exchangeId)}`)
      .then((m) => {
        const b = part === 'Request' ? m.request.body : (m.response?.body ?? null);
        setFull(b);
        setLoading('idle');
      })
      .catch((err: unknown) => {
        setLoading(err instanceof ApiError && err.code === 'gone' ? 'gone' : 'missing');
      });
  };

  return (
    <div className="body-viewer">
      <div className="body-toolbar">
        <div role="radiogroup" aria-label={c.body.modes} className="seg">
          {(['pretty', 'raw', 'decoded'] as const).map((m) =>
            m === 'decoded' && !canDecode ? null : (
              <label key={m} className="seg-option">
                <input
                  type="radio"
                  name={name}
                  value={m}
                  checked={effective === m}
                  onChange={() => setMode(m)}
                />
                <span>{c.body[m]}</span>
              </label>
            ),
          )}
        </div>
        <BodyStateChip state={bodyState} truncated={shown.truncated} />
        {text !== null ? <CopyButton text={text} label={c.messages.copyBody} /> : null}
      </div>
      {shown.truncated && shown.size <= STORE_CAP && !full ? (
        <p className="body-note">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={loadFull}
            disabled={loading === 'loading'}
          >
            {loading === 'loading' ? 'Loading the full body…' : c.body.loadFull(kib(shown.size))}
          </button>
        </p>
      ) : null}
      {shown.truncated && shown.size > STORE_CAP ? (
        <p className="body-note muted">{c.body.capped(kib(shown.size), shown.sha256)}</p>
      ) : null}
      {loading === 'missing' ? (
        <p className="body-note muted">This message is not available.</p>
      ) : null}
      <div className="body-area" role="region" aria-label={c.body.region(part)} tabIndex={0}>
        {shown.encoding === 'base64' ? (
          effective === 'raw' ? (
            <Code text={shown.text} />
          ) : (
            <p className="muted">{c.body.binary(shown.size)}</p>
          )
        ) : effective === 'raw' ? (
          <Code text={text ?? ''} />
        ) : effective === 'decoded' ? (
          <DecodedBody text={text ?? ''} />
        ) : (
          <PrettyBody text={text ?? ''} mediaType={mediaType} />
        )}
      </div>
      <p className="body-foot muted small">
        <span className="mono">{c.body.sha(shown.sha256)}</span>
        <CopyButton text={shown.sha256} label={c.body.copySha} />
      </p>
    </div>
  );
}

export const INLINE_BODY_CAP = INLINE_CAP;
