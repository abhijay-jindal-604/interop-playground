/**
 * UI-24 diagnosis card and UI-25 fix-it panel (angle A, 09 A3, A5.1, ADR-21). The card renders one
 * of four cases from the `role: cause` matches; the panel renders only for an Exact cause with one
 * proven offer on a failed local run, and starts the child with one click (no confirm dialog).
 */
import { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  CheckResult,
  CounterfactualOfferedPayload,
  DiagnosisResponse,
  KnobEntry,
  Run,
} from '@interop-playground/api';
import { ApiError, apiSend } from '../api/client.js';
import { InlineError } from '../components/InlineError.js';
import { angleCopy as c, runCopy } from '../copy.js';
import { Icon } from '../components/Icon.js';
import { screenCopy } from '../run/screen-copy.js';
import {
  diagnosisCase,
  fixItDecision,
  knobEntry,
  sideWord,
  type DiagnosisCase,
  type Match,
} from './model.js';

const CASE_TONE: Record<DiagnosisCase, string> = {
  exact: 'info',
  possible: 'warn',
  observed: 'neutral',
  unclassified: 'neutral',
};

function CauseBlock({
  m,
  open,
  onToggle,
  onShowMessages,
  onShowCheck,
}: {
  m: Match;
  open: boolean;
  onToggle: () => void;
  onShowMessages?: ((m: Match) => void) | undefined;
  onShowCheck?: (() => void) | undefined;
}) {
  const id = useId();
  return (
    <div className="cause-block" data-fingerprint={m.fingerprintId}>
      <button
        type="button"
        className="cause-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <code>{m.fingerprintId}</code> <span>{m.title}</span>
      </button>
      <div id={id} className="cause-body" hidden={!open}>
        <p data-testid="deviating-side">
          {c.card.side(sideWord(m.deviatingSide), m.component.name, m.component.versions)}
        </p>
        {m.specClause ? <p>{c.card.spec(m.specClause)}</p> : null}
        <p>{c.card.gaps(m.gapIds.join(', ') || c.card.none)}</p>
        <p>
          {c.card.evidence}
          <code title={c.card.evidenceTip}>{c.card.evidencePath(m.fingerprintId)}</code>
        </p>
        {onShowMessages || onShowCheck ? (
          <p className="cause-actions">
            {onShowMessages && m.matchedExchangeIds.length > 0 ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onShowMessages(m)}
              >
                {c.card.showMessages}
              </button>
            ) : null}
            {onShowCheck ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onShowCheck}>
                {c.card.showCheck}
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function NoFixLine({ reason }: { reason: string }) {
  const text = c.noFix[reason];
  if (!text) return null;
  return (
    <p className="nofix-line muted" data-nofix={reason}>
      {text}
    </p>
  );
}

/** UI-25 */
export function FixItPanel({
  runId,
  offer,
  knob,
  peerName,
  onGone,
}: {
  runId: string;
  offer: CounterfactualOfferedPayload;
  knob: KnobEntry | null;
  /** display name of the component a `peer-runtime-option` knob changes */
  peerName: string | null;
  /** `version_drift` / `environment_changed`: a retry cannot succeed, the panel is replaced */
  onGone: (line: string) => void;
}) {
  const navigate = useNavigate();
  // one Idempotency-Key per panel mount: a double click cannot create two children
  const key = useRef<string>(crypto.randomUUID());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const name = knob?.def.name ?? offer.knobId;
  const applies = knob?.def.appliesAt ?? offer.applyKind;
  const start = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const child = await apiSend<Run>(
        'POST',
        `/runs/${encodeURIComponent(runId)}/derive`,
        { knobId: offer.knobId, value: offer.to },
        { 'Idempotency-Key': key.current },
      );
      void navigate(`/runs/${child.runId}`);
    } catch (err) {
      setSending(false);
      setError(err);
      if (err instanceof ApiError && err.code === 'version_drift') {
        const d = err.details ?? {};
        const s = (k: string) => (typeof d[k] === 'string' ? d[k] : null);
        const column = s('column') ?? s('role');
        onGone(
          column
            ? c.versionDrift(column, s('was') ?? '?', s('now') ?? '?')
            : (c.noFix['version-drift'] ?? ''),
        );
      } else if (err instanceof ApiError && err.code === 'environment_changed') {
        onGone(c.noFix['environment-changed'] ?? '');
      }
    }
  };
  return (
    <section className="fixit-panel" aria-label={c.fix.region} data-testid="fixit-panel">
      <div className="fixit-head">
        <h3 className="fixit-title">{c.fix.title}</h3>
        <span className="fixit-count">
          <span className="fixit-count-n" aria-hidden="true">
            1
          </span>
          {screenCopy.fix.oneChange}
        </span>
      </div>
      <p className="fixit-change">
        <code className="fixit-knob" title={knob?.label ?? undefined}>
          {name}
        </code>
        <span className="fixit-sep"> · </span>
        <q className="fixit-from" title={screenCopy.fix.from}>
          {offer.from}
        </q>{' '}
        <span className="fixit-arrow" title={c.fix.arrowTip}>
          →
        </span>{' '}
        <q className="fixit-to" title={screenCopy.fix.to}>
          {offer.to}
        </q>
      </p>
      {knob?.label ? <p className="chip chip-outline fixit-label">{knob.label}</p> : null}
      <p className="small">{c.fix.explainer}</p>
      {applies === 'wallet-runtime' ? <p className="small">{c.fix.walletRuntime}</p> : null}
      {applies === 'peer-runtime-option' && peerName ? (
        <p className="small">{c.fix.peerRuntime(peerName)}</p>
      ) : null}
      <p className="small muted">{c.fix.provenBy}</p>
      {error ? <InlineError error={error} /> : null}
      <button
        type="button"
        className="btn btn-primary"
        data-knob-target
        disabled={sending}
        onClick={() => void start()}
      >
        <Icon name="st-running" size={16} />
        <span>{sending ? c.fix.sending : c.fix.button}</span>
      </button>
    </section>
  );
}

