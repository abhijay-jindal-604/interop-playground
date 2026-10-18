import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './index.js';
import { RenderError, renderConfig } from './render.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'render-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = {
  PUBLIC_HOST: '192.0.2.44',
  WALTID_VERIFIER_DID: 'did:key:z6MkTestOnlyDid',
  WALTID_VERIFIER_KEY_JWK: '{"kty":"OKP","crv":"Ed25519","x":"test-only"}',
};

function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(path.relative(dir, p), readFileSync(p).toString('base64'));
    }
  };
  walk(dir);
  return out;
}

describe('bff.cli.render-config', () => {
  it('renders the same tree as docker/render-config.sh, byte for byte (ADR-54)', () => {
    const shOut = path.join(tmp, 'sh');
    const tsOut = path.join(tmp, 'ts');
    execFileSync('bash', [path.join(REPO_ROOT, 'docker', 'render-config.sh'), shOut], {
      env: { PATH: process.env.PATH, ...ENV },
      stdio: 'pipe',
    });
    const n = renderConfig(path.join(REPO_ROOT, 'docker', 'config'), tsOut, ENV);
    const a = tree(shOut);
    const b = tree(tsOut);
    expect(n).toBe(a.size);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [k, v] of a) expect(b.get(k), k).toBe(v);
    expect(
      readFileSync(path.join(tsOut, 'certify-authcode', 'db-init', 'certify_init.sql'), 'utf8'),
    ).toContain("'did:web:192.0.2.44:authcode'");
  });

  it('keeps foreign ${...} untouched, decodes .b64, drops stale dirs, fails on empty vars', () => {
    const src = path.join(tmp, 'src');
    for (const d of [
      'certify-common',
      'certify-preauth',
      'certify-authcode',
      'certify-mdoc',
      'certify-iae',
      'certify-iae-mint',
      'mimoto',
      'inji-web',
      'verify',
      'esignet',
      'esignet-ui',
      'waltid-issuer',
      'waltid-verifier',
      'waltid-verifier-signed',
      'eudi',
    ])
      mkdirSync(path.join(src, d), { recursive: true });
    writeFileSync(
      path.join(src, 'mimoto', 'a.conf.tmpl'),
      'host=${PUBLIC_HOST} spring=${server.port} n=${NGINX}',
    );
    writeFileSync(path.join(src, 'mimoto', 'k.bin.b64'), Buffer.from('hello').toString('base64'));
    const out = path.join(tmp, 'out');
    mkdirSync(path.join(out, 'stale'), { recursive: true });
    renderConfig(src, out, { PUBLIC_HOST: 'h' });
    expect(readFileSync(path.join(out, 'mimoto', 'a.conf'), 'utf8')).toBe(
      'host=h spring=${server.port} n=${NGINX}',
    );
    expect(readFileSync(path.join(out, 'mimoto', 'k.bin'), 'utf8')).toBe('hello');
    expect(() => statSync(path.join(out, 'stale'))).toThrow();
    writeFileSync(path.join(src, 'eudi', 'b.tmpl'), '${WALTID_VERIFIER_DID}');
    expect(() => renderConfig(src, out, { PUBLIC_HOST: 'h' })).toThrow(RenderError);
  });
});
