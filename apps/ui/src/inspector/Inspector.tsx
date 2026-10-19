/**
 * Protocol inspector (06 UI-18..UI-23, REQ-24): header, key-payload bar, tabs Messages | Decoded |
 * Checks | Engine | Events. Pure over the run's event log (ADR-41) plus the reduced step view; the
 * only fetch is API-27 for a truncated body (BodyViewer).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { EventEnvelope } from '@interop-playground/api';
import { CopyButton } from '../components/CopyButton.js';
import { Icon } from '../components/Icon.js';
import { inspectorCopy as c } from '../copy.js';
import { DeliveryDialog } from '../delivery/Delivery.js';
import type { RailStep } from '../run/flows.js';
import type { RunView } from '../run/reduce.js';
import { CaptureBadge, outcomeWord } from '../run/StepRail.js';
import { runCopy } from '../copy.js';
import { BodyViewer, Redacted } from './BodyViewer.js';
import { findDecodable, pretty, type DecodedItem } from './decode.js';
import {
  buildModel,
  chipTarget,
  CHIPS,
  deliveryOf,
  type ChipId,
  type ChipTarget,
  type DeliveryOutput,
  type EngineRowView,
  type ExchangeView,
  type InspectorModel,
} from './model.js';

export const TABS = ['messages', 'decoded', 'checks', 'engine', 'events'] as const;
export type TabId = (typeof TABS)[number];
const TAB_KEY = 'pg.inspector.tab';

function readTab(): TabId {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    return (TABS as readonly string[]).includes(v ?? '') ? (v as TabId) : 'messages';
  } catch {
    return 'messages';
  }
}
function writeTab(t: TabId): void {
  try {
    sessionStorage.setItem(TAB_KEY, t);
  } catch {
    // storage blocked: the tab is simply not remembered
  }
}

const header = (headers: [string, string][], name: string): string | null =>
  headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;

function splitUrl(url: string): { origin: string; rest: string } {
  try {
    const u = new URL(url);
    return { origin: u.origin, rest: `${u.pathname}${u.search}` };
  } catch {
    return { origin: '', rest: url };
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export function curlOf(x: ExchangeView): string {
  const parts = [`curl -X ${x.method} ${shq(x.url)}`];
  for (const [k, v] of x.request.headers) parts.push(`-H ${shq(`${k}: ${v}`)}`);
  if (x.request.body?.encoding === 'utf8') parts.push(`--data-raw ${shq(x.request.body.text)}`);
  return parts.join(' \\\n  ');
}

// ---------------------------------------------------------------- Messages (UI-19)

function HeadersTable({ headers }: { headers: [string, string][] }) {
  if (headers.length === 0) return <p className="muted small">{c.messages.noHeaders}</p>;
  return (
    <div className="table-scroll">
      <table className="data-table headers-table">
        <caption className="visually-hidden">{c.messages.headers}</caption>
        <tbody>
          {headers.map(([k, v], i) => (
            <tr key={i}>
              <th scope="row" className="mono">
                {k}
              </th>
              <td className="mono wrap">
                <Redacted text={v} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExchangeCard({
  x,
  runId,
  open,
  part,
  onToggle,
  onPart,
}: {
  x: ExchangeView;
  runId: string | null;
  open: boolean;
  part: 'request' | 'response';
  onToggle: () => void;
  onPart: (p: 'request' | 'response') => void;
}) {
  const { origin, rest } = splitUrl(x.url);
  const status = x.response?.status ?? null;
  const tone = status === null ? 'fail' : status < 400 ? 'pass' : 'fail';
  const panelId = `xc-${x.exchangeId}`;
  const msg = part === 'request' ? x.request : x.response;
  const tip =
    x.direction === 'inbound'
      ? c.messages.inboundTip(x.actor, x.counterpart)
      : c.messages.outboundTip(x.actor, x.counterpart);
  const subKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = part === 'request' && x.response ? 'response' : 'request';
      onPart(next);
      e.currentTarget.parentElement
        ?.querySelector<HTMLButtonElement>(`[data-part="${next}"]`)
        ?.focus();
    }
  };
  return (
    <li className={`xcard${open ? ' is-open' : ''}`} data-exchange={x.exchangeId}>
      <button
        type="button"
        className="xcard-row"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <Icon name="chevron" size={16} />
        <span className="chip chip-outline" title={tip}>
          {x.direction === 'inbound' ? c.messages.inbound : c.messages.outbound}
        </span>
        <span className="xcard-url mono">
          <span className="xcard-method">{x.method}</span> <span className="muted">{origin}</span>
          <span>{rest}</span>
        </span>
        <span className="xcard-meta">
          {x.error ? (
            <span className="badge tone-fail">
              {c.messages.noResponse(x.error.errorClass, x.error.durationMs)}
            </span>
          ) : status !== null ? (
            <span className={`badge tone-${tone}`}>
              → {status} · {x.response?.durationMs ?? 0} ms
            </span>
          ) : null}
          {x.poll ? (
            <span className="chip">{c.messages.poll(x.poll.index, x.poll.total)}</span>
          ) : null}
        </span>
        <span className="xcard-actor muted small">
          {x.actor} → {x.counterpart}
        </span>
      </button>
      {open ? (
        <div id={panelId} className="xcard-body">
          {x.direction === 'inbound' ? (
            <p className="small muted">{c.messages.gatewaySeen}</p>
          ) : null}
          {x.error ? (
            <p className="xcard-error">
              {c.messages.noResponse(x.error.errorClass, x.error.durationMs)}: {x.error.message}
            </p>
          ) : null}
          <div role="tablist" aria-label={`${x.method} ${rest}`} className="subtabs">
            {(['request', 'response'] as const).map((p) =>
              p === 'response' && !x.response ? null : (
                <button
                  key={p}
                  type="button"
                  role="tab"
                  data-part={p}
                  aria-selected={part === p}
                  tabIndex={part === p ? 0 : -1}
                  className="subtab"
                  onClick={() => onPart(p)}
                  onKeyDown={subKey}
                >
                  {p === 'request' ? c.messages.request : c.messages.response}
                </button>
              ),
            )}
            {part === 'request' ? (
              <CopyButton text={curlOf(x)} label={c.messages.copyCurl} />
            ) : null}
          </div>
          {msg ? (
            <div role="tabpanel" className="xcard-part" data-part-panel={part}>
              <p className="body-block-title">{c.messages.headers}</p>
              <HeadersTable headers={msg.headers} />
              <BodyViewer
                key={`${x.exchangeId}-${part}`}
                runId={runId}
                exchangeId={x.exchangeId}
                part={part === 'request' ? 'Request' : 'Response'}
                body={msg.body}
                bodyState={msg.bodyState}
                mediaType={header(msg.headers, 'content-type')}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function MessagesTab({
  list,
  runId,
  scope,
  stepNote,
  open,
  setOpen,
  parts,
  setPart,
  labels,
}: {
  list: ExchangeView[];
  runId: string | null;
  scope: 'step' | 'run';
  stepNote: string | null;
  open: Set<string>;
  setOpen: (s: Set<string>) => void;
  parts: Record<string, 'request' | 'response'>;
  setPart: (id: string, p: 'request' | 'response') => void;
  labels: Map<string, string>;
}) {
  if (list.length === 0) {
    return (
      <div className="tab-empty">
        <p>{c.messages.empty}</p>
        {stepNote ? <p className="muted">{stepNote}</p> : null}
      </div>
    );
  }
  let group: string | null = null;
  return (
    <>
      <div className="tab-toolbar">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOpen(new Set(list.map((x) => x.exchangeId)))}
        >
          {c.messages.expandAll}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(new Set())}>
          {c.messages.collapseAll}
        </button>
      </div>
      <ul className="xlist">
        {list.map((x) => {
          const head =
            scope === 'run' && x.stepKey !== group
              ? (labels.get(x.stepKey ?? '') ?? x.stepKey)
              : null;
          group = x.stepKey;
          return (
            <ExchangeGroup key={x.exchangeId} head={head}>
              <ExchangeCard
                x={x}
                runId={runId}
                open={open.has(x.exchangeId)}
                part={parts[x.exchangeId] ?? 'request'}
                onPart={(p) => setPart(x.exchangeId, p)}
                onToggle={() => {
                  const next = new Set(open);
                  if (next.has(x.exchangeId)) next.delete(x.exchangeId);
                  else next.add(x.exchangeId);
                  setOpen(next);
                }}
              />
            </ExchangeGroup>
          );
        })}
      </ul>
      <p className="muted small">
        {scope === 'run' ? c.messages.footerRun(list.length) : c.messages.footer(list.length)}
      </p>
    </>
  );
}

function ExchangeGroup({ head, children }: { head: string | null; children: React.ReactNode }) {
  return (
    <>
      {head ? (
        <li className="xgroup-head" aria-hidden="false">
          {head}
        </li>
      ) : null}
      {children}
    </>
  );
}

// ---------------------------------------------------------------- Decoded (UI-21)

const TITLES: Record<string, string> = {
  credential: 'Issued credential',
  verifiableCredential: 'Credential seen by the verifier',
  access_token: 'Access token (JWT)',
  jwt: 'Proof JWT',
  vp_token: 'vp_token',
  request: 'Request object (JWT)',
  id_token: 'ID token (JWT)',
};

function titleOf(item: DecodedItem): string {
  const base =
    (item.field && TITLES[item.field]) ??
    (item.path.startsWith('vp_token') ? TITLES.vp_token : null) ??
    item.field ??
    'JWT';
  const alg = typeof item.jwt.header.alg === 'string' ? item.jwt.header.alg : null;
  if (item.kind === 'sd-jwt')
    return `${base} (SD-JWT${item.sdJwt?.kbJwt ? ' with key binding' : ''})`;
  if (base.endsWith('(JWT)') || !alg) return base;
  return `${base} (${alg})`;
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function JoseChips({ h }: { h: Record<string, unknown> }) {
  return (
    <p className="jose-chips">
      {(['alg', 'typ', 'kid'] as const).map((k) =>
        typeof h[k] === 'string' ? (
          <span key={k} className="chip" title={String(h[k])}>
            {k}: {String(h[k]).length > 40 ? `${String(h[k]).slice(0, 40)}…` : String(h[k])}
          </span>
        ) : null,
      )}
      <span className="chip">{c.decoded.x5c(Array.isArray(h.x5c))}</span>
    </p>
  );
}

function ArtifactCard({ item, from }: { item: DecodedItem; from: string }) {
  return (
    <article className="artifact-card" data-artifact={item.kind}>
      <h3 className="artifact-title">{titleOf(item)}</h3>
      <p className="muted small">{c.decoded.from(from)}</p>
      <JoseChips h={item.jwt.header} />
      {item.sdJwt && item.sdJwt.disclosures.length > 0 ? (
        <ul className="disclosure-list">
          {item.sdJwt.disclosures.map((d) => (
            <li key={d.raw} className="mono small">
              {c.decoded.disclosed(d.name ?? '[array element]', show(d.value))}
            </li>
          ))}
        </ul>
      ) : null}
      <pre className="body-code">{pretty(item.jwt.payload)}</pre>
      {item.sdJwt?.kbJwt ? (
        <>
          <p className="body-block-title">{c.body.kbJwt}</p>
          <JoseChips h={item.sdJwt.kbJwt.header} />
          <pre className="body-code">{pretty(item.sdJwt.kbJwt.payload)}</pre>
        </>
      ) : null}
      <p className="muted small">{c.decoded.disclaimer}</p>
    </article>
  );
}

function DecodedTab({ list }: { list: ExchangeView[] }) {
  const items = useMemo(() => {
    const out: { item: DecodedItem; from: string; key: string }[] = [];
    for (const x of list) {
      for (const [part, b] of [
        ['request', x.request.body],
        ['response', x.response?.body ?? null],
      ] as const) {
        if (b?.encoding !== 'utf8') continue;
        findDecodable(b.text).forEach((item, i) =>
          out.push({
            item,
            from: `${part} of message ${x.n} (${x.method} ${splitUrl(x.url).rest.split('?')[0]})${item.path ? `, ${item.path}` : ''}`,
            key: `${x.exchangeId}-${part}-${i}`,
          }),
        );
      }
    }
    return out;
  }, [list]);
  if (items.length === 0) return <p className="tab-empty">{c.decoded.empty}</p>;
  return (
    <div className="artifact-list">
      {items.map(({ item, from, key }) => (
        <ArtifactCard key={key} item={item} from={from} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Checks (UI-22)

function ChecksTab({
  model,
  keys,
  onShow,
}: {
  model: InspectorModel;
  keys: Set<string> | null;
  onShow: (exchangeId: string) => void;
}) {
  const rows = model.checks.filter((r) => !keys || keys.has(r.stepKey ?? ''));
  const findings = model.findings.filter(
    (r) => r.finding.role === 'finding' && (!keys || keys.has(r.stepKey ?? '')),
  );
  if (rows.length === 0 && findings.length === 0)
    return <p className="tab-empty">{c.checks.empty}</p>;
  return (
    <>
      <ul className="check-list">
        {rows.map(({ seq, check }) => {
          const tone =
            check.outcome === 'pass'
              ? 'pass'
              : check.outcome === 'fail'
                ? 'fail'
                : check.outcome === 'info'
                  ? 'info'
                  : 'skipped';
          return (
            <li key={seq} className="check-row">
              <span className={`badge tone-${tone}`}>
                <Icon
                  name={
                    check.outcome === 'info'
                      ? 'st-queued'
                      : check.outcome === 'not-run'
                        ? 'st-not-run'
                        : `st-${check.outcome}`
                  }
                  size={16}
                />
                <span>{c.checks.outcome[check.outcome]}</span>
              </span>
              <code className="check-id">{check.checkId}</code>
              <span
                className="chip chip-outline"
                title={check.source === 'playground-lint' ? c.checks.lintTip : undefined}
              >
                {c.checks.source[check.source]}
              </span>
              {check.code ? <code className="small">{check.code}</code> : null}
              {check.message ? <span className="check-msg wrap">{check.message}</span> : null}
              {check.specClause ? (
                <span className="muted small">{c.checks.spec(check.specClause)}</span>
              ) : null}
              {check.exchangeIds.length > 0 ? (
                <span className="check-links">
                  {check.exchangeIds.map((id) => {
                    const x = model.byId.get(id);
                    return x ? (
                      <button
                        key={id}
                        type="button"
                        className="btn-link small"
                        onClick={() => onShow(id)}
                      >
                        {c.checks.showMessage(x.n)}
                      </button>
                    ) : null;
                  })}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {findings.length > 0 ? (
        <>
          <h3 className="tab-subhead">{c.checks.findings}</h3>
          <ul className="check-list">
            {findings.map(({ seq, finding }) => (
              <li key={seq} className="check-row">
                <span className="check-msg">{finding.title}</span>
                <span className="muted small">{finding.gapIds.join(', ')}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- Engine (UI-23)

export function QueryTable({ uri }: { uri: string }) {
  const q = uri.indexOf('?');
  if (q < 0) return null;
  const rows = [...new URLSearchParams(uri.slice(q + 1)).entries()];
  return (
    <div className="table-scroll">
      <table className="data-table query-table">
        <thead>
          <tr>
            <th scope="col">Parameter</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i}>
              <th scope="row" className="mono">
                {k}
              </th>
              <td className="mono wrap">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EngineTab({
  rows,
  events,
  onQr,
}: {
  rows: EngineRowView[];
  events: readonly EventEnvelope[];
  onQr: (d: DeliveryOutput) => void;
}) {
  if (rows.length === 0) return <p className="tab-empty">{c.engine.empty}</p>;
  return (
    <ul className="engine-list">
      {rows.map((r) => {
        if (r.exception) {
          return (
            <li key={r.seq} className="engine-row engine-exception">
              <p>
                <strong>{r.exception.exceptionClass}</strong> {r.exception.message}
              </p>
              {r.exception.endedStep ? <p>{c.engine.endedStep}</p> : null}
            </li>
          );
        }
        const call = r.call!;
        const ev = events.find((e) => e.seq === r.seq) as EventEnvelope<'engine.call'> | undefined;
        const d = ev ? deliveryOf(ev) : null;
        return (
          <li key={r.seq} className="engine-row" data-engine-op={call.op}>
            <p className="engine-head">
              <span className="mono">{call.engine}</span> · <code>{call.op}</code> ·{' '}
              <span className="muted small">{call.durationMs} ms</span>
            </p>
            {d ? (
              <div className="engine-delivery">
                <p className="small">{c.engine.channel(d.channel)}</p>
                <p className="mono small wrap">{d.uri}</p>
                <QueryTable uri={d.uri} />
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => onQr(d)}>
                  {c.engine.showQr}
                </button>
              </div>
            ) : null}
            <details className="disclosure">
              <summary>{c.engine.input}</summary>
              <pre className="body-code">{pretty(call.inputSummary)}</pre>
            </details>
            <details className="disclosure">
              <summary>{c.engine.output}</summary>
              <pre className="body-code">{pretty(call.outputSummary)}</pre>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- Events (UI-23)

const GROUPS: Record<string, string> = {
  run: 'run',
  step: 'step',
  exchange: 'traffic',
  gateway: 'traffic',
  engine: 'engine',
  verdict: 'diagnosis',
  fingerprint: 'diagnosis',
  counterfactual: 'diagnosis',
};

function summary(e: EventEnvelope): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'exchange.request':
      return `${String(p.method)} ${String(p.url)}`;
    case 'exchange.response':
      return `${String(p.status)} · ${String(p.durationMs)} ms`;
    case 'step.completed':
      return String(p.outcome);
    case 'step.started':
      return String(p.label);
    case 'engine.call':
      return `${String(p.engine)} ${String(p.op)}`;
    case 'verdict.check': {
      const ch = p.check as { checkId: string; outcome: string };
      return `${ch.checkId} ${ch.outcome}`;
    }
    default:
      return '';
  }
}

const hms = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

function EventsTab({ events }: { events: readonly EventEnvelope[] }) {
  const [group, setGroup] = useState('');
  const [step, setStep] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const rows = events.filter(
    (e) =>
      (!group || GROUPS[e.type.split('.')[0] ?? ''] === group) &&
      (!step || (e.stepKey ?? '').includes(step)),
  );
  return (
    <>
      <div className="tab-toolbar events-filters">
        <label className="field-inline">
          <span>{c.events.filterType}</span>
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">{c.events.allTypes}</option>
            {['run', 'step', 'traffic', 'engine', 'diagnosis'].map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          <span>{c.events.filterStep}</span>
          <input type="text" value={step} onChange={(e) => setStep(e.target.value)} />
        </label>
      </div>
      <div className="table-scroll events-scroll">
        <table className="data-table events-table">
          <caption className="visually-hidden">{c.events.caption(rows.length)}</caption>
          <thead>
            <tr>
              <th scope="col">{c.events.seq}</th>
              <th scope="col">{c.events.time}</th>
              <th scope="col">{c.events.type}</th>
              <th scope="col">{c.events.step}</th>
              <th scope="col">{c.events.summary}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <EventRow
                key={e.seq}
                e={e}
                open={open === e.seq}
                onToggle={() => setOpen(open === e.seq ? null : e.seq)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EventRow({
  e,
  open,
  onToggle,
}: {
  e: EventEnvelope;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td className="mono">
          <button type="button" className="btn-link" aria-expanded={open} onClick={onToggle}>
            {e.seq}
          </button>
        </td>
        <td className="mono">{hms(e.ts)}</td>
        <td className="mono">{e.type}</td>
        <td className="mono">{e.stepKey ?? ''}</td>
        <td className="wrap">{summary(e)}</td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={5}>
            <CopyButton text={JSON.stringify(e)} label={c.events.copyEvent} />
            <pre className="body-code">{pretty(e)}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- the pane (UI-18)

export function Inspector({
  events,
  view,
  steps,
  selected,
  following,
  terminal,
  onSelect,
}: {
  events: readonly EventEnvelope[];
  view: RunView;
  steps: readonly RailStep[];
  selected: string | null;
  following: boolean;
  terminal: boolean;
  onSelect: (stepKey: string) => void;
}) {
  const model = useMemo(() => buildModel(events), [events]);
  const [tab, setTabState] = useState<TabId>(readTab);
  const [scope, setScope] = useState<'step' | 'run'>('step');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [parts, setParts] = useState<Record<string, 'request' | 'response'>>({});
  const [jump, setJump] = useState<ChipTarget | null>(null);
  const [qr, setQr] = useState<DeliveryOutput | null>(null);
  const qrOpener = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const panel = useRef<HTMLDivElement>(null);

  const setTab = (t: TabId) => {
    setTabState(t);
    writeTab(t);
  };

  useEffect(() => {
    if (!jump) return;
    const root = panel.current;
    const card = jump.exchangeId
      ? [...(root?.querySelectorAll<HTMLElement>('[data-exchange]') ?? [])].find(
          (n) => n.dataset.exchange === jump.exchangeId,
        )
      : null;
    const el = jump.exchangeId
      ? card?.querySelector<HTMLElement>('[data-part-panel]')
      : root?.querySelector<HTMLElement>('[data-engine-op="deliver-request"]');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    setJump(null);
  }, [jump]);

  const goTo = (t: ChipTarget) => {
    onSelect(t.stepKey);
    if (t.exchangeId) {
      setTab('messages');
      setOpen((s) => new Set(s).add(t.exchangeId!));
      const part = t.part === 'engine' ? 'request' : t.part;
      setParts((p) => ({ ...p, [t.exchangeId!]: part }));
    } else {
      setTab('engine');
    }
    setJump(t);
  };

  const step = selected ? view.steps[selected] : undefined;
  const label = selected ? (steps.find((s) => s.stepKey === selected)?.label ?? selected) : null;
  const keys = scope === 'run' ? null : new Set(selected ? [selected] : []);
  const exchanges = model.exchanges.filter((x) => !keys || keys.has(x.stepKey ?? ''));
  const engines = model.engines.filter((r) => !keys || keys.has(r.stepKey ?? ''));
  const skipped = step?.state === 'done' && step.outcome === 'skipped';

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = TABS.indexOf(tab);
    let next: TabId | null = null;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length]!;
    else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length]!;
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1]!;
    if (next) {
      e.preventDefault();
      setTab(next);
      tabRefs.current[next]?.focus();
    }
  };

  const stepNote =
    step?.capture === 'none'
      ? c.messages.emptyNone
      : step?.capture === 'partial'
        ? c.messages.emptyPartial(step.coverageNote ?? '')
        : null;

  const bar = (
    <div className="keybar" role="toolbar" aria-label={c.keyBar}>
      {CHIPS.map((id: ChipId) => {
        const t = chipTarget(model, id);
        return (
          <button
            key={id}
            type="button"
            className={`keychip${t ? '' : ' is-missing'}`}
            data-chip={id}
            aria-disabled={t ? undefined : 'true'}
            title={t ? undefined : c.chipMissing}
            onClick={() => (t ? goTo(t) : undefined)}
          >
            {c.chips[id]}
          </button>
        );
      })}
    </div>
  );

  if (!selected && scope === 'step') {
    return (
      <div className="inspector">
        {bar}
        <p className="muted">
          {terminal ? runCopy.inspector.selectStep : runCopy.inspector.noMessages}
        </p>
      </div>
    );
  }

  const word = outcomeWord(step);
  return (
    <div
      className="inspector"
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const n = Number(e.key);
        if (n >= 1 && n <= 5) {
          setTab(TABS[n - 1]!);
          tabRefs.current[TABS[n - 1]!]?.focus();
        }
      }}
    >
      <div className="inspector-head">
        <h2 className="inspector-title">{label ?? c.scope.run}</h2>
        {selected ? <p className="mono muted small">{selected}</p> : null}
        <p className="inspector-chips">
          {step ? <span className="chip chip-outline">{runCopy.rail.outcome[word]}</span> : null}
          {step?.state === 'done' && !skipped ? (
            <CaptureBadge capture={step.capture} note={step.coverageNote} />
          ) : null}
          {following && label ? <span className="chip tone-info">{c.following(label)}</span> : null}
        </p>
        <div role="radiogroup" aria-label={c.scope.label} className="seg">
          {(['step', 'run'] as const).map((s) => (
            <label key={s} className="seg-option">
              <input
                type="radio"
                name="inspector-scope"
                checked={scope === s}
                onChange={() => setScope(s)}
              />
              <span>{c.scope[s]}</span>
            </label>
          ))}
        </div>
      </div>
      {bar}
      <div role="tablist" aria-label={c.tabsLabel} className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            ref={(el) => {
              tabRefs.current[t] = el;
            }}
            type="button"
            role="tab"
            id={`itab-${t}`}
            aria-selected={tab === t}
            aria-controls="ipanel"
            tabIndex={tab === t ? 0 : -1}
            className="tab"
            onClick={() => setTab(t)}
            onKeyDown={onTabKey}
          >
            {c.tabs[t]}
          </button>
        ))}
      </div>
      <div
        ref={panel}
        role="tabpanel"
        id="ipanel"
        aria-labelledby={`itab-${tab}`}
        tabIndex={0}
        className="tabpanel"
      >
        {skipped && scope === 'step' && tab !== 'events' ? (
          <p className="tab-empty">{c.skipped(step?.skipReason ?? '')}</p>
        ) : tab === 'messages' ? (
          <MessagesTab
            list={exchanges}
            runId={view.runId}
            scope={scope}
            stepNote={stepNote}
            open={open}
            setOpen={setOpen}
            parts={parts}
            setPart={(id, p) => setParts((s) => ({ ...s, [id]: p }))}
            labels={model.labels}
          />
        ) : tab === 'decoded' ? (
          <DecodedTab list={exchanges} />
        ) : tab === 'checks' ? (
          <ChecksTab
            model={model}
            keys={keys}
            onShow={(id) => {
              const x = model.byId.get(id);
              if (x?.stepKey) goTo({ stepKey: x.stepKey, exchangeId: id, part: 'response' });
            }}
          />
        ) : tab === 'engine' ? (
          <EngineTab
            rows={engines}
            events={events}
            onQr={(d) => {
              qrOpener.current = document.activeElement as HTMLElement | null;
              setQr(d);
            }}
          />
        ) : (
          <EventsTab events={events} />
        )}
      </div>
      <DeliveryDialog
        delivery={qr}
        onClose={() => {
          setQr(null);
          qrOpener.current?.focus();
        }}
      />
    </div>
  );
}
