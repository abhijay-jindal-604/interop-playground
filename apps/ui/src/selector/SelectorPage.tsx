/**
 * `/` the selector page (06 UI-03..UI-06, UI-08; T-30): recipe strip, three radio-group columns
 * judged card by card through API-03 (UI-05 check algorithm), and the sticky StartBar that creates
 * the run (API-20) and opens `/runs/:runId`. The deep link `/?issuer&wallet&verifier&format&grant&mode`
 * preselects; otherwise the last selection (`pg.selection.v1`) or the defaults apply.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type {
  CreateRunRequest,
  AdapterEntry,
  AdapterId,
  IncompatibilityHit,
  IncompatibilityListResponse,
  PreviewResponse,
  Run,
} from '@interop-playground/api';
import { apiSend } from '../api/client.js';
import { applicableKnobs, changedKnobs, KnobsPanel, type KnobChoice } from '../angle/KnobsPanel.js';
import { knobList } from '../angle/model.js';
import { preloadMermaid } from '../diagram/render.js';
import { EmptyState } from '../components/EmptyState.js';
import { InlineError } from '../components/InlineError.js';
import { Skeleton } from '../components/Skeleton.js';
import { copy, selectorCopy as c } from '../copy.js';
import { boot } from '../state/boot.js';
import { store as appStore, useStore } from '../state/store.js';
import { PageFrame } from '../routes/PageFrame.js';
import {
  cardRequest,
  cardTunnel,
  defaultSelection,
  FIXTURE_CONFIGS,
  FORMATS,
  fromQuery,
  grantOf,
  hasSelectionQuery,
  loadStored,
  MODES,
  ordered,
  SCOPES,
  selectionTunnel,
  store,
  toRequest,
  type Role,
  type Selection,
} from './model.js';

const ROLES: Role[] = ['issuer', 'wallet', 'verifier'];
const SKELETON: Record<Role, number> = { issuer: 6, wallet: 5, verifier: 7 };
type Hits = Record<string, IncompatibilityHit | null>;

/** adapters cut from this release (ADR-95) fold into one quiet disclosure per column (ADR-126) */
const isLater = (e: AdapterEntry) =>
  !e.availability.available && (e.availability.reason ?? '').startsWith('not in this release');

const nameOf = (e: AdapterEntry) =>
  e.descriptor.displayName || (c.names[e.descriptor.id]?.[0] ?? e.descriptor.id);

/** UI-05 check algorithm: one API-03 call per card, debounced 150 ms, stale answers dropped */
function useCompatibility(sel: Selection, entries: Record<Role, AdapterEntry[]> | null) {
  const [hits, setHits] = useState<Hits>({});
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [allFailed, setAllFailed] = useState(false);
  const gen = useRef(0);
  useEffect(() => {
    if (!entries) return;
    const mine = ++gen.current;
    setChecking(true);
    const t = setTimeout(() => {
      const jobs: { key: string; role: Role | null; id: AdapterId | null }[] = [
        { key: 'selection', role: null, id: null },
      ];
      for (const role of ROLES) {
        if (role === 'verifier' && sel.scope === 'issuance') continue;
        for (const e of entries[role]) {
          if (e.descriptor.id === sel[role]) continue; // the selection's own request covers it
          jobs.push({ key: `${role}:${e.descriptor.id}`, role, id: e.descriptor.id });
        }
      }
      void Promise.allSettled(
        jobs.map((j) =>
          apiSend<PreviewResponse>(
            'POST',
            '/runs/preview',
            j.role && j.id ? cardRequest(sel, j.role, j.id) : toRequest(sel),
          ),
        ),
      ).then((results) => {
        if (mine !== gen.current) return;
        const next: Hits = {};
        let failed = 0;
        results.forEach((r, i) => {
          const job = jobs[i]!;
          let hit: IncompatibilityHit | null = null;
          if (r.status === 'rejected') failed++;
          else if (!r.value.ok && r.value.hit.ruleId !== 'validation') hit = r.value.hit;
          if (job.role === null) {
            setPreview(r.status === 'fulfilled' ? r.value : null);
            for (const role of ROLES) next[`${role}:${sel[role]}`] = hit;
            if (sel.scope === 'issuance') next[`verifier:${sel.verifier}`] = null;
          } else next[job.key] = hit;
        });
        const none = failed === results.length;
        setAllFailed(none);
        setHits(none ? {} : next);
        setChecking(false);
      });
    }, 150);
    return () => clearTimeout(t);
  }, [sel, entries]);
  return { hits, preview, checking, allFailed };
}

