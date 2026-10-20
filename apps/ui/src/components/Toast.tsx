/**
 * `Toast` and the ToastRegion (06 UI-01, UI-50): background events only, bottom-left stack,
 * `role="status"`, at most 3 visible, auto-dismiss after 6 s (10 s with an action), paused while
 * hovered or focused; sticky toasts stay until dismissed.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  dismissToast,
  store as appStore,
  useStore,
  type Store,
  type ToastItem,
} from '../state/store.js';
import { Icon } from './Icon.js';

export const TOAST_MS = 6_000;
export const TOAST_ACTION_MS = 10_000;

function Toast({ toast, from }: { toast: ToastItem; from: Store }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.action ? TOAST_ACTION_MS : TOAST_MS);
  useEffect(() => {
    if (toast.sticky || paused) return;
    const started = Date.now();
    const t = setTimeout(() => dismissToast(toast.id, from), remaining.current);
    return () => {
      clearTimeout(t);
      remaining.current -= Date.now() - started;
    };
  }, [paused, toast.id, toast.sticky, from]);
  return (
    <li
      className="toast"
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast-text">{toast.text}</span>
      {toast.action ? (
        <Link
          className="toast-action"
          to={toast.action.href}
          onClick={() => dismissToast(toast.id, from)}
        >
          {toast.action.label}
        </Link>
      ) : null}
      <button
        type="button"
        className="btn-icon"
        aria-label="Dismiss"
        onClick={() => dismissToast(toast.id, from)}
      >
        <Icon name="close" size={16} />
      </button>
    </li>
  );
}

/** Live region that renders the store's toasts. */
export function ToastRegion({ from = appStore }: { from?: Store }) {
  const toasts = useStore((s) => s.toasts, from);
  return (
    <ol className="toast-region" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} from={from} />
      ))}
    </ol>
  );
}
