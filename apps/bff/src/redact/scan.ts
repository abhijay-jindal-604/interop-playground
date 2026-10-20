/**
 * `scan-store` (05 §6 Verification): greps every text column and every decompressed blob of the DB
 * for every registry value, in plain form and in base64 form, and for PEM private-key headers
 * anywhere but `holder_keys`. Hits name the location and the secret's NAME, never its value.
 */
import { gunzipSync } from 'node:zlib';
import type { SqlDriver } from '../store/driver.js';
import type { SecretRegistry } from './registry.js';

export interface ScanHit {
  table: string;
  column: string;
  rowid: number | string;
  /** registry NAME or 'PEM_PRIVATE_KEY' */
  secret: string;
  form: 'plain' | 'base64' | 'pem';
}

const PEM_PRIVATE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

function needles(
  registry: SecretRegistry,
): { name: string; form: 'plain' | 'base64'; text: string }[] {
  const out: { name: string; form: 'plain' | 'base64'; text: string }[] = [];
  for (const { name, value } of registry.values()) {
    const b = Buffer.from(value, 'utf8');
    out.push({ name, form: 'plain', text: value });
    for (const f of new Set([b.toString('base64').replace(/=+$/, ''), b.toString('base64url')])) {
      if (f.length >= 4) out.push({ name, form: 'base64', text: f });
    }
  }
  return out;
}

/** Searches every text column and blob of the store for registered secrets; any hit means redaction failed. */
export function scanStore(db: SqlDriver, registry: SecretRegistry): ScanHit[] {
  const hits: ScanHit[] = [];
  const ns = needles(registry);
  const tables = db.all<{ name: string; wr: number }>(
    "SELECT name, (sql LIKE '%WITHOUT ROWID%') AS wr FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  for (const { name: table, wr } of tables) {
    const cols = db.all<{ name: string; pk: number }>(`PRAGMA table_info("${table}")`);
    const pk = wr ? cols.filter((c) => c.pk > 0).map((c) => c.name) : ['rowid'];
    const keyExpr = pk.map((c) => `"${c}"`).join(` || '|' || `);
    const rows = db.all(
      `SELECT ${keyExpr} AS __key, ${cols.map((c) => `"${c.name}"`).join(', ')} FROM "${table}"`,
    );
    for (const row of rows) {
      const rowid = row.__key as string | number;
      for (const c of cols) {
        let v = row[c.name];
        if (v === null || v === undefined || typeof v === 'number' || typeof v === 'bigint')
          continue;
        if (Buffer.isBuffer(v)) {
          v =
            table === 'blobs' && row.enc === 'gzip'
              ? gunzipSync(v).toString('latin1')
              : v.toString('latin1');
        }
        const text = String(v);
        for (const n of ns) {
          const probe = Buffer.from(n.text, 'utf8').toString('latin1');
          if (text.includes(n.text) || text.includes(probe)) {
            hits.push({ table, column: c.name, rowid, secret: n.name, form: n.form });
          }
        }
        if (table !== 'holder_keys' && PEM_PRIVATE.test(text)) {
          hits.push({ table, column: c.name, rowid, secret: 'PEM_PRIVATE_KEY', form: 'pem' });
        }
      }
    }
  }
  return hits;
}
