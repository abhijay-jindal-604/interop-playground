/**
 * EnvChip and its popover (06 UI-02): `[mode] · [ready dot] · [tunnel]`; "Offline" once the `env`
 * stream has been reconnecting for more than 10 s. The popover lists every upstream and offers
 * "Probe now" (API-11) and a link to the Environment page.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EnvSnapshot } from '@interop-playground/api';
import { copy } from '../copy.js';
import { hhmm } from '../lib/format.js';
import { useStore } from '../state/store.js';
import { Icon } from '../components/Icon.js';
import { ProbeButton } from './ProbeButton.js';

export function envSummary(snapshot: EnvSnapshot | null, offline: boolean) {
  const mode = snapshot?.mode === 'collab' ? copy.env.modeCollab : copy.env.modeLocal;
  const health: 'ready' | 'degraded' | 'offline' = offline
    ? 'offline'
    : snapshot && !snapshot.ready
      ? 'degraded'
      : 'ready';
  const healthWord =
    health === 'offline'
      ? copy.env.offline
      : health === 'degraded'
        ? copy.env.degraded
        : copy.env.ready;
  const tunnel =
    snapshot?.tunnel.state === 'up'
      ? copy.env.tunnelUpUntil(hhmm(snapshot.tunnel.expiresAt))
      : copy.env.tunnelDown;
  return { mode, health, healthWord, tunnel };
}

export function EnvChip() {
  const env = useStore((s) => s.env);
  const [open, setOpen] = useState(false);
  const popId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const snapshot = env.snapshot.status === 'ready' ? env.snapshot.data : null;
  const loading = env.snapshot.status === 'loading' || env.snapshot.status === 'idle';
  const { mode, health, healthWord, tunnel } = envSummary(snapshot, env.offline);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="env-chip-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={`env-chip health-${health}`}
        aria-expanded={open}
        aria-controls={popId}
        aria-busy={loading || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="env-chip-mode">{mode}</span>
        <span className="env-sep" aria-hidden="true">
          ·
        </span>
        <span className="env-dot" aria-hidden="true" />
        <span>{healthWord}</span>
        <span className="env-sep env-wide" aria-hidden="true">
          ·
        </span>
        <span className="env-wide">{tunnel}</span>
        {snapshot?.mode === 'collab' ? (
          <span className="env-wide">{copy.env.collabBudget(snapshot.collabBudget.used)}</span>
        ) : null}
      </button>
      <div id={popId} className="popover" hidden={!open}>
        <p className="popover-title">
          {mode} · {healthWord} · {tunnel}
        </p>
        {snapshot ? (
          <ul className="upstream-list">
            {snapshot.upstreams.map((u) => (
              <li key={u.upstream}>
                <span className={`dot ${u.ok ? 'ok' : 'bad'}`} aria-hidden="true" />
                <span className="mono">{u.upstream}</span>
                <span className="muted">
                  {u.ok ? copy.env.ready : (u.detail ?? copy.env.degraded)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="popover-actions">
          <ProbeButton size="sm" />
          <Link to="/environment" className="link-arrow" onClick={() => setOpen(false)}>
            {copy.env.openPage}
            <Icon name="chevron" size={16} />
          </Link>
        </div>
      </div>
    </div>
  );
}
