/**
 * `/` (06 UI-03). The shell shows the intro and a read-only view of the three catalogue columns
 * (API-02); the selector itself (UI-04..UI-08) replaces the columns in T-30.
 */
import type { AdapterEntry } from '@interop-playground/api';
import { copy } from '../copy.js';
import { boot } from '../state/boot.js';
import { store, useStore } from '../state/store.js';
import { EmptyState } from '../components/EmptyState.js';
import { InlineError } from '../components/InlineError.js';
import { Skeleton } from '../components/Skeleton.js';
import { FORMAT_SHORT } from '../lib/labels.js';
import { PageFrame } from './PageFrame.js';

const COLUMNS = [
  { key: 'issuers', title: 'Issuer', count: 6 },
  { key: 'wallets', title: 'Wallet', count: 5 },
  { key: 'verifiers', title: 'Verifier', count: 7 },
] as const;

function AdapterCard({ entry }: { entry: AdapterEntry }) {
  const d = entry.descriptor;
  const available = entry.availability.available;
  return (
    <li className={`adapter-card${available ? '' : ' is-unavailable'}`}>
      <div className="adapter-card-head">
        <span className="adapter-name">{d.displayName}</span>
        <span className="chip">{d.envClass === 'collab' ? 'Collab sandbox' : 'Local'}</span>
      </div>
      <div className="adapter-card-meta">
        <span className="chip chip-outline">{d.tier}</span>
        {d.formats.map((f) => (
          <span key={f} className="chip chip-outline">
            {FORMAT_SHORT[f]}
          </span>
        ))}
      </div>
      {!available && entry.availability.reason ? (
        <p className="adapter-reason">{entry.availability.reason}</p>
      ) : null}
    </li>
  );
}

export function HomePage() {
  const adapters = useStore((s) => s.catalog.adapters);
  return (
    <PageFrame
      title="Pick who plays each role"
      lead={
        <p>
          Choose an issuer, a wallet and a verifier. The playground runs the whole credential
          journey and records every message.
        </p>
      }
    >
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
            <button type="button" className="btn btn-secondary" onClick={() => void boot(store)}>
              {copy.tryAgain}
            </button>
          }
        />
      ) : (
        <div className="three-cols" aria-busy={adapters.status !== 'ready' || undefined}>
          {COLUMNS.map((col) => {
            const entries = adapters.status === 'ready' ? adapters.data[col.key] : null;
            return (
              <section key={col.key} className="card column" aria-labelledby={`col-${col.key}`}>
                <h2 id={`col-${col.key}`} className="column-title">
                  {col.title}
                  {entries ? <span className="counter muted">{entries.length}</span> : null}
                </h2>
                {entries ? (
                  entries.length === 0 ? (
                    <p className="muted">{copy.catalogEmpty}</p>
                  ) : (
                    <ul className="adapter-list">
                      {entries.map((e) => (
                        <AdapterCard key={e.descriptor.id} entry={e} />
                      ))}
                    </ul>
                  )
                ) : (
                  <div className="adapter-list" aria-hidden="true">
                    {Array.from({ length: col.count }, (_, i) => (
                      <Skeleton key={i} height="3.5rem" radius="var(--radius-md)" />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </PageFrame>
  );
}
