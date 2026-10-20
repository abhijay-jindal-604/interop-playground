/**
 * Delivery block and dialog (06 UI-16): turn the delivered URI into what the wallet needs: a QR
 * code, a link, or a sentence saying the playground handled delivery itself. The URI is protocol
 * test material and is never redacted.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { deliveryCopy as d } from '../copy.js';
import { announce } from '../lib/announce.js';
import type { DeliveryOutput } from '../inspector/model.js';
import { qrMatrix, qrPath, QUIET_ZONE } from './qr.js';

const kindOf = (op: DeliveryOutput['op']): 'offer' | 'request' =>
  op === 'deliver-offer' ? 'offer' : 'request';

/** Renders the QR code as SVG, or a notice that the link is too long and must be copied instead. */
export function QrCode({ uri, kind }: { uri: string; kind: 'offer' | 'request' }) {
  const m = useMemo(() => qrMatrix(uri), [uri]);
  if (!m) return <p className="qr-too-long">{d.tooLong}</p>;
  const n = m.size + QUIET_ZONE * 2;
  return (
    <svg
      className="qr"
      role="img"
      aria-label={d.qrName(kind)}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      data-qr-level={m.level}
      data-qr-size={m.size}
    >
      <rect width={n} height={n} className="qr-light" />
      <path d={qrPath(m)} className="qr-dark" />
    </svg>
  );
}

/** Copies the offer or request link to the clipboard. */
export function CopyLinkButton({
  uri,
  autoFocusRef,
}: {
  uri: string;
  autoFocusRef?: React.Ref<HTMLButtonElement>;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (state !== 'done') return;
    const t = setTimeout(() => setState('idle'), 2_000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <>
      <button
        ref={autoFocusRef}
        type="button"
        className="btn btn-secondary btn-sm"
        data-action="copy-link"
        onClick={() => {
          const clip = navigator.clipboard;
          if (!clip) {
            setState('failed');
            return;
          }
          clip.writeText(uri).then(
            () => {
              setState('done');
              announce(d.linkCopied);
            },
            () => setState('failed'),
          );
        }}
      >
        {state === 'done' ? d.copied : d.copyLink}
      </button>
      {state === 'failed' ? (
        <p role="alert" className="inline-error-text">
          {d.copyFailed}
        </p>
      ) : null}
    </>
  );
}

function UriPreview({ uri }: { uri: string }) {
  const short = uri.length > 56 ? `${uri.slice(0, 56)}…` : uri;
  return (
    <>
      <p className="mono small wrap qr-uri">{short}</p>
      {uri.length > 56 ? (
        <details className="disclosure">
          <summary>{d.showFull}</summary>
          <pre className="body-code wrap">{uri}</pre>
        </details>
      ) : null}
    </>
  );
}

function ShowLink({ uri }: { uri: string }) {
  return (
    <details className="disclosure">
      <summary>{d.showLink}</summary>
      <pre className="body-code wrap">{uri}</pre>
    </details>
  );
}

/** rendering by `channel` (UI-16 table) */
export function DeliveryBlock({
  delivery,
  firstRef,
}: {
  delivery: DeliveryOutput;
  firstRef?: React.Ref<HTMLButtonElement>;
}) {
  const { uri, channel } = delivery;
  const kind = kindOf(delivery.op);
  switch (channel) {
    case 'deep-link':
      return (
        <div className="delivery" data-channel={channel}>
          <h3 className="delivery-head">{d.sameDevice}</h3>
          <div className="delivery-actions">
            <a className="btn btn-primary btn-sm" href={uri}>
              {d.openLink}
            </a>
            <CopyLinkButton uri={uri} autoFocusRef={firstRef} />
          </div>
        </div>
      );
    case 'adb-intent':
      return (
        <div className="delivery" data-channel={channel}>
          <p>{d.adb}</p>
          <ShowLink uri={uri} />
        </div>
      );
    case 'web-wallet-redirect':
      return (
        <div className="delivery" data-channel={channel}>
          <p>{d.webWallet}</p>
        </div>
      );
    case 'in-process':
      return (
        <div className="delivery" data-channel={channel}>
          <p>{d.inProcess}</p>
          <ShowLink uri={uri} />
        </div>
      );
    default:
      return (
        <div className="delivery" data-channel="qr">
          <QrCode uri={uri} kind={kind} />
          <UriPreview uri={uri} />
          <div className="delivery-actions">
            <CopyLinkButton uri={uri} autoFocusRef={firstRef} />
            <a
              className="btn btn-ghost btn-sm"
              href={uri}
              title={d.openHereTip}
              data-action="open-link"
            >
              {d.openHere}
            </a>
          </div>
        </div>
      );
  }
}

/** the "Delivery" dialog opened from the Engine tab / step rail (UI-16 "Where it appears") */
export function DeliveryDialog({
  delivery,
  onClose,
}: {
  delivery: DeliveryOutput | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const id = useId();
  const open = delivery !== null;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
      first.current?.focus();
    } else if (!open && el.open) {
      if (typeof el.close === 'function') el.close();
      else el.removeAttribute('open');
    }
  }, [open]);
  const title = delivery
    ? kindOf(delivery.op) === 'offer'
      ? d.dialog.offer
      : d.dialog.request
    : d.dialog.title;
  return (
    <dialog
      ref={ref}
      className="dialog delivery-dialog"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id={id}>{title}</h2>
      {delivery ? (
        <DeliveryBlock delivery={{ ...delivery, channel: 'qr' }} firstRef={first} />
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          {d.dialog.close}
        </button>
      </div>
    </dialog>
  );
}
