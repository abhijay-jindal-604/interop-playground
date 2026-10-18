/**
 * Secret registry and redaction (02 §6.2, 05 §6). Redaction happens once, in `EventSink.append`,
 * before anything is hashed, serialised or stored. Protocol test material (tokens, codes, nonces,
 * credentials) is never in the registry and is stored as is (REQ-24).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** `.env` / `.env.local` keys whose values are secrets (02 §6.2, 10 §8.3). */
export const REGISTRY_ENV_KEYS = [
  'TUNNEL_TOKEN',
  'COLLAB_ESIGNET_MOCK_UIN',
  'COLLAB_ESIGNET_MOCK_OTP',
  'ESIGNET_KEYSTORE_PASSWORD',
  'BFF_ADMIN_TOKEN',
] as const;
/** values shorter than this would corrupt unrelated data when substituted (05 §6) */
export const MIN_SECRET_LENGTH = 4;

export const marker = (name: string): string => `«redacted:${name}»`;

interface Entry {
  name: string;
  value: string;
  /** every textual form that is replaced: plain, URL-encoded, JSON-escaped, base64, base64url */
  forms: string[];
  bytes: Buffer;
}

function formsOf(value: string): string[] {
  const b = Buffer.from(value, 'utf8');
  const forms = new Set([
    value,
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    b.toString('base64'),
    b.toString('base64').replace(/=+$/, ''),
    b.toString('base64url'),
  ]);
  return [...forms]
    .filter((f) => f.length >= MIN_SECRET_LENGTH)
    .sort((x, y) => y.length - x.length);
}

export class SecretRegistry {
  private readonly entries: Entry[] = [];

  /** throws on a value shorter than 4 characters (05 §6) */
  add(name: string, value: string): this {
    if (value.length < MIN_SECRET_LENGTH) {
      throw new Error(`secret registry: ${name} is shorter than ${MIN_SECRET_LENGTH} characters`);
    }
    if (this.entries.some((e) => e.value === value)) return this;
    this.entries.push({ name, value, forms: formsOf(value), bytes: Buffer.from(value, 'utf8') });
    // longest first, so a secret that contains another is replaced whole
    this.entries.sort((a, b) => b.value.length - a.value.length);
    return this;
  }

  get size(): number {
    return this.entries.length;
  }

  /** name + value pairs, for `scan-store` only */
  values(): readonly { name: string; value: string }[] {
    return this.entries.map(({ name, value }) => ({ name, value }));
  }

  redactString(s: string): string {
    if (!this.entries.length || !s) return s;
    let out = s;
    for (const e of this.entries) {
      for (const f of e.forms) if (out.includes(f)) out = out.split(f).join(marker(e.name));
    }
    return out;
  }

  /** binary bodies: byte-level replacement of the UTF-8 form */
  redactBytes(buf: Uint8Array): Buffer {
    let out = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    for (const e of this.entries) {
      if (out.indexOf(e.bytes) < 0) continue;
      const parts: Buffer[] = [];
      const rep = Buffer.from(marker(e.name), 'utf8');
      let from = 0;
      for (let i = out.indexOf(e.bytes); i >= 0; i = out.indexOf(e.bytes, from)) {
        parts.push(out.subarray(from, i), rep);
        from = i + e.bytes.length;
      }
      parts.push(out.subarray(from));
      out = Buffer.concat(parts);
    }
    return out;
  }

  /** deep copy with every string redacted (keys are left alone) */
  redactDeep<T>(value: T): T {
    if (!this.entries.length) return value;
    return this.walk(value) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === 'string') return this.redactString(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (v instanceof Uint8Array) return this.redactBytes(v);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.walk(x);
      return out;
    }
    return v;
  }
}

/** minimal `.env` parser: KEY=VALUE lines, `#` comments, optional surrounding quotes */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    let v = (m[2] ?? '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

export interface RegistrySources {
  env?: Record<string, string | undefined>;
  envFiles?: string[];
  /** `certs/bff-admin.token` (02 §6.2) */
  adminTokenFile?: string;
}

/** Builds the registry from the process env, `.env` / `.env.local` and the admin token file. Empty values are skipped. */
export function loadRegistry(src: RegistrySources = {}): SecretRegistry {
  const merged: Record<string, string | undefined> = {};
  for (const f of src.envFiles ?? []) {
    if (existsSync(f)) Object.assign(merged, parseEnvFile(readFileSync(f, 'utf8')));
  }
  Object.assign(merged, src.env ?? {});
  if (src.adminTokenFile && existsSync(src.adminTokenFile)) {
    merged.BFF_ADMIN_TOKEN = readFileSync(src.adminTokenFile, 'utf8').trim();
  }
  const reg = new SecretRegistry();
  for (const key of REGISTRY_ENV_KEYS) {
    const v = merged[key];
    if (v) reg.add(key, v);
  }
  return reg;
}

/** the default sources inside the repo / container: `.env`, `.env.local`, `certs/bff-admin.token` */
export function defaultRegistrySources(root: string = process.cwd()): RegistrySources {
  return {
    env: process.env,
    envFiles: [path.join(root, '.env'), path.join(root, '.env.local')],
    adminTokenFile: path.join(root, 'certs', 'bff-admin.token'),
  };
}
