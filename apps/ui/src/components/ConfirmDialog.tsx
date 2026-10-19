/**
 * `ConfirmDialog` (06 UI-50, UI-30): a modal `<dialog>` (focus trapped by the browser, `Esc`
 * cancels, focus returns to the opener). Errors render inline above the buttons with `role="alert"`
 * and the dialog never closes on an error.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { InlineError } from './InlineError.js';

export function ConfirmDialog({
  open,
  heading,
  children,
  confirmLabel,
  cancelLabel,
  destructive = false,
  defaultFocus = 'cancel',
  busy = false,
  error = null,
  errorText = null,
  onConfirm,
  onClose,
}: {
  open: boolean;
  heading: string;
  children?: ReactNode;
  confirmLabel: string | null;
  cancelLabel: string;
  destructive?: boolean;
  defaultFocus?: 'confirm' | 'cancel';
  busy?: boolean;
  error?: unknown;
  /** a fixed sentence that replaces the generic error copy (like "The run has already finished.") */
  errorText?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
      (defaultFocus === 'confirm' ? confirmRef : cancelRef).current?.focus();
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [open, defaultFocus]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id={id}>{heading}</h2>
      {children}
      {errorText ? (
        <p role="alert" className="inline-error-text">
          {errorText}
        </p>
      ) : error ? (
        <InlineError error={error} />
      ) : null}
      <div className="dialog-actions">
        <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={onClose}>
          {cancelLabel}
        </button>
        {confirmLabel ? (
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${destructive ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        ) : null}
      </div>
    </dialog>
  );
}
