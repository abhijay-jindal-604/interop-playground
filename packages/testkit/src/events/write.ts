/** Regenerates `fixtures/events/*.json` from the builder: `npx tsx packages/testkit/src/events/write.ts`. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVENTS_DIR } from '../paths.js';
import { buildEventFixture } from './build.js';
import { serialiseFixture } from './load.js';
import { EVENT_FIXTURE_IDS } from './types.js';

mkdirSync(EVENTS_DIR, { recursive: true });
for (const id of EVENT_FIXTURE_IDS) {
  writeFileSync(path.join(EVENTS_DIR, `${id}.json`), serialiseFixture(buildEventFixture(id)));
}
