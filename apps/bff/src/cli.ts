/**
 * `playground` one-shot CLI (plan/10 §8.2; the bff image's /usr/local/bin/playground, root script
 * `npm run bff:cli`). Each command returns an exit code; 2 = usage.
 *
 *   playground serve                       start the BFF (same as the image CMD)
 *   playground render-config [--src d] [--out d]
 *   playground esignet-onboard | certify-didurl | guest-smoke
 *   playground wait-ready [--timeout s] <service>...
 *   playground store <rebuild-projections|scan-store|...>   (store module, session A)
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './config/index.js';
import {
  BringupError,
  bringupEnv,
  certifyDidurl,
  esignetOnboard,
  guestSmoke,
  waitReady,
} from './config/bringup.js';
import type { Http, Log } from './config/bringup.js';
import { RenderError, renderConfig, renderEnvFrom } from './config/render.js';

const USAGE = `usage: playground <command>
  serve                                 start the BFF on 3100 and the gateway listeners
  render-config [--src DIR] [--out DIR] render docker/config/** (ADR-54 rules)
  esignet-onboard                       create-or-update the Mimoto OIDC client + personas
  certify-didurl                        re-assert FarmerCredential didUrl on both Certify (G-20)
  guest-smoke                           Mimoto guest download (S-025); exit 3 = gateway URLs missing
  wait-ready [--timeout S] SERVICE...   backend well-known probes (ADR-05)
  store rebuild-projections|scan-store  store maintenance (05 §10)
not in this image yet: mimoto-p12 (scripts/up.sh builds the p12 with openssl, ADR-60),
  suite run (T-29), store check|import|backup|purge`;

export interface CliIo {
  out: Log;
  err: Log;
  http: Http;
  env: NodeJS.ProcessEnv;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}

type StoreCommands = Record<string, (argv: string[]) => Promise<number>>;

/** Session A's interface: `storeCommands` keyed "store rebuild-projections", "store scan-store". */
async function loadStoreCommands(): Promise<StoreCommands | null> {
  const specifier = './cli/store-commands.js';
  try {
    const mod = (await import(specifier)) as { storeCommands?: StoreCommands };
    return mod.storeCommands ?? null;
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return null;
    throw e;
  }
}

async function guarded(io: CliIo, fn: () => Promise<void> | void): Promise<number> {
  try {
    await fn();
    return 0;
  } catch (e) {
    if (e instanceof BringupError) {
      io.err(e.message);
      return e.exitCode;
    }
    if (e instanceof RenderError) {
      io.err(e.message);
      return 1;
    }
    io.err(`unexpected error: ${(e as Error).message}`);
    return 1;
  }
}

/**
 * Runs one `playground` subcommand and returns its exit code (2 means a usage error). I/O and the
 * environment come in through `io` so every command is testable without a process.
 */
export async function runCli(argvIn: string[], io: CliIo): Promise<number> {
  const argv = [...argvIn];
  const cmd = argv.shift();
  const e = bringupEnv(io.env);
  switch (cmd) {
    case 'serve': {
      // process entry = API/UI server + edge gateway (T-11)
      const { main } = await import('./main.js');
      await main(io.env);
      return 0;
    }
    case 'render-config': {
      const src = flag(argv, '--src') ?? path.join(REPO_ROOT, 'docker', 'config');
      const out =
        flag(argv, '--out') ?? io.env.CONFIG_DIR ?? path.join(REPO_ROOT, '.generated', 'config');
      return guarded(io, () => {
        const n = renderConfig(src, out, renderEnvFrom(io.env));
        io.out(`render-config: rendered ${n} files into ${out}`);
      });
    }
    case 'esignet-onboard':
      return guarded(io, () => esignetOnboard(io.http, e, io.out));
    case 'certify-didurl':
      return guarded(io, () => certifyDidurl(io.http, e, io.out));
    case 'guest-smoke':
      return guarded(io, () => guestSmoke(io.http, e, io.out));
    case 'wait-ready': {
      const timeout = Number(flag(argv, '--timeout') ?? '180');
      if (!Number.isFinite(timeout) || argv.length === 0) {
        io.err(USAGE);
        return 2;
      }
      const failed = await waitReady(
        io.http,
        { services: argv, timeoutMs: timeout * 1000, intervalMs: 3000 },
        io.out,
      );
      return failed === 0 ? 0 : 1;
    }
    case 'store': {
      const cmds = await loadStoreCommands();
      const key = `store ${argv[0] ?? ''}`;
      const fn = cmds?.[key];
      if (fn === undefined) {
        io.err(cmds === null ? 'store commands are not available in this build' : USAGE);
        return 2;
      }
      return fn(argv.slice(1));
    }
    case undefined:
    case '-h':
    case '--help':
      io.out(USAGE);
      return cmd === undefined ? 2 : 0;
    default:
      io.err(`unknown command ${cmd}\n${USAGE}`);
      return 2;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const io: CliIo = {
    // the CLI is a terminal program: plain lines on stdout / stderr
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    http: (url, init) => fetch(url, init),
    env: process.env,
  };
  const argv = process.argv.slice(2);
  runCli(argv, io).then(
    (code) => {
      if (argv[0] !== 'serve') process.exit(code);
    },
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