/** research-log S-IDs are internal; the UI shows only public evidence (ADR-98, ADR-100) */
const isResearchId = (e: string): boolean => /^S-\d+$/.test(e);

/** plain words for the one note under a column (ADR-134); codes stay in its Details */
const NOTE = {
  cannot: (names: string, reason: string) =>
    `${names} can't be used with this selection. ${reason}`,
  conflict: (name: string, reason: string) =>
    `${name} doesn't work with this selection. ${reason} Choose another option or change the format.`,
  down: (names: string, many: boolean, reason: string) =>
    reason.startsWith('not in this release')
      ? `${names} ${many ? 'are' : 'is'} not in this release.`
      : `${names} ${many ? 'are' : 'is'} not running (${reason}).`,
  rule: (id: string) => `Rule ${id}`,
};
const andList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

/** the run bar's sentence (ADR-134) */
const START = {
  full: (issuer: string, wallet: string, verifier: string) =>
    `${issuer} issues to ${wallet}, and ${verifier} checks it.`,
  issueOnly: (issuer: string, wallet: string) => `${issuer} issues to ${wallet}.`,
};

type Blocked = { entry: AdapterEntry; hit: IncompatibilityHit | null; checked: boolean };

/** The one quiet note under a column: why its greyed options can't be picked, in plain words, with
 * the rule IDs, gap IDs and evidence behind a "Details" disclosure (ADR-134). */
