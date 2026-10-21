/**
 * `/environment` (06 UI-02): mode, upstream table, tunnel card, Collab budget and the traffic that
 * reached the gateway outside a run (stream `unattributed`, newest first).
 */
import { useEffect, useState } from 'react';
import type { EnvSnapshot, EventEnvelope } from '@interop-playground/api';
import { copy } from '../copy.js';
import { hhmm, localDateTime, relative } from '../lib/format.js';
import { useStore } from '../state/store.js';
import { StreamClient } from '../state/stream.js';
import { InlineError } from '../components/InlineError.js';
import { Skeleton } from '../components/Skeleton.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { ProbeButton } from '../shell/ProbeButton.js';
import { envSummary } from '../shell/EnvChip.js';
import { PageFrame } from './PageFrame.js';

interface TrafficRow {
  seq: number;
  ts: string;
  method: string;
  url: string;
  port: string;
  rule: string | null;
}

/** Turns a gateway event into a row of the unattributed-traffic table; other events give null. */
function toRow(e: EventEnvelope): TrafficRow | null {
  if (e.type === 'gateway.denied') {
    const p = (e as EventEnvelope<'gateway.denied'>).payload;
    return {
      seq: e.seq,
      ts: e.ts,
      method: p.method,
      url: p.path,
      port: String(p.port),
      rule: p.rule,
    };
  }
  if (e.type === 'exchange.request') {
    const p = (e as EventEnvelope<'exchange.request'>).payload;
    let port: string;
    try {
      const u = new URL(p.url);
      port = u.port || (u.protocol === 'https:' ? '443' : '80');
    } catch {
      port = '';
    }
    return { seq: e.seq, ts: e.ts, method: p.method, url: p.url, port, rule: null };
  }
  return null;
}

/** Follows the unattributed stream and keeps the rows for display. */
function useUnattributed(): TrafficRow[] {
  const [rows, setRows] = useState<TrafficRow[]>([]);
  useEffect(() => {
    const client = new StreamClient({
      streamId: 'unattributed',
      onEvent: (e) => {
        const row = toRow(e);
        if (row) setRows((r) => [row, ...r].slice(0, 500));
      },
    });
    client.start();
    return () => client.stop();
  }, []);
  return rows;
}

/** Card stating the environment mode and health. */
function ModeCard({ env }: { env: EnvSnapshot }) {
  const { mode, healthWord } = envSummary(env, false);
  return (
    <section className="card" aria-labelledby="env-mode">
      <h2 id="env-mode">Mode</h2>
      <dl className="facts">
        <div>
          <dt>Mode</dt>
          <dd>{mode}</dd>
        </div>
        <div>
          <dt>Public host</dt>
          <dd className="mono">{env.publicHost}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{healthWord}</dd>
        </div>
      </dl>
    </section>
  );
}

/** Card showing whether the public tunnel is registered. */
function TunnelCard({ env }: { env: EnvSnapshot }) {
  const t = env.tunnel;
  return (
    <section className="card" aria-labelledby="env-tunnel">
      <h2 id="env-tunnel">Tunnel</h2>
      <p>
        {t.state === 'up'
          ? copy.env.tunnelCardUp(t.host, hhmm(t.since), hhmm(t.expiresAt))
          : copy.env.tunnelCardDown}
      </p>
    </section>
  );
}

/** Card showing the calls made to the shared collab environment in the last minute against its limit. */
function CollabBudget({ env }: { env: EnvSnapshot }) {
  const { used, limit } = env.collabBudget;
  return (
    <section className="card" aria-labelledby="env-collab">
      <h2 id="env-collab">Collab budget</h2>
      <div
        className="meter"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        aria-labelledby="env-collab"
      >
        <span className="meter-fill" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
      </div>
      <p>
        <strong>
          {used}/{limit}
        </strong>{' '}
        per minute. {copy.env.collabNote}
      </p>
    </section>
  );
}

/** The environment screen: upstream versions and health, and traffic the gateway saw that belongs to no run. */
export function EnvironmentPage() {
  const snapshot = useStore((s) => s.env.snapshot);
  const traffic = useUnattributed();
  const env = snapshot.status === 'ready' ? snapshot.data : null;
  return (
    <PageFrame title="Environment" docTitle="Environment" actions={<ProbeButton />}>
      {snapshot.status === 'error' ? (
        <InlineError error={snapshot.error} alert={false} />
      ) : !env ? (
        <div className="env-grid" aria-busy="true">
          <Skeleton height="7rem" radius="var(--radius-md)" />
          <Skeleton height="7rem" radius="var(--radius-md)" />
          <Skeleton height="7rem" radius="var(--radius-md)" />
        </div>
      ) : (
        <>
          <div className="env-grid">
            <ModeCard env={env} />
            <TunnelCard env={env} />
            <CollabBudget env={env} />
          </div>
          <section className="section" aria-labelledby="env-upstreams">
            <h2 id="env-upstreams">Services</h2>
            <div
              className="table-scroll"
              role="region"
              aria-labelledby="env-upstreams"
              tabIndex={0}
            >
              <table className="data-table">
                <caption className="visually-hidden">Services and their last probe</caption>
                <thead>
                  <tr>
                    <th scope="col">Service</th>
                    <th scope="col">Status</th>
                    <th scope="col">Detail</th>
                    <th scope="col">Version</th>
                    <th scope="col">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {env.upstreams.map((u) => (
                    <tr key={u.upstream}>
                      <th scope="row" className="mono">
                        {u.upstream}
                      </th>
                      <td>
                        <StatusBadge state={u.ok ? 'pass' : 'fail'} />
                      </td>
                      <td>{u.detail ?? '—'}</td>
                      <td className="mono">{u.versionFingerprint ?? '—'}</td>
                      <td>
                        <time
                          dateTime={u.checkedAt}
                          title={`${u.checkedAt} (${relative(u.checkedAt)})`}
                        >
                          {localDateTime(u.checkedAt)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      <section className="section" aria-labelledby="env-traffic">
        <h2 id="env-traffic">Traffic outside a run</h2>
        <p className="muted">{copy.env.unattributedNote}</p>
        {traffic.length === 0 ? (
          <p className="empty-line">{copy.env.unattributedEmpty}</p>
        ) : (
          <div className="table-scroll" role="region" aria-labelledby="env-traffic" tabIndex={0}>
            <table className="data-table">
              <caption className="visually-hidden">Requests outside a run, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Method</th>
                  <th scope="col">URL</th>
                  <th scope="col">Port</th>
                  <th scope="col">Rule</th>
                </tr>
              </thead>
              <tbody>
                {traffic.map((r) => (
                  <tr key={r.seq}>
                    <td>
                      <time dateTime={r.ts} title={r.ts}>
                        {hhmm(r.ts)}
                      </time>
                    </td>
                    <td className="mono">{r.method}</td>
                    <td className="mono wrap">{r.url}</td>
                    <td className="mono">{r.port}</td>
                    <td className="mono">{r.rule ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PageFrame>
  );
}
