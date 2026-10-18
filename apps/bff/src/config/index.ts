/**
 * BFF runtime configuration (plan/10 §8.3 env keys, 02 §6.3 listener rules, 04 §1 base URL).
 * The only place in apps/bff/src (besides tests) that may name loopback literals (ADR-06 lint rule).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** UI/API port (04 §1): never published on PUBLIC_HOST. */
export const BFF_PORT = 3100;
/** The address the BFF binds on the host / in tests (02 §6.3: 127.0.0.1:3100 only). */
export const LOOPBACK_HOST = '127.0.0.1';
/** 02 §6.3 guard: the only accepted `Host` values. */
export const ALLOWED_HOSTS: readonly string[] = [`127.0.0.1:${BFF_PORT}`, `localhost:${BFF_PORT}`];
/** The UI origin(s) a non-GET `Origin` must equal (the UI is served from the same listener). */
export const UI_ORIGINS: readonly string[] = ALLOWED_HOSTS.map((h) => `http://${h}`);
/** Internal sidecar base URL on playground_net (04 §2.7). */
export const DEFAULT_SIDECAR_URL = 'http://sidecar:7070';

/** Repository root as seen from this file (apps/bff/src/config -> repo). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface BffConfig {
  /** listen address: 127.0.0.1 on the host; 0.0.0.0 inside the bff container (10 §7.3) */
  listenHost: string;
  port: number;
  dataDir: string;
  flowsDir: string;
  fingerprintsDir: string;
  configDir: string;
  uiDistDir: string;
  sidecarUrl: string;
  logLevel: string;
  mode: 'local' | 'collab';
  publicHost: string | null;
}

function pick(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

/** Reads the 10 §8.3 keys; defaults are the host layout (repo-relative paths). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  const mode = pick(env, 'PLAYGROUND_MODE', 'local');
  return {
    listenHost: pick(env, 'BFF_LISTEN_HOST', LOOPBACK_HOST),
    port: Number(pick(env, 'BFF_PORT', String(BFF_PORT))),
    dataDir: pick(env, 'DATA_DIR', path.join(REPO_ROOT, 'data')),
    flowsDir: pick(env, 'FLOWS_DIR', path.join(REPO_ROOT, 'flows')),
    fingerprintsDir: pick(env, 'FINGERPRINTS_DIR', path.join(REPO_ROOT, 'fingerprints')),
    configDir: pick(env, 'CONFIG_DIR', path.join(REPO_ROOT, '.generated', 'config')),
    uiDistDir: pick(env, 'UI_DIST_DIR', path.join(REPO_ROOT, 'apps', 'ui', 'dist')),
    sidecarUrl: pick(env, 'SIDECAR_URL', DEFAULT_SIDECAR_URL),
    logLevel: pick(env, 'BFF_LOG_LEVEL', 'info'),
    mode: mode === 'collab' ? 'collab' : 'local',
    publicHost: env.PUBLIC_HOST !== undefined && env.PUBLIC_HOST !== '' ? env.PUBLIC_HOST : null,
  };
}

export function uiDistPresent(dir: string): boolean {
  return existsSync(path.join(dir, 'index.html'));
}