/** UI-24 */
export function DiagnosisCard({
  runId,
  diagnosis,
  origin,
  outcome,
  failingStepKey,
  failingCheck,
  knobs,
  peerName,
  onShowMessages,
  onShowCheck,
  headingRef,
}: {
  runId: string;
  diagnosis: DiagnosisResponse;
  origin: Run['origin'] | null;
  /** RunVerdict.outcome */
  outcome: string | null;
  failingStepKey: string | null;
  /** the first failing CheckResult (the Unclassified body) */
  failingCheck: CheckResult | null;
  knobs: readonly KnobEntry[];
  peerName?: (adapterId: string) => string;
  onShowMessages?: (m: Match) => void;
  onShowCheck?: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const view = diagnosisCase(diagnosis);
  const decision = fixItDecision(diagnosis, view, { origin, outcome });
  const [openIdx, setOpenIdx] = useState<Set<number>>(() => new Set([0]));
  const [gone, setGone] = useState<string | null>(null);
  const hid = useId();
  const first = view.causes[0];
  const heading =
    view.kind === 'exact' ? c.card.heading.exact(first?.title ?? '') : c.card.heading[view.kind];
  const partial = diagnosis.coverageBanner.find(
    (h) => h.stepKey === failingStepKey && h.capture !== 'full',
  );
  const knob = decision.offer ? knobEntry(knobs, decision.offer.knobId) : null;
  const peer = knob?.adapters[0] ?? null;
  return (
    <section
      className="diagnosis-card"
      aria-labelledby={hid}
      data-case={view.kind}
      data-testid="diagnosis-card"
    >
      <div className="diagnosis-head">
        <h2 id={hid} ref={headingRef} tabIndex={-1}>
          {heading}
        </h2>
        <span className={`badge tone-${CASE_TONE[view.kind]}`} title={c.card.chipTip[view.kind]}>
          {c.card.chip[view.kind]}
        </span>
      </div>
      <p className="diagnosis-sub">{c.card.sub[view.kind]}</p>
      {partial ? (
        <p className="small tone-warn-text">
          {c.card.partial(
            partial.capture === 'none' ? runCopy.capture.none : runCopy.capture.partial,
            partial.reason,
          )}
        </p>
      ) : null}
      {view.kind === 'unclassified' ? (
        failingCheck ? (
          <div className="unclassified-check">
            <p className="mono small">
              {c.card.check(
                failingCheck.checkId,
                failingCheck.code ?? null,
                failingCheck.message ?? '',
              )}
            </p>
            {failingCheck.specClause ? (
              <p className="small">{c.card.spec(failingCheck.specClause)}</p>
            ) : null}
            {onShowCheck ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onShowCheck}>
                {c.card.showCheck}
              </button>
            ) : null}
          </div>
        ) : null
      ) : (
        view.causes.map((m, i) => (
          <CauseBlock
            key={`${m.fingerprintId}-${i}`}
            m={m}
            open={openIdx.has(i)}
            onToggle={() =>
              setOpenIdx((s) => {
                const next = new Set(s);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                return next;
              })
            }
            onShowMessages={onShowMessages}
            onShowCheck={onShowCheck}
          />
        ))
      )}
      {decision.offer && !gone ? (
        <FixItPanel
          runId={runId}
          offer={decision.offer}
          knob={knob}
          peerName={peer && peerName ? peerName(peer) : null}
          onGone={setGone}
        />
      ) : gone ? (
        <p className="nofix-line muted" data-nofix="gone">
          {gone}
        </p>
      ) : decision.noFix ? (
        <NoFixLine reason={decision.noFix} />
      ) : null}
      {view.findings.length > 0 ? (
        <div className="findings-list">
          <h3>{c.card.findings}</h3>
          <p className="small muted">{c.card.findingsSub}</p>
          <ul>
            {view.findings.map((m) => (
              <li key={m.fingerprintId} className="small">
                <code>{m.fingerprintId}</code> {m.title}
                {m.gapIds.length > 0 ? ` (${m.gapIds.join(', ')})` : ''}
                {m.specClause ? ` · ${c.card.spec(m.specClause)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
