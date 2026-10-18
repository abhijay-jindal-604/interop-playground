/**
 * `playground store …` one-shot commands (10 §8.2, 05 §10) that session B's `cli.ts` dispatches:
 *   store rebuild-projections [--db <file>] [--run <runId>] [--check]
 *   store scan-store          [--db <file>] [--registry-env <file>]… [--admin-token <file>] [--no-process-env]
 * Exit codes: 0 ok, 1 differences / hits found, 2 usage or store error.
 */
import path from 'node:path';
import { loadRegistry, type RegistrySources } from '../redact/registry.js';
import { scanStore } from '../redact/scan.js';
import { openDriver } from '../store/driver.js';
import { defaultDbPath, openStore } from '../store/index.js';

interface Args {
  flags: Set<string>;
  values: Map<string, string[]>;
}

function parse(argv: string[], valued: string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (valued.includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      values.set(a, [...(values.get(a) ?? []), v]);
    } else if (a.startsWith('--')) {
      flags.add(a);
    } else {
      throw new Error(`unexpected argument ${a}`);
    }
  }
  return { flags, values };
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function rebuildProjections(argv: string[]): number {
  try {
    const a = parse(argv, ['--db', '--run']);
    const db = a.values.get('--db')?.[0] ?? defaultDbPath();
    const store = openStore(db);
    try {
      const runId = a.values.get('--run')?.[0];
      const r = store.sink.rebuildProjections({
        ...(runId ? { runId } : {}),
        dryRun: a.flags.has('--check'),
      });
      out(
        `${a.flags.has('--check') ? 'checked' : 'rebuilt'} ${r.runs} run(s), ${r.events} event(s); ` +
          `${r.differences.length} differing projection row(s)`,
      );
      for (const d of r.differences.slice(0, 50)) out(`  ${d}`);
      return a.flags.has('--check') && r.differences.length > 0 ? 1 : 0;
    } finally {
      store.close();
    }
  } catch (err) {
    console.error(`store rebuild-projections: ${(err as Error).message}`);
    return 2;
  }
}

function scan(argv: string[]): number {
  try {
    const a = parse(argv, ['--db', '--registry-env', '--admin-token']);
    const db = a.values.get('--db')?.[0] ?? defaultDbPath();
    const root = process.cwd();
    const sources: RegistrySources = {
      envFiles: a.values.get('--registry-env') ?? [
        path.join(root, '.env'),
        path.join(root, '.env.local'),
      ],
      adminTokenFile:
        a.values.get('--admin-token')?.[0] ?? path.join(root, 'certs', 'bff-admin.token'),
    };
    if (!a.flags.has('--no-process-env')) sources.env = process.env;
    const registry = loadRegistry(sources);
    // read-only use: no migration, so a scan never changes the file it checks
    const driver = openDriver(db);
    try {
      const hits = scanStore(driver, registry);
      out(`scan-store: ${registry.size} registry value(s) checked, ${hits.length} hit(s)`);
      for (const h of hits) out(`  ${h.table}.${h.column} [${h.rowid}]: ${h.secret} (${h.form})`);
      return hits.length ? 1 : 0;
    } finally {
      driver.close();
    }
  } catch (err) {
    console.error(`store scan-store: ${(err as Error).message}`);
    return 2;
  }
}

/** keys are the full command words; B's `cli.ts` dispatches on them (prompts/build-wave2.md) */
export const storeCommands: Record<string, (argv: string[]) => Promise<number>> = {
  'store rebuild-projections': (argv) => Promise.resolve(rebuildProjections(argv)),
  'store scan-store': (argv) => Promise.resolve(scan(argv)),
};
