// compose-lint (plan/11 §4.3, plan/10 §7): static checks on compose.yaml, versions.lock and the
// rendered config. Runs `docker compose config --format json` (client side only, no daemon, no
// containers) with a test .env, and docker/render-config.sh into a temp directory.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const PUBLIC_HOST = '192.0.2.10'; // TEST-NET-1 (plan/11 §2)
const GATEWAY_PORTS = [
  443, 8093, 8096, 8097, 8098, 8099, 3004, 3005, 8095, 8443, 18103, 18443, 18444, 18445,
];
// plan/10 §7.4: services that run a JVM
const JVM_SERVICES = [
  'sidecar',
  'certify-preauth',
  'certify-authcode',
  'certify-mdoc',
  'certify-iae',
  'certify-iae-mint',
  'mimoto',
  'verify-service',
  'esignet',
  'mock-identity-system',
  'waltid-issuer-api2',
  'waltid-verifier-api2',
  'waltid-verifier-api2-signed',
  'eudi-verifier',
];
const TRUST_OPTS =
  '-Djavax.net.ssl.trustStore=/certs/jvm-truststore.p12 -Djavax.net.ssl.trustStorePassword=changeit -Djavax.net.ssl.trustStoreType=PKCS12';
const RENDER_VARS =
  /\$\{(PUBLIC_HOST|CERTIFY_DID_URL|WALTID_VERIFIER_DID|WALTID_VERIFIER_KEY_JWK)\}/;

interface Port {
  host_ip?: string;
  published?: string | number;
  target: number;
}
interface Mount {
  type: string;
  source?: string;
  target: string;
  read_only?: boolean;
}
interface Service {
  image?: string;
  build?: unknown;
  ports?: Port[];
  volumes?: Mount[];
  environment?: Record<string, string | null>;
  labels?: Record<string, string>;
  restart?: string;
  healthcheck?: { test?: string[]; disable?: boolean };
}
interface Project {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
}

let tmp: string;
let project: Project;
let renderDir: string;