function ColumnNote({
  id,
  blocked,
  evidenceOf,
}: {
  id: string;
  blocked: Blocked[];
  evidenceOf: (ruleId: string) => string[];
}) {
  if (blocked.length === 0) return null;
  const lines: string[] = [];
  const byReason = new Map<string, string[]>();
  const downBy = new Map<string, string[]>();
  for (const b of blocked) {
    const n = nameOf(b.entry);
    if (b.hit && b.checked) lines.push(NOTE.conflict(n, sentence(b.hit.reason)));
    else if (b.hit) byReason.set(b.hit.reason, [...(byReason.get(b.hit.reason) ?? []), n]);
    else {
      const r = b.entry.availability.reason ?? '';
      downBy.set(r, [...(downBy.get(r) ?? []), n]);
    }
  }
  for (const [reason, names] of byReason) lines.push(NOTE.cannot(andList(names), sentence(reason)));
  for (const [reason, names] of downBy)
    lines.push(NOTE.down(andList(names), names.length > 1, reason));
  const coded = blocked.filter((b) => b.hit);
  return (
    <div className="column-note" id={id} data-testid="column-note">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      {coded.length > 0 ? (
        <details className="details">
          <summary>{c.details}</summary>
          <ul>
            {coded.map(({ entry, hit }) => {
              const evidence = evidenceOf(hit!.ruleId).filter((e) => !isResearchId(e));
              return (
                <li key={entry.descriptor.id}>
                  <span>{nameOf(entry)}: </span>
                  <code>{NOTE.rule(hit!.ruleId)}</code>
                  {hit!.gapId ? <span> · {c.gap(hit!.gapId)}</span> : null}
                  {evidence.length ? <span> · {c.evidence(evidence.join(', '))}</span> : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** One option row: a radio mark, the name and one muted line. An option that can't be used with
 * the current selection is greyed, stays focusable (`aria-disabled`) and points at the column note. */
function AdapterCard({
  entry,
  role,
  sel,
  hit,
  tunnelUp,
  checked,
  noteId,
  onPick,
  index = 0,
}: {
  entry: AdapterEntry;
  role: Role;
  sel: Selection;
  hit: IncompatibilityHit | null;
  tunnelUp: boolean;
  checked: boolean;
  /** the column note that explains why this option is greyed */
  noteId: string;
  onPick: () => void;
  /** position for the entrance stagger (ADR-134) */
  index?: number;
}) {
  const d = entry.descriptor;
  const down = !entry.availability.available;
  const greyed = down || (hit !== null && !checked);
  const conflict = checked && hit !== null && !down;
  const tunnel = cardTunnel(sel, role, d.id);
  const [tier] = c.tier[d.tier] ?? [d.tier, ''];
  const blurb = c.names[d.id]?.[1] ?? null;
  const hops = d.coverage.partialHops;
  const fingerprint =
    entry.availability.available && entry.availability.versionFingerprint
      ? entry.availability.versionFingerprint
      : null;
  // where it runs, how it runs and its formats: for the tooltip, not a row of tags
  const meta = [
    c.env[d.envClass] ?? d.envClass,
    tier,
    d.formats.map((f) => c.recipe.formats[f] ?? f).join(', '),
  ].join(' · ');
  let status: { text: string; tone: string } | null = null;
  if (greyed || conflict) status = null;
  else if (tunnel && !tunnelUp) status = { text: c.tunnel[tunnel], tone: 'warn' };
  else if (c.tierHint[d.tier]) status = { text: c.tierHint[d.tier] ?? '', tone: '' };
  return (
    <div
      className={`adapter-card enter${greyed ? ' is-unavailable' : ''}${checked ? ' is-checked' : ''}${conflict ? ' is-conflict' : ''}`}
      style={{ '--i': index } as CSSProperties}
      data-adapter={d.id}
    >
      <label
        className="adapter-radio"
        title={`${meta}${fingerprint ? ` · ${c.version(fingerprint)}` : ''}`}
      >
        <input
          type="radio"
          className="radio-input"
          name={`select-${role}`}
          value={d.id}
          checked={checked}
          aria-disabled={greyed || undefined}
          aria-describedby={greyed || conflict ? noteId : undefined}
          onChange={() => {
            if (!greyed) onPick();
          }}
        />
        <span className="adapter-card-body">
          <span className="adapter-card-head">
            <span className="adapter-name">{nameOf(entry)}</span>
          </span>
          {blurb ? <span className="adapter-blurb">{blurb}</span> : null}
          {status ? (
            <span
              className={`adapter-status ${status.tone ? `tone-${status.tone}` : 'muted'}`}
              {...(status.tone ? { 'data-status': true } : {})}
            >
              {status.text}
            </span>
          ) : null}
        </span>
      </label>
      {hops.length > 0 ? (
        <details className="details adapter-details">
          <summary>{c.details}</summary>
          <ul className="small">
            {hops.map((h) => (
              <li key={h.stepKey}>{c.partHop(h.stepKey, h.reason)}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** One role's column of options, behaving as a radio group, with one note for the greyed ones. */
function Column({
  role,
  entries,
  sel,
  hits,
  tunnelUp,
  checking,
  evidenceOf,
  onPick,
}: {
  role: Role;
  entries: AdapterEntry[] | null;
  sel: Selection;
  hits: Hits;
  tunnelUp: boolean;
  checking: boolean;
  evidenceOf: (ruleId: string) => string[];
  onPick: (role: Role, id: AdapterId) => void;
}) {
  const hitOf = (id: AdapterId) =>
    role === 'verifier' && sel.scope === 'issuance' ? null : (hits[`${role}:${id}`] ?? null);
  const titleId = `col-${role}`;
  const noteId = `col-${role}-note`;
  const offset = ROLES.indexOf(role) * 2;
  const card = (e: AdapterEntry, i: number) => {
    const id = e.descriptor.id;
    return (
      <AdapterCard
        key={id}
        entry={e}
        role={role}
        sel={sel}
        hit={hitOf(id)}
        tunnelUp={tunnelUp}
        checked={sel[role] === id}
        noteId={noteId}
        onPick={() => onPick(role, id)}
        index={offset + Math.min(i, 8)}
      />
    );
  };
  // a selected adapter always stays in view, even when it is outside the release
  const later = entries?.filter((e) => isLater(e) && sel[role] !== e.descriptor.id) ?? [];
  const now = entries?.filter((e) => !later.includes(e)) ?? [];
  const blocked: Blocked[] = now
    .map((e) => ({ entry: e, hit: hitOf(e.descriptor.id), checked: sel[role] === e.descriptor.id }))
    .filter((b) => !b.entry.availability.available || b.hit !== null)
    .map((b) => (b.entry.availability.available ? b : { ...b, hit: null }));
  return (
    <section className="card column" aria-labelledby={titleId}>
      <h2 id={titleId} className="column-title">
        {c.columns[role]}
        {entries ? <span className="counter muted">{c.options(entries.length)}</span> : null}
      </h2>
      {role === 'verifier' && sel.scope === 'issuance' ? (
        <p className="muted small">{c.verifierUnused}</p>
      ) : null}
      <div className={`column-progress${checking ? ' is-active' : ''}`} aria-hidden="true" />
      {entries ? (
        <>
          <div className="adapter-list" role="radiogroup" aria-label={c.columns[role]}>
            {now.map(card)}
            {later.length > 0 ? (
              <details className="column-later">
                <summary>{c.laterLabel(later.length)}</summary>
                <div className="adapter-list">{later.map(card)}</div>
              </details>
            ) : null}
          </div>
          <ColumnNote id={noteId} blocked={blocked} evidenceOf={evidenceOf} />
        </>
      ) : (
        <div className="adapter-list" aria-hidden="true">
          {Array.from({ length: SKELETON[role] }, (_, i) => (
            <Skeleton key={i} height="3.5rem" radius="var(--radius-sm)" />
          ))}
        </div>
      )}
    </section>
  );
}

/** A small segmented choice control (for example the credential format or the scope). */
function Segmented<T extends string>({
  label,
  name,
  options,
  value,
  words,
  onChange,
  help,
}: {
  label: string;
  name: string;
  options: readonly T[];
  value: T;
  words: Record<string, string>;
  onChange: (v: T) => void;
  help?: string | null;
}) {
  return (
    <fieldset className="segmented-group">
      <legend>{label}</legend>
      <div className="segmented">
        {options.map((o) => (
          <label key={o} className={`segmented-option${o === value ? ' is-on' : ''}`}>
            <input
              type="radio"
              name={name}
              value={o}
              checked={o === value}
              onChange={() => onChange(o)}
            />
            <span>{words[o] ?? o}</span>
          </label>
        ))}
      </div>
      {help ? <p className="muted small segmented-help">{help}</p> : null}
    </fieldset>
  );
}

/** The home screen: choose an issuer, wallet and verifier, see whether the combination can run, and start the run. */
export function SelectorPage() {
  const adapters = useStore((s) => s.catalog.adapters);
  const envLoad = useStore((s) => s.env.snapshot);
  const rules = useStore((s) => s.catalog.incompatibilities);
  const env = envLoad.status === 'ready' ? envLoad.data : null;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // the run screen's diagram renderer, loaded while the user selects (ADR-89)
  useEffect(() => preloadMermaid(), []);
  const [sel, setSel] = useState<Selection>(() => {
    const base = defaultSelection(env);
    return hasSelectionQuery(params) ? fromQuery(params, base) : loadStored(base);
  });
  const entries = useMemo(
    () =>
      adapters.status === 'ready'
        ? {
            issuer: ordered(adapters.data.issuers, 'issuer'),
            wallet: ordered(adapters.data.wallets, 'wallet'),
            verifier: ordered(adapters.data.verifiers, 'verifier'),
          }
        : null,
    [adapters],
  );
  const { hits, preview, checking, allFailed } = useCompatibility(sel, entries);
  const tunnelUp = env?.tunnel.state === 'up';
  const evidenceOf = useCallback(
    (ruleId: string) => {
      if (rules.status !== 'ready') return [];
      const list = (rules.data as Partial<IncompatibilityListResponse>).rules ?? [];
      return list.find((r) => r.ruleId === ruleId)?.evidence ?? [];
    },
    [rules],
  );

  const update = useCallback((patch: Partial<Selection>) => {
    setSel((s) => {
      const next = { ...s, ...patch };
      if (patch.issuer) next.grant = null;
      if (patch.issuer && patch.issuer !== s.issuer) next.configurationId = null;
      store(next);
      return next;
    });
  }, []);

  // ----- StartBar (UI-08)
  const [knobChoice, setKnobChoice] = useState<KnobChoice>({});
  const [runLabel, setRunLabel] = useState('');
  const knobLoad = useStore((st) => st.catalog.knobs);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  const idem = useRef<{ key: string; body: string } | null>(null);
  const name = (role: Role) => {
    const e = entries?.[role].find((x) => x.descriptor.id === sel[role]);
    return e ? nameOf(e) : sel[role];
  };
  const selfHit =
    hits[`issuer:${sel.issuer}`] ??
    hits[`wallet:${sel.wallet}`] ??
    (sel.scope === 'full' ? hits[`verifier:${sel.verifier}`] : null) ??
    null;
  const tunnelBlock = selectionTunnel(sel) !== null && !tunnelUp;
  // a selected card that is not running: the server would answer `adapter_unavailable` at Start
  const down = ROLES.filter((r) => r !== 'verifier' || sel.scope === 'full')
    .map((r) => entries?.[r].find((e) => e.descriptor.id === sel[r]))
    .find((e) => e && !e.availability.available);
  const blockReason = selfHit
    ? selfHit.reason
    : down
      ? `${nameOf(down)}: ${c.unavailable(down.availability.reason ?? '')}`
      : tunnelBlock
        ? c.tunnel.start
        : null;
  const canRun = entries !== null && !starting && blockReason === null;
  const start = useCallback(async () => {
    if (!canRun) return;
    const chosen = [sel.issuer, sel.wallet, ...(sel.scope === 'full' ? [sel.verifier] : [])];
    const all = knobLoad.status === 'ready' ? knobList(knobLoad.data) : [];
    const knobs = changedKnobs(knobChoice, applicableKnobs(all, chosen, sel.format));
    const req: CreateRunRequest = {
      ...toRequest(sel),
      ...(Object.keys(knobs).length > 0 ? { knobs } : {}),
      ...(runLabel.trim() ? { label: runLabel.trim() } : {}),
    };
    const body = JSON.stringify(req);
    if (!idem.current || idem.current.body !== body)
      idem.current = { key: crypto.randomUUID(), body };
    setStarting(true);
    setStartError(null);
    try {
      const run = await apiSend<Run>('POST', '/runs', req, { 'Idempotency-Key': idem.current.key });
      idem.current = null;
      void navigate(`/runs/${run.runId}`);
    } catch (err) {
      setStartError(err);
      setStarting(false);
    }
  }, [canRun, sel, navigate, knobChoice, knobLoad, runLabel]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void start();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [start]);

  const grant = grantOf(sel);
  const delivery = preview?.ok ? preview.spec.delivery : null;
  // the run bar says it as a sentence; the recipe follows as one muted line (ADR-134)
  const summary =
    sel.scope === 'issuance'
      ? START.issueOnly(name('issuer'), name('wallet'))
      : START.full(name('issuer'), name('wallet'), name('verifier'));
  const recipe = [
    c.recipe.formats[sel.format] ?? sel.format,
    c.grantWord[grant] ?? grant,
    sel.scope === 'issuance' ? c.issueOnly : (c.recipe.modes[sel.mode] ?? sel.mode),
  ].join(' · ');

  return (
    <PageFrame title={c.title} lead={<p>{c.lead}</p>}>
      {adapters.status === 'error' ? (
        <EmptyState
          title="No components"
          body={
            <>
              <p>{copy.catalogEmpty}</p>
              <InlineError error={adapters.error} alert={false} />
            </>
          }
          action={
            <button type="button" className="btn btn-secondary" onClick={() => void boot(appStore)}>
              {copy.tryAgain}
            </button>
          }
        />
      ) : (
        <div className="selector">
          <div className="recipe-strip">
            <Segmented
              label={c.recipe.format}
              name="format"
              options={FORMATS}
              value={sel.format}
              words={c.recipe.formats}
              onChange={(format) => update({ format })}
            />
            <Segmented
              label={c.recipe.mode}
              name="mode"
              options={MODES}
              value={sel.mode}
              words={c.recipe.modes}
              onChange={(mode) => update({ mode })}
              help={c.recipe.modeHelp[sel.mode]}
            />
            {sel.issuer === ('issuer.fixture' as AdapterId) ? (
              <Segmented
                label={c.recipe.fixtureCase}
                name="config"
                options={FIXTURE_CONFIGS}
                value={
                  (sel.configurationId ?? 'PlaygroundSdJwt') as (typeof FIXTURE_CONFIGS)[number]
                }
                words={c.recipe.fixtureCases}
                onChange={(configurationId) => update({ configurationId })}
                help={c.recipe.fixtureCaseHelp}
              />
            ) : null}
            <Segmented
              label={c.recipe.scope}
              name="scope"
              options={SCOPES}
              value={sel.scope}
              words={c.recipe.scopes}
              onChange={(scope) => update({ scope })}
              help={sel.scope === 'issuance' ? c.recipe.issueOnlyHelp : null}
            />
            <ul className="recipe-facts">
              <li>{c.recipe.grant(grant)}</li>
              {delivery ? <li>{c.recipe.delivery(delivery)}</li> : null}
            </ul>
          </div>
          <div
            className="three-cols selector-cols"
            role="group"
            aria-label={c.groupLabel}
            aria-busy={entries === null || undefined}
          >
            {ROLES.map((role) => (
              <Column
                key={role}
                role={role}
                entries={entries?.[role] ?? null}
                sel={sel}
                hits={hits}
                tunnelUp={tunnelUp}
                checking={checking}
                evidenceOf={evidenceOf}
                onPick={(r, id) => update({ [r]: id })}
              />
            ))}
          </div>
          {allFailed ? <p className="tone-warn small selector-warn">{c.checkFailed}</p> : null}
          <KnobsPanel
            adapters={[sel.issuer, sel.wallet, ...(sel.scope === 'full' ? [sel.verifier] : [])]}
            format={sel.format}
            choice={knobChoice}
            label={runLabel}
            onChoice={setKnobChoice}
            onLabel={setRunLabel}
          />
          <div className="start-bar" role="region" aria-label={c.startBar}>
            <div className="start-summary">
              <p className="start-text">{summary}</p>
              <p className="start-meta">{recipe}</p>
              {preview?.ok
                ? preview.warnings.map((w) => (
                    <p key={w} className="small muted">
                      {w}
                    </p>
                  ))
                : null}
              {blockReason ? (
                <p className="small tone-fail start-reason" data-testid="start-reason">
                  {blockReason}
                </p>
              ) : null}
              {startError ? <InlineError error={startError} /> : null}
            </div>
            <button
              type="button"
              className="btn btn-primary start-run"
              disabled={!canRun}
              aria-keyshortcuts="Control+Enter"
              onClick={() => void start()}
            >
              {starting ? c.starting : c.run}
            </button>
          </div>
        </div>
      )}
    </PageFrame>
  );
}
