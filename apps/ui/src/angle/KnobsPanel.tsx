/**
 * UI-07 "Advanced options": the run label and the KnobList (API-04 entries applicable to the
 * selection, 09 A4). Only the knobs that differ from their default are sent (`CreateRunRequest.knobs`);
 * the summary line says when any knob differs. Preset, credential configuration and the tx_code / IAE
 * checkboxes of UI-07 are not part of this panel yet (wave 6 C scope: knobs).
 */
import { useId, useState } from 'react';
import type { AdapterId, CredentialFormat, KnobEntry } from '@interop-playground/api';
import { Skeleton } from '../components/Skeleton.js';
import { angleCopy } from '../copy.js';
import { useStore } from '../state/store.js';
import { knobList } from './model.js';

const c = angleCopy.knobs;
const STATUS_TONE = { proven: 'pass', unproven: 'neutral', 'no-value-passes': 'warn' } as const;

export type KnobChoice = Record<string, string>;

/** UI-07 applicability: the entry's adapters meet the chosen ones and the format is offered */
export function applicableKnobs(
  knobs: readonly KnobEntry[],
  adapters: readonly AdapterId[],
  format: CredentialFormat,
): KnobEntry[] {
  return knobs.filter(
    (k) => k.adapters.some((a) => adapters.includes(a)) && k.def.formats.includes(format),
  );
}

/** Whether a knob can be set for the chosen adapters and format, and why not when it cannot. */
export function knobStatus(
  k: KnobEntry,
  format: CredentialFormat,
  adapters: readonly AdapterId[],
): KnobEntry['status'][string] {
  for (const a of adapters) {
    const s = k.status[`${format}@${a}`];
    if (s) return s;
  }
  return k.status[format] ?? 'unproven';
}

function lockReason(k: KnobEntry, adapters: readonly AdapterId[]): string | null {
  if (adapters.includes('issuer.certify-collab') && k.adapters.includes('issuer.certify-collab'))
    return c.lockedCollab;
  if (k.def.id === 'KNOB-07' && adapters.includes('wallet.inji-mobile')) return c.lockedMobile;
  return null;
}

/** the non-default values only (the server writes defaults for the rest) */
export function changedKnobs(choice: KnobChoice, list: readonly KnobEntry[]): KnobChoice {
  const out: KnobChoice = {};
  for (const k of list) {
    const v = choice[k.def.id];
    if (v !== undefined && v !== k.def.defaultValue) out[k.def.id] = v;
  }
  return out;
}

/** The panel of knobs on the selector, grouped by adapter. */
export function KnobsPanel({
  adapters,
  format,
  choice,
  label,
  onChoice,
  onLabel,
}: {
  adapters: readonly AdapterId[];
  format: CredentialFormat;
  choice: KnobChoice;
  label: string;
  onChoice: (next: KnobChoice) => void;
  onLabel: (label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const labelId = useId();
  const load = useStore((s) => s.catalog.knobs);
  const list =
    load.status === 'ready' ? applicableKnobs(knobList(load.data), adapters, format) : [];
  const changed = Object.keys(changedKnobs(choice, list)).length;
  return (
    <div className="advanced-panel" data-testid="advanced-options">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        {c.disclosure}
      </button>
      <div id={bodyId} hidden={!open} className="advanced-body">
        <p>
          <label htmlFor={labelId}>{c.label}</label>{' '}
          <input
            id={labelId}
            type="text"
            maxLength={80}
            value={label}
            onChange={(e) => onLabel(e.target.value)}
          />
        </p>
        <h3 className="lineage-heading">{c.heading}</h3>
        {load.status === 'loading' || load.status === 'idle' ? (
          <div aria-busy="true">
            <p className="muted small">{c.loading}</p>
            <Skeleton height="1.5rem" />
          </div>
        ) : load.status === 'error' ? (
          <p className="small tone-warn-text">{c.error}</p>
        ) : list.length === 0 ? (
          <p className="muted small">{c.none}</p>
        ) : (
          <ul className="knob-list">
            {list.map((k) => {
              const st = knobStatus(k, format, adapters);
              const locked = lockReason(k, adapters);
              const sid = `${bodyId}-${k.def.id}`;
              const ordered = [
                k.def.defaultValue,
                ...k.def.values.filter((v) => v !== k.def.defaultValue),
              ];
              return (
                <li key={k.def.id} className="knob-row" data-knob={k.def.id}>
                  <label htmlFor={sid}>
                    <code>{k.def.name}</code>
                  </label>
                  <select
                    id={sid}
                    value={choice[k.def.id] ?? k.def.defaultValue}
                    disabled={locked !== null}
                    onChange={(e) => onChoice({ ...choice, [k.def.id]: e.target.value })}
                  >
                    {ordered.map((v) => (
                      <option key={v} value={v}>
                        {v === k.def.defaultValue ? `${v} ${c.defaultMark}` : v}
                      </option>
                    ))}
                  </select>
                  <span className={`badge tone-${STATUS_TONE[st]}`} title={c.statusTip[st]}>
                    {c.status[st]}
                  </span>
                  <span className="small muted">{k.label}</span>
                  {locked ? <span className="small muted">{locked}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
        {changed > 0 ? <p className="small">{c.summary(changed)}</p> : null}
      </div>
    </div>
  );
}
