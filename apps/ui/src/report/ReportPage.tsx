/**
 * `/runs/:runId/report` (06 UI-51, the UI half of T-32): the REQ-26 per-run report from API-45
 * (`?format=json` for the view, `?format=markdown` for the Markdown tab, the downloads and the copy
 * button), with API-22 for the run state. Tabs Report | Markdown | JSON live in `?tab=`.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { CheckResult, Run, RunReport } from '@interop-playground/api';
import { ApiError, apiGet, apiGetText } from '../api/client.js';
import { EmptyState } from '../components/EmptyState.js';
import { InlineError } from '../components/InlineError.js';
import { shortId } from '../components/RunLink.js';
import { Skeleton } from '../components/Skeleton.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { reportCopy as c, selectorCopy } from '../copy.js';
import { announce } from '../lib/announce.js';
import { FORMAT_LABEL } from '../lib/labels.js';
import { PageFrame } from '../routes/PageFrame.js';
import { useAdapterName } from '../run/parts.js';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; report: RunReport }
  | { status: 'not-terminal'; state: string }
  | { status: 'not-found' }
  | { status: 'error'; error: unknown };

const TABS = ['report', 'markdown', 'json'] as const;
type Tab = (typeof TABS)[number];

const verdictWord = (r: RunReport) => r.fields.verdict.outcome.toUpperCase();

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="report-section" aria-labelledby={`h-${id}`} id={id}>
      <h2 id={`h-${id}`} className="report-heading">
        <a href={`#${id}`}>{title}</a>
      </h2>
      {children}
    </section>
  );
}

function Combination({ r, run }: { r: RunReport; run: Run | null }) {
  const name = useAdapterName();
  const f = r.fields;
  const knobs = Object.entries(f.knobs ?? {});
  const rows: [string, React.ReactNode][] = [
    [c.fields.issuer, `${name(f.issuer)} (${f.issuer})`],
    [c.fields.wallet, `${name(f.wallet)} (${f.wallet})`],
    [c.fields.verifier, `${name(f.verifier)} (${f.verifier})`],
    [c.fields.format, FORMAT_LABEL[f.format] ?? f.format],
    [c.fields.proofType, f.proofType],
    [c.fields.grant, f.grant ? (selectorCopy.grantWord[f.grant] ?? f.grant) : c.fields.none],
    [c.fields.mode, f.mode ? (selectorCopy.recipe.modes[f.mode] ?? f.mode) : c.fields.none],
    [
      c.fields.env,
      (['issuer', 'wallet', 'verifier'] as const).map((k) => `${k}: ${f.env[k]}`).join(', '),
    ],
    [
      c.fields.versions,
      <span className="version-chips" key="v">
        {(['issuer', 'wallet', 'verifier'] as const).map((k) => (
          <span key={k} className="mono small" title={f.versions[k]}>
            {k}: {f.versions[k]}
          </span>
        ))}
      </span>,
    ],
    [
      c.fields.knobs,
      knobs.length === 0
        ? c.fields.defaults
        : knobs
            .map(
              ([k, v]) => `${k}=${String(v)}${f.nonDefaultKnobs.includes(k as never) ? ' *' : ''}`,
            )
            .join(', '),
    ],
    [
      c.fields.verdict,
      <span className="report-verdict" key="o">
        <StatusBadge state={f.verdict.outcome} />
        {f.verdict.verification ? (
          <span className="muted small">({f.verdict.verification})</span>
        ) : null}
      </span>,
    ],
    [c.fields.failedStep, f.failedStepKey ? <code>{f.failedStepKey}</code> : c.fields.none],
    [c.fields.errorDetail, f.errorDetail ?? (run?.errorCode ? run.errorCode : c.fields.none)],
  ];
  return (
    <table className="report-table report-kv">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FailingChecks({ checks, runId }: { checks: CheckResult[]; runId: string }) {
  if (checks.length === 0) return <p className="muted">{c.noFailing}</p>;
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-label={`${c.sections.failing} table`}
    >
      <table className="report-table">
        <thead>
          <tr>
            {c.checkCols.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {checks.map((k, i) => (
            <tr key={`${k.checkId}-${i}`}>
              <td className="mono">
                {k.exchangeIds[0] ? (
                  <Link to={`/runs/${runId}#exchange=${k.exchangeIds[0]}`}>{k.checkId}</Link>
                ) : (
                  k.checkId
                )}
              </td>
              <td>{k.source}</td>
              <td className="mono">{k.code ?? ''}</td>
              <td>{k.specClause ?? ''}</td>
              <td className="mono wrap">{k.message ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Diagnosis({ r }: { r: RunReport }) {
  const { matches } = r.diagnosis;
  const passing = r.fields.verdict.outcome === 'pass';
  if (matches.length === 0)
    return (
      <p className="muted">
        {r.fields.verdict.outcome === 'fail' || r.fields.verdict.outcome === 'blocked'
          ? c.unclassified
          : c.noFindings}
      </p>
    );
  return (
    <>
      {passing ? <p className="report-sub">{c.findingsOnPass}</p> : null}
      <ul className="report-cards">
        {matches.map((m) => (
          <li key={m.fingerprintId} className="report-card">
            <p className="report-card-head">
              <span className="chip chip-outline mono">
                {m.confidence === 'possible' ? 'possible ' : ''}
                {m.fingerprintId}
              </span>{' '}
              <strong>{m.title}</strong>
            </p>
            <dl className="facts">
              <div>
                <dt>{c.match.gaps}</dt>
                <dd>{m.gapIds.join(', ') || c.fields.none}</dd>
              </div>
              <div>
                <dt>{c.match.side}</dt>
                <dd>
                  {m.deviatingSide}: {m.component.name} {m.component.versions}
                </dd>
              </div>
              <div>
                <dt>{c.match.clause}</dt>
                <dd>{m.specClause}</dd>
              </div>
              <div>
                <dt>{c.match.confidence}</dt>
                <dd>{c.confidence[m.confidence] ?? m.confidence}</dd>
              </div>
              <div>
                <dt>{c.match.evidence}</dt>
                <dd>{m.evidenceSIds.join(', ') || c.fields.none}</dd>
              </div>
              <div>
                <dt>{c.match.exchanges}</dt>
                <dd className="mono small">
                  {m.matchedExchangeIds.map((x) => (
                    <Link key={x} to={`/runs/${r.runId}#exchange=${x}`}>
                      {x.slice(-8)}
                    </Link>
                  ))}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function FixIt({ r }: { r: RunReport }) {
  const { offers, noFixReason } = r.diagnosis;
  if (r.claimSentence)
    return (
      <p>
        <strong>{c.claim}:</strong> {r.claimSentence}
      </p>
    );
  if (offers.length > 0)
    return (
      <ul className="report-list">
        {offers.map((o) => (
          <li key={`${o.fingerprintId}-${o.knobId}`}>
            <code>{c.offer(o.knobId, o.from, o.to)}</code>{' '}
            <span className="muted small">{c.offerProven(o.provenBy.join(', '))}</span>
          </li>
        ))}
      </ul>
    );
  return <p className="muted">{noFixReason ? (c.noFix[noFixReason] ?? noFixReason) : c.noOffer}</p>;
}

function ReportBody({ r, run }: { r: RunReport; run: Run | null }) {
  const cov = r.diagnosis.coverageBanner;
  return (
    <div className="report-body">
      <Section id="combination" title={c.sections.combination}>
        <Combination r={r} run={run} />
      </Section>
      <Section id="failing-checks" title={c.sections.failing}>
        <FailingChecks checks={r.fields.failingChecks} runId={r.runId} />
      </Section>
      <Section id="diagnosis" title={c.sections.diagnosis}>
        <Diagnosis r={r} />
      </Section>
      <Section id="fix-it" title={c.sections.fixit}>
        <FixIt r={r} />
      </Section>
      {r.tamper ? (
        <Section id="tamper" title={c.sections.tamper}>
          <p>
            <code>{r.tamper.tmpId}</code> {r.tamper.expected} / {r.tamper.observed}:{' '}
            <StatusBadge state={r.tamper.verdict} />
            {r.tamper.reason ? ` ${r.tamper.reason}` : ''}
          </p>
        </Section>
      ) : null}
      <Section id="coverage" title={c.sections.coverage}>
        {cov.length === 0 ? (
          <p className="muted">{c.coverageAll}</p>
        ) : (
          <ul className="report-list">
            {cov.map((h) => (
              <li key={h.stepKey}>
                <code>{h.stepKey}</code>: {c.captureWord[h.capture]}
                {h.reason ? `: ${h.reason}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="steps" title={c.sections.steps}>
        <ol className="report-steps">
          {r.steps.map((s) => (
            <li key={s.stepKey}>
              <code>{s.stepKey}</code>{' '}
              <StatusBadge state={s.outcome === 'skipped' ? 'n/a' : (s.outcome ?? 'not-run')} />
              {s.capture && s.capture !== 'full' && s.outcome !== 'skipped' ? (
                <span className="chip chip-outline">{`capture ${s.capture}`}</span>
              ) : null}
              {s.skipReason ? <span className="muted small"> {s.skipReason}</span> : null}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

export function ReportPage() {
  const { runId = '' } = useParams();
  const sid = shortId(runId);
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as Tab)
    : 'report';
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [run, setRun] = useState<Run | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [mdError, setMdError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const path = `/reports/runs/${encodeURIComponent(runId)}`;

  useEffect(() => {
    let live = true;
    setLoad({ status: 'loading' });
    apiGet<Run>(`/runs/${encodeURIComponent(runId)}`)
      .then((r) => live && setRun(r))
      .catch(() => undefined);
    apiGet<RunReport>(path, { format: 'json' })
      .then((report) => live && setLoad({ status: 'ready', report }))
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.code === 'not_found')
          setLoad({ status: 'not-found' });
        else if (error instanceof ApiError && error.code === 'run_not_terminal')
          setLoad({
            status: 'not-terminal',
            state: typeof error.details?.state === 'string' ? error.details.state : 'running',
          });
        else setLoad({ status: 'error', error });
      });
    return () => {
      live = false;
    };
  }, [runId, path, attempt]);

  const getMarkdown = useCallback(async (): Promise<string> => {
    if (markdown !== null) return markdown;
    const text = await apiGetText(path, { format: 'markdown' });
    setMarkdown(text);
    return text;
  }, [markdown, path]);

  useEffect(() => {
    if (tab !== 'markdown' || load.status !== 'ready' || markdown !== null) return;
    getMarkdown().catch((e: unknown) => setMdError(e));
  }, [tab, load.status, markdown, getMarkdown]);

  const crumbs = [
    { label: 'History', to: '/history' },
    { label: c.crumbRun(sid), to: `/runs/${runId}` },
    { label: c.crumb },
  ];

  if (load.status === 'not-found')
    return (
      <PageFrame title={c.notFound.title} docTitle={c.docTitle(sid)} crumbs={crumbs}>
        <EmptyState
          title={c.notFound.title}
          body={<p>{c.notFound.body}</p>}
          action={
            <Link className="btn btn-primary" to="/history">
              {c.notFound.action}
            </Link>
          }
        />
      </PageFrame>
    );
  if (load.status === 'not-terminal')
    return (
      <PageFrame title={c.notTerminal.title} docTitle={c.docTitle(sid)} crumbs={crumbs}>
        <EmptyState
          title={c.notTerminal.title}
          body={<p>{c.notTerminal.body(run?.state ?? load.state)}</p>}
          action={
            <Link className="btn btn-primary" to={`/runs/${runId}`}>
              {c.actions.open}
            </Link>
          }
        />
      </PageFrame>
    );
  if (load.status === 'error')
    return (
      <PageFrame title={c.crumb} docTitle={c.docTitle(sid)} crumbs={crumbs}>
        <InlineError error={load.error} onRetry={() => setAttempt((n) => n + 1)} />
      </PageFrame>
    );
  if (load.status === 'loading')
    return (
      <PageFrame
        title={<Skeleton width="16rem" height="1.75rem" />}
        docTitle={c.docTitle(sid)}
        crumbs={crumbs}
      >
        <div className="report-body" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height="6rem" radius="var(--radius-md)" />
          ))}
        </div>
      </PageFrame>
    );

  const r = load.report;
  const json = JSON.stringify(r, null, 2);
  const cov = r.diagnosis.coverageBanner.filter((h) => h.capture === 'partial');
  return (
    <PageFrame
      title={
        <>
          {c.title(sid, verdictWord(r))} <StatusBadge state={r.fields.verdict.outcome} size="md" />
        </>
      }
      docTitle={c.docTitle(sid)}
      crumbs={crumbs}
      actions={
        <>
          <Link className="btn btn-secondary btn-sm" to={`/runs/${runId}`}>
            {c.actions.open}
          </Link>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => download(`run-${runId}.json`, json, 'application/json')}
          >
            {c.actions.json}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() =>
              void getMarkdown().then(
                (t) => download(`run-${runId}.md`, t, 'text/markdown'),
                (e: unknown) => setMdError(e),
              )
            }
          >
            {c.actions.markdown}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() =>
              void getMarkdown().then(
                (t) => navigator.clipboard?.writeText(t).then(() => announce(c.actions.copied)),
                (e: unknown) => setMdError(e),
              )
            }
          >
            {c.actions.copy}
          </button>
        </>
      }
      lead={
        <ul className="chip-row" aria-label="Report facts">
          <li className="chip chip-outline">{r.fields.verdict.kind}</li>
          {run?.label ? <li className="chip chip-outline">{run.label}</li> : null}
          {run?.origin === 'imported' ? <li className="chip chip-outline">Imported</li> : null}
        </ul>
      }
    >
      {run?.state === 'failed' ? (
        <p className="banner tone-warn report-banner" role="status">
          {c.failedRun(run.errorCode ?? 'internal_error')}
        </p>
      ) : null}
      {cov.length > 0 ? (
        <p className="banner tone-info report-banner" role="status">
          {c.coverageBanner(cov.map((h) => h.stepKey).join(', '))}
        </p>
      ) : null}
      {mdError ? <InlineError error={mdError} /> : null}
      <div role="tablist" aria-label={c.tabsLabel} className="tabs report-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`rtab-${t}`}
            aria-selected={t === tab}
            aria-controls="rpanel"
            tabIndex={t === tab ? 0 : -1}
            className={`tab${t === tab ? ' is-active' : ''}`}
            onClick={() =>
              setParams(
                (p) => {
                  const n = new URLSearchParams(p);
                  if (t === 'report') n.delete('tab');
                  else n.set('tab', t);
                  return n;
                },
                { replace: true },
              )
            }
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const next = TABS[(TABS.indexOf(t) + (e.key === 'ArrowRight' ? 1 : 2)) % 3]!;
              setParams(
                (p) => {
                  const n = new URLSearchParams(p);
                  if (next === 'report') n.delete('tab');
                  else n.set('tab', next);
                  return n;
                },
                { replace: true },
              );
              document.getElementById(`rtab-${next}`)?.focus();
            }}
          >
            {c.tabs[t]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="rpanel" aria-labelledby={`rtab-${tab}`} className="report-panel">
        {tab === 'report' ? (
          <ReportBody r={r} run={run} />
        ) : tab === 'markdown' ? (
          markdown === null ? (
            <Skeleton height="8rem" />
          ) : (
            <pre className="body-code report-pre" tabIndex={0} aria-label={c.markdownLabel}>
              {markdown}
            </pre>
          )
        ) : (
          <pre className="body-code report-pre" tabIndex={0} aria-label={c.jsonLabel}>
            {json}
          </pre>
        )}
      </div>
    </PageFrame>
  );
}
