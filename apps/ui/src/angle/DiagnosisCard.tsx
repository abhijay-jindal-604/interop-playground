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
import { angleCopy as c, CAUSE_PLAIN, runCopy, screenCopy } from '../copy.js';
import { Stamp, type StampWord } from '../components/Stamp.js';
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
  showTitle,
  open,
  onToggle,
  onShowMessages,
  onShowCheck,
}: {
  m: Match;
  /** the exact case names the cause in its heading and fix card, so the block shows only Details */
  showTitle: boolean;
  open: boolean;
  onToggle: () => void;
  onShowMessages?: ((m: Match) => void) | undefined;
  onShowCheck?: (() => void) | undefined;
}) {
  const id = useId();
  const tid = useId();
  return (
    <div className="cause-block" data-fingerprint={m.fingerprintId}>
      {showTitle ? (
        <p id={tid} className="cause-title">
          {m.title}
        </p>
      ) : null}
      {onShowMessages || onShowCheck ? (
        <p className="cause-actions">
          {onShowMessages && m.matchedExchangeIds.length > 0 ? (
            <button type="button" className="btn-link" onClick={() => onShowMessages(m)}>
              {c.card.showMessages}
            </button>
          ) : null}
          {onShowCheck ? (
            <button type="button" className="btn-link" onClick={onShowCheck}>
              {c.card.showCheck}
            </button>
          ) : null}
        </p>
      ) : null}
      {/* ADR-137: fingerprint, gaps, spec clause and evidence file sit behind one Details toggle */}
      <button
        type="button"
        className="cause-toggle"
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={showTitle ? tid : undefined}
        onClick={onToggle}
      >
        {screenCopy.fix.details}
      </button>
      <div id={id} className="cause-body" hidden={!open}>
        {/* ADR-129: the facts as a definition list; the hidden ": " keeps each row one sentence */}
        <dl className="cause-facts">
          <div>
            <dt>
              {screenCopy.fix.fingerprint}
              <span className="visually-hidden">: </span>
            </dt>
            <dd>
              <code>{m.fingerprintId}</code> {m.title}
            </dd>
          </div>
          <div data-testid="deviating-side">
            <dt>
              {c.card.factLabel.side}
              <span className="visually-hidden">: </span>
            </dt>
            <dd>
              {c.card.sideValue(sideWord(m.deviatingSide), m.component.name, m.component.versions)}
            </dd>
          </div>
          {m.specClause ? (
            <div>
              <dt>
                {c.card.factLabel.spec}
                <span className="visually-hidden">: </span>
              </dt>
              <dd>{m.specClause}</dd>
            </div>
          ) : null}
          <div>
            <dt>
              {c.card.factLabel.gaps}
              <span className="visually-hidden">: </span>
            </dt>
            <dd>{m.gapIds.join(', ') || c.card.none}</dd>
          </div>
          <div>
            <dt>
              {c.card.factLabel.evidence}
              <span className="visually-hidden">: </span>
            </dt>
            <dd>
              <code title={c.card.evidenceTip}>{c.card.evidencePath(m.fingerprintId)}</code>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

/** The plain one-sentence cause (ADR-137), or the fingerprint's title when none is written. */
export function causeSentence(m: Match, issuerName: string | null): string {
  const plain = CAUSE_PLAIN[m.fingerprintId];
  return plain ? plain(issuerName ?? 'the issuer') : m.title;
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

/**
 * UI-25 as a three-part card (ADR-137): What failed (one plain sentence), The one change (the
 * setting's old value struck through, the new one marked), Result (a small stamp and one line).
 * One ink button starts the child; who proved it and what the change touches sit in Details.
 */
export function FixItPanel({
  runId,
  offer,
  knob,
  peerName,
  cause = null,
  expected = 'valid',
  onGone,
}: {
  runId: string;
  offer: CounterfactualOfferedPayload;
  knob: KnobEntry | null;
  /** display name of the component a `peer-runtime-option` knob changes */
  peerName: string | null;
  /** the plain "What failed" sentence; the part is left out when there is none */
  cause?: string | null;
  /** the stamp the re-run is expected to earn */
  expected?: StampWord;
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
  const f = screenCopy.fix;
  return (
    <section className="fixit-panel" aria-label={c.fix.region} data-testid="fixit-panel">
      <h3 className="fixit-title">{c.fix.title}</h3>
      <div className="fixit-parts">
        {cause ? (
          <div className="fixit-part fixit-what">
            <p className="fixit-part-label">{f.whatFailed}</p>
            <p className="fixit-what-text">{cause}</p>
          </div>
        ) : null}
        <div className="fixit-part">
          <p className="fixit-part-label">{f.oneChange}</p>
          <p className="fixit-change">
            <code className="fixit-knob" title={knob?.label ?? undefined}>
              {name}
            </code>
            <span className="visually-hidden"> · </span>
            <span className="fixit-values">
              <del className="fixit-from" title={f.from}>
                {offer.from}
              </del>
              <span className="fixit-arrow" title={c.fix.arrowTip}>
                {' → '}
              </span>
              <ins className="fixit-to" title={f.to}>
                {offer.to}
              </ins>
            </span>
          </p>
          {knob?.label ? <p className="fixit-label">{knob.label}</p> : null}
        </div>
        <div className="fixit-part fixit-result">
          <p className="fixit-part-label">{f.result}</p>
          <p className="fixit-result-line">
            <Stamp word={expected} status="pass" small />
            <span>{f.resultLine}</span>
          </p>
        </div>
      </div>
      {error ? <InlineError error={error} /> : null}
      <button
        type="button"
        className="btn btn-primary fixit-button"
        data-knob-target
        disabled={sending}
        onClick={() => void start()}
      >
        {sending ? c.fix.sending : c.fix.button}
      </button>
      <details className="disclosure fixit-details">
        <summary>{f.details}</summary>
        <div className="disclosure-body">
          <p>{c.fix.explainer}</p>
          {applies === 'wallet-runtime' ? <p>{c.fix.walletRuntime}</p> : null}
          {applies === 'peer-runtime-option' && peerName ? (
            <p>{c.fix.peerRuntime(peerName)}</p>
          ) : null}
          <p className="muted">{c.fix.provenBy}</p>
          <p className="mono muted">
            {offer.knobId} · {offer.fingerprintId}
          </p>
        </div>
      </details>
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
  issuerName = null,
}: {
  /** display name of the run's issuer, for the plain "What failed" sentence (ADR-137) */
  issuerName?: string | null;
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
  // ADR-137: the technical facts start closed; the plain sentence and the fix carry the card
  const [openIdx, setOpenIdx] = useState<Set<number>>(() => new Set());
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
        <span
          className={`diagnosis-kind tone-${CASE_TONE[view.kind]}`}
          title={c.card.chipTip[view.kind]}
        >
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
            {onShowCheck ? (
              <button type="button" className="btn-link" onClick={onShowCheck}>
                {c.card.showCheck}
              </button>
            ) : null}
            {failingCheck.specClause ? (
              <details className="disclosure">
                <summary>{screenCopy.fix.details}</summary>
                <p className="disclosure-body small">{c.card.spec(failingCheck.specClause)}</p>
              </details>
            ) : null}
          </div>
        ) : null
      ) : (
        view.causes.map((m, i) => (
          <CauseBlock
            key={`${m.fingerprintId}-${i}`}
            m={m}
            showTitle={view.kind !== 'exact'}
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
          cause={first ? causeSentence(first, issuerName) : null}
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
                {m.title}
              </li>
            ))}
          </ul>
          <details className="disclosure">
            <summary>{screenCopy.fix.details}</summary>
            <ul className="disclosure-body small">
              {view.findings.map((m) => (
                <li key={m.fingerprintId}>
                  <code>{m.fingerprintId}</code>
                  {m.gapIds.length > 0 ? ` (${m.gapIds.join(', ')})` : ''}
                  {m.specClause ? ` · ${c.card.spec(m.specClause)}` : ''}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </section>
  );
}