function composeConfig(profiles: string): Project {
  const out = execFileSync(
    'docker',
    [
      'compose',
      '-p',
      'interop-playground',
      '--env-file',
      join(tmp, 'test.env'),
      '--env-file',
      join(tmp, 'test.env.local'),
      'config',
      '--format',
      'json',
    ],
    { cwd: root, env: { ...process.env, COMPOSE_PROFILES: profiles }, encoding: 'utf8' },
  );
  return JSON.parse(out) as Project;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'compose-lint-'));
  writeFileSync(join(tmp, 'test.env'), `PUBLIC_HOST=${PUBLIC_HOST}\n`);
  writeFileSync(join(tmp, 'test.env.local'), 'ESIGNET_KEYSTORE_PASSWORD=test-only\n');
  // every profile except `debug` (developer-only loopback ports, 02 §2.3)
  project = composeConfig('local,mdoc-spec,peers,iae');
  renderDir = join(tmp, 'rendered');
  execFileSync('bash', [join(root, 'docker', 'render-config.sh'), renderDir], {
    env: {
      ...process.env,
      PUBLIC_HOST,
      WALTID_VERIFIER_DID: 'did:key:z6MkTestOnly',
      WALTID_VERIFIER_KEY_JWK: '{"kty":"OKP","crv":"Ed25519","x":"test"}',
    },
    encoding: 'utf8',
  });
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('compose-lint', () => {
  it('docker compose config passes for every profile alone and combined', () => {
    for (const p of [
      '',
      'local',
      'mdoc-spec',
      'peers',
      'iae',
      'debug',
      'local,mdoc-spec,peers,iae,debug',
    ]) {
      expect(() => composeConfig(p), `profile "${p}"`).not.toThrow();
    }
  });

  it('(1) only bff publishes host ports', () => {
    const publishers = Object.entries(project.services)
      .filter(([, s]) => (s.ports ?? []).length > 0)
      .map(([n]) => n);
    expect(publishers).toEqual(['bff']);
  });

  it('(2) bff publishes 3100 on loopback only and every gateway port on both addresses; 9000 never', () => {
    const got = (project.services.bff?.ports ?? []).map(
      (p) => `${p.host_ip ?? ''}:${String(p.published)}:${p.target}`,
    );
    const want = ['127.0.0.1:3100:3100'];
    for (const port of GATEWAY_PORTS) {
      want.push(`127.0.0.1:${port}:${port}`, `${PUBLIC_HOST}:${port}:${port}`);
    }
    expect([...got].sort()).toEqual([...want].sort());
    expect(got.some((g) => g.includes(':9000'))).toBe(false);
  });

  it('(3) host port 443 is used only by the bff mapping', () => {
    const owners = Object.entries(project.services)
      .filter(([, s]) => (s.ports ?? []).some((p) => String(p.published) === '443'))
      .map(([n]) => n);
    expect(owners).toEqual(['bff']);
  });

  it('(4) every JVM service has the label, JAVA_TOOL_OPTIONS and the truststore mount (G-106)', () => {
    for (const [name, s] of Object.entries(project.services)) {
      const labelled = s.labels?.['playground.jvm'] === 'true';
      if (JVM_SERVICES.includes(name)) expect(labelled, `${name} lacks playground.jvm`).toBe(true);
      if (!labelled) continue;
      expect(s.environment?.JAVA_TOOL_OPTIONS, name).toBe(TRUST_OPTS);
      const m = (s.volumes ?? []).find((v) => v.target === '/certs/jvm-truststore.p12');
      expect(m, `${name} truststore mount`).toBeDefined();
      expect(m?.type).toBe('bind');
      expect(m?.read_only).toBe(true);
      expect(m?.source).toBe(join(root, 'certs', 'jvm-truststore.p12'));
    }
    for (const n of JVM_SERVICES) expect(project.services[n], `${n} missing`).toBeDefined();
  });

  it('(5) every postgres/redis service mounts a named volume (RISK-07)', () => {
    const declared = Object.keys(project.volumes ?? {});
    for (const [name, s] of Object.entries(project.services)) {
      if (!/^(postgres|redis):/.test(s.image ?? '')) continue;
      const named = (s.volumes ?? []).filter((v) => v.type === 'volume');
      expect(named.length, `${name} has no named volume`).toBeGreaterThan(0);
      for (const v of named) expect(declared).toContain(v.source);
      if (s.image?.startsWith('postgres:')) {
        // PostgreSQL 18 images (postgres:bookworm at the locked digest) keep data under
        // /var/lib/postgresql; older majors under /var/lib/postgresql/data (G-125)
        const dataTarget = named.some((v) =>
          ['/var/lib/postgresql/data', '/var/lib/postgresql'].includes(v.target),
        );
        expect(dataTarget, `${name} data directory is not on a named volume`).toBe(true);
      }
    }
  });

  it('(6) datashare-service reads playground-datashare read-only, no ports; bff mounts it read-write', () => {
    const ds = project.services['datashare-service'];
    expect(ds).toBeDefined();
    expect(ds?.ports ?? []).toEqual([]);
    const m = (ds?.volumes ?? []).find((v) => v.source === 'playground-datashare');
    expect(m?.read_only).toBe(true);
    const b = (project.services.bff?.volumes ?? []).find(
      (v) => v.source === 'playground-datashare',
    );
    expect(b).toBeDefined();
    expect(b?.read_only ?? false).toBe(false);
  });

  it('(7) certify-preauth has no vp-request config; the iae services match S-206 (ADR-50)', () => {
    const pre = project.services['certify-preauth'];
    expect((pre?.volumes ?? []).some((v) => v.target.includes('vp_request'))).toBe(false);
    expect(Object.keys(pre?.environment ?? {}).some((k) => k.includes('vp-request'))).toBe(false);
    const iae = project.services['certify-iae'];
    expect(iae?.environment?.active_profile_env).toBe('default, iae');
    expect(iae?.environment?.['mosip_certify_vp-request_config-file-url']).toBe(
      'http://certify-iae-nginx:82/vp_request_config-dcql-ldp.json',
    );
    const nginx = readFileSync(join(root, 'docker/config/certify-iae/nginx.conf'), 'utf8');
    expect(nginx).toMatch(/listen 82;[\s\S]*root \/cfg;/);
    const cfgMount = (project.services['certify-iae-nginx']?.volumes ?? []).find(
      (v) => v.target === '/cfg',
    );
    expect(cfgMount?.read_only).toBe(true);
    const mint = project.services['certify-iae-mint'];
    const keys = (s?: Service) =>
      (s?.volumes ?? []).find((v) => v.source === 'certify-iae-keys')?.target;
    expect(keys(iae)).toBe('/home/mosip/CERTIFY_PKCS12');
    expect(keys(mint)).toBe('/home/mosip/CERTIFY_PKCS12');
    expect(iae?.environment?.mosip_certify_database_hostname).toBe('certify-iae-db');
    expect(mint?.environment?.mosip_certify_database_hostname).toBe('certify-iae-db');
  });

  it('(8) verify-service redirects to the loopback return page (S-200)', () => {
    expect(project.services['verify-service']?.environment?.INJI_VERIFY_REDIRECT_URI).toBe(
      'http://127.0.0.1:3100/return/vp',
    );
  });

  it('(9) rendered config: Mimoto trusts the Verify client with the loopback redirect; nothing unresolved', () => {
    const tv = JSON.parse(
      readFileSync(join(renderDir, 'mimoto/mimoto-trusted-verifiers.json'), 'utf8'),
    ) as {
      verifiers: { client_id: string; redirect_uri: string[] }[];
    };
    const entry = tv.verifiers.find(
      (v) =>
        v.client_id ===
        `redirect_uri:https://${PUBLIC_HOST}:8443/v1/verify/v2/vp-submission/direct-post`,
    );
    expect(entry?.redirect_uri).toEqual(['http://127.0.0.1:3100/return/vp']);
    const files = walk(renderDir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      if (f.endsWith('.jks')) continue;
      expect(RENDER_VARS.test(readFileSync(f, 'utf8')), f).toBe(false);
    }
  });

  it('(10) every image is pinned in versions.lock by sha256 and the lock covers every image', () => {
    const lock = JSON.parse(readFileSync(join(root, 'versions.lock'), 'utf8')) as {
      checkedAt: string;
      images: Record<string, string>;
    };
    for (const d of Object.values(lock.images)) expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    const lockFor = (ref: string): string[] =>
      Object.entries(lock.images)
        .filter(([k]) => k.split('#')[0] === ref)
        .map(([, v]) => v);
    for (const [name, s] of Object.entries(project.services)) {
      if (s.build !== undefined) {
        expect(s.image, `${name} built image`).toMatch(/^interop-playground\//);
        continue;
      }
      const [ref, digest] = (s.image ?? '').split('@');
      const pinned = lockFor(ref ?? '');
      expect(pinned.length, `${name}: ${s.image} not in versions.lock`).toBeGreaterThan(0);
      if (digest) expect(pinned, `${name} digest`).toContain(digest);
    }
  });

  it('certify-mdoc and the iae services are digest-locked in compose.yaml (RISK-19, RISK-39)', () => {
    for (const n of ['certify-mdoc', 'certify-iae', 'certify-iae-mint']) {
      expect(project.services[n]?.image, n).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('(11) Mimoto restart policy is "no" (ADR-14)', () => {
    expect(project.services.mimoto?.restart).toBe('no');
  });
});
