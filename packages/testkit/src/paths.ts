/** Repository paths used by the testkit (plan/11 §3): fixtures live at the repo root, not in a package. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
export const GOLDEN_DIR = path.join(FIXTURES_DIR, 'golden');
export const EVENTS_DIR = path.join(FIXTURES_DIR, 'events');
export const FLOWS_DIR = path.join(REPO_ROOT, 'flows');
export const API_SCHEMA_PATH = path.join(REPO_ROOT, 'packages', 'api', 'api.schema.json');
