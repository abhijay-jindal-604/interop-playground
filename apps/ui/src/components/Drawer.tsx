/**
 * `Drawer` (06 UI-50, UI-29): a right-hand panel; focus moves to its heading on open, `Esc` closes
 * and focus returns to the trigger. Modal drawers use `<dialog>` so focus is trapped by the browser.
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon.js';

/** A side panel dialog with a title and close button. */
export function Drawer({
  open,
  title,
  onClose,
  returnFocus,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      heading.current?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      returnFocus?.current?.focus();
    }
  }, [open, returnFocus]);
  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop
      }}
    >
      <div className="drawer-inner">
        <div className="drawer-head">
          <h2 id={id} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            <Icon name="close" size={16} />
            <span>Close</span>
          </button>
        </div>
        <div className="drawer-body">{open ? children : null}</div>
        {footer ? <div className="drawer-foot">{footer}</div> : null}
      </div>
    </dialog>
  );
}
