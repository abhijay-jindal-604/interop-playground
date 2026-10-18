/** "Keyboard shortcuts" dialog (06 UI-77, UI-32 help dialog): modal `<dialog>`, Esc closes. */
import { useEffect, useId, useRef } from 'react';
import { copy } from '../copy.js';
import { GLOBAL_SHORTCUTS, OTHER_KEYS } from './shortcuts.js';

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
      closeRef.current?.focus();
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [open]);
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
      <h2 id={id}>{copy.shortcuts.heading}</h2>
      <table className="kbd-table">
        <caption className="visually-hidden">{copy.shortcuts.heading}</caption>
        <thead>
          <tr>
            <th scope="col">Keys</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {[...GLOBAL_SHORTCUTS, ...OTHER_KEYS].map((s) => (
            <tr key={s.keys}>
              <td>
                <kbd>{s.keys}</kbd>
              </td>
              <td>{s.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{copy.shortcuts.footer}</p>
      <div className="dialog-actions">
        <button ref={closeRef} type="button" className="btn btn-secondary" onClick={onClose}>
          {copy.shortcuts.close}
        </button>
      </div>
    </dialog>
  );
}
