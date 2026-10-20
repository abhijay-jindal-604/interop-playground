/**
 * `playground render-config` (plan/10 §8.1 step 5, §8.2): renders `docker/config/**` into
 * `<out>/<service>/`. The rules are ADR-54's and must give the same tree, byte for byte, as
 * `docker/render-config.sh` (render.test.ts compares both):
 *  - `*.tmpl`: only ${PUBLIC_HOST}, ${CERTIFY_DID_URL}, ${WALTID_VERIFIER_DID},
 *    ${WALTID_VERIFIER_KEY_JWK} are substituted (in that order), the suffix is dropped; a used but
 *    empty variable stops the render; every other ${...} (Spring, HOCON, nginx) stays;
 *  - `*.b64`: base64-decoded, suffix dropped; everything else is copied;
 *  - every top-level directory of <out> is removed first; afterwards no whitelisted placeholder
 *    may survive anywhere in <out>.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const RENDER_VARS = [
  'PUBLIC_HOST',
  'CERTIFY_DID_URL',
  'WALTID_VERIFIER_DID',
  'WALTID_VERIFIER_KEY_JWK',
] as const;
type RenderVar = (typeof RENDER_VARS)[number];
export type RenderEnv = Partial<Record<RenderVar, string>>;

/**
 * The Certify instances and the `did:web` each one must advertise for the given public host.
 * Certify instances and their per-instance did:web (G-20, ADR-24, ADR-50).
 */
export function certifyInstances(publicHost: string): [string, string][] {
  return [
    ['certify-preauth', `did:web:${publicHost}`],
    ['certify-authcode', `did:web:${publicHost}:authcode`],
    ['certify-mdoc', `did:web:${publicHost}:mdoc`],
    ['certify-iae', `did:web:${publicHost}:iae`],
    ['certify-iae-mint', `did:web:${publicHost}:iae`],
  ];
}
export const PLAIN_SERVICES = [
  'mimoto',
  'inji-web',
  'verify',
  'esignet',
  'esignet-ui',
  'waltid-issuer',
  'waltid-verifier',
  'waltid-verifier-signed',
  'eudi',
];

/** A config-rendering failure (missing variable, unresolved placeholder). */
export class RenderError extends Error {
  constructor(message: string) {
    super(`render-config: ${message}`);
    this.name = 'RenderError';
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1));
}

function renderTemplate(file: string, content: string, env: RenderEnv): string {
  let s = content;
  for (const name of RENDER_VARS) {
    const token = `\${${name}}`;
    if (!s.includes(token)) continue;
    const val = env[name] ?? '';
    if (val === '') throw new RenderError(`${file} needs ${token}, which is empty`);
    s = s.split(token).join(val);
  }
  return s;
}

function renderDir(src: string, dst: string, env: RenderEnv): void {
  if (!existsSync(src)) throw new RenderError(`missing ${src}`);
  for (const f of listFiles(src)) {
    const target = path.join(dst, path.relative(src, f));
    mkdirSync(path.dirname(target), { recursive: true });
    if (f.endsWith('.tmpl')) {
      writeFileSync(target.slice(0, -5), renderTemplate(f, readFileSync(f, 'utf8'), env));
    } else if (f.endsWith('.b64')) {
      writeFileSync(target.slice(0, -4), Buffer.from(readFileSync(f, 'utf8'), 'base64'));
    } else {
      writeFileSync(target, readFileSync(f));
    }
  }
}

const SURVIVOR = /\$\{(PUBLIC_HOST|CERTIFY_DID_URL|WALTID_VERIFIER_DID|WALTID_VERIFIER_KEY_JWK)\}/;

/** Renders `<srcDir>` (default `docker/config`) into `<outDir>`; returns the number of files. */
/**
 * Renders every service's config templates into `outDir`, replacing the previous output.
 * @returns the number of files written
 */
export function renderConfig(srcDir: string, outDir: string, env: RenderEnv): number {
  const publicHost = env.PUBLIC_HOST ?? '';
  if (publicHost === '') throw new RenderError('PUBLIC_HOST must be set');
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(outDir)) {
    const p = path.join(outDir, name);
    if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
  }
  for (const [svc, did] of certifyInstances(publicHost)) {
    const e = { ...env, CERTIFY_DID_URL: did };
    renderDir(path.join(srcDir, 'certify-common'), path.join(outDir, svc), e);
    renderDir(path.join(srcDir, svc), path.join(outDir, svc), e);
  }
  for (const svc of PLAIN_SERVICES) {
    const e = { ...env, CERTIFY_DID_URL: undefined };
    renderDir(path.join(srcDir, svc), path.join(outDir, svc), e);
  }
  const files = listFiles(outDir);
  const left = files.filter((f) => SURVIVOR.test(readFileSync(f, 'latin1')));
  if (left.length > 0) throw new RenderError(`unresolved variables in: ${left.join(' ')}`);
  return files.length;
}

/**
 * Picks the three variables the renderer substitutes out of a process environment.
 * The env of `up.sh`: PUBLIC_HOST plus the walt.id verifier DID/JWK from certs/peers.
 */
export function renderEnvFrom(env: NodeJS.ProcessEnv): RenderEnv {
  return {
    PUBLIC_HOST: env.PUBLIC_HOST,
    WALTID_VERIFIER_DID: env.WALTID_VERIFIER_DID,
    WALTID_VERIFIER_KEY_JWK: env.WALTID_VERIFIER_KEY_JWK,
  };
}
