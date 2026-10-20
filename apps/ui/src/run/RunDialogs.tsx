/** The three dialogs of the run screen (06 UI-30): cancel (API-23), note (API-36), delete (API-25). */
import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Run } from '@interop-playground/api';
import { ApiError, apiSend } from '../api/client.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { RunLink, shortId } from '../components/RunLink.js';
import { runDialogCopy as c } from '../copy.js';
import { pushToast } from '../state/store.js';

/** Confirmation dialog for cancelling a run. */
export function CancelDialog({
  runId,
  open,
  onClose,
}: {
  runId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const finished = error instanceof ApiError && error.code === 'run_not_cancellable';
  const close = () => {
    setError(null);
    onClose();
  };
  return (
    <ConfirmDialog
      open={open}
      heading={c.cancel.heading}
      confirmLabel={finished ? null : c.cancel.confirm}
      cancelLabel={finished ? c.cancel.close : c.cancel.keep}
      destructive
      busy={busy}
      error={finished ? null : error}
      errorText={finished ? c.cancel.alreadyFinished : null}
      onClose={close}
      onConfirm={() => {
        setBusy(true);
        apiSend('POST', `/runs/${runId}/cancel`)
          .then(close)
          .catch(setError)
          .finally(() => setBusy(false));
      }}
    >
      <p>{c.cancel.body}</p>
    </ConfirmDialog>
  );
}

/** Dialog for editing the run's short note (label). */
export function NoteDialog({
  runId,
  note,
  open,
  onClose,
  onSaved,
}: {
  runId: string;
  note: string | null;
  open: boolean;
  onClose: () => void;
  onSaved: (run: Run) => void;
}) {
  const [text, setText] = useState(note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const id = useId();
  const notTerminal = error instanceof ApiError && error.code === 'run_not_terminal';
  const save = () => {
    setBusy(true);
    apiSend<Run>('PATCH', `/runs/${runId}`, { note: text.trim() === '' ? null : text })
      .then((run) => {
        onSaved(run);
        onClose();
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };
  return (
    <ConfirmDialog
      open={open}
      heading={c.note.heading}
      confirmLabel={text.trim() === '' && note ? c.note.clear : c.note.save}
      cancelLabel={c.note.cancel}
      defaultFocus="confirm"
      busy={busy}
      error={notTerminal ? null : error}
      errorText={notTerminal ? c.note.notTerminal : null}
      onClose={onClose}
      onConfirm={save}
    >
      <label htmlFor={id}>{c.note.label}</label>
      <textarea
        id={id}
        className="textarea"
        maxLength={2000}
        rows={5}
        value={text}
        aria-describedby={`${id}-help`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) save();
        }}
      />
      <p id={`${id}-help`} className="field-note">
        {c.note.helper} <span className="counter">{c.note.counter(text.length)}</span>
      </p>
    </ConfirmDialog>
  );
}

/** Confirmation dialog for deleting a run; warns when the run is pinned. */
export function DeleteDialog({
  runId,
  pinned,
  open,
  onClose,
}: {
  runId: string;
  pinned: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cascade, setCascade] = useState<{ children: string[]; controlOf: string | null } | null>(
    null,
  );
  const run = (withCascade: boolean) => {
    setBusy(true);
    apiSend('DELETE', `/runs/${runId}${withCascade ? '?cascade=true' : ''}`)
      .then(() => {
        onClose();
        pushToast({ text: c.delete.deletedToast(shortId(runId)) });
        void navigate('/');
      })
      .catch((err: unknown) => {
        if (!withCascade && err instanceof ApiError && err.code === 'run_in_use') {
          const d = err.details ?? {};
          setCascade({
            children: Array.isArray(d.childRunIds) ? (d.childRunIds as string[]) : [],
            controlOf: typeof d.controlOf === 'string' ? d.controlOf : null,
          });
          setError(null);
          return;
        }
        setError(err);
      })
      .finally(() => setBusy(false));
  };
  const close = () => {
    setCascade(null);
    setError(null);
    onClose();
  };
  if (cascade) {
    const n = cascade.children.length;
    return (
      <ConfirmDialog
        open={open}
        heading={c.delete.cascadeHeading}
        confirmLabel={c.delete.cascadeConfirm(n)}
        cancelLabel={c.delete.cancel}
        destructive
        busy={busy}
        error={error}
        onClose={close}
        onConfirm={() => run(true)}
      >
        <p>{c.delete.cascadeBody(n, cascade.controlOf)}</p>
        <ul>
          {cascade.children.map((id) => (
            <li key={id}>
              <RunLink runId={id} copyable={false} />
            </li>
          ))}
        </ul>
        <p>{c.delete.cascadeTail}</p>
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog
      open={open}
      heading={c.delete.heading}
      confirmLabel={c.delete.confirm}
      cancelLabel={c.delete.cancel}
      destructive
      busy={busy}
      error={error}
      onClose={close}
      onConfirm={() => run(false)}
    >
      <p>{c.delete.body}</p>
      {pinned ? <p>{c.delete.pinned}</p> : null}
    </ConfirmDialog>
  );
}
