#!/usr/bin/env node
// Regenerates fixtures/golden/manifest.json: file -> S-ID (research/spikes/LOG.md) -> sha256.
// Usage: node fixtures/golden/make-manifest.mjs
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// First matching rule wins. `sid` lists the S-IDs whose LOG entry records the file.
const RULES = [
  [/^tamper\/S-189/, ['S-189']], [/^tamper\/S-190/, ['S-190']], [/^tamper\/sample-vc-/, ['S-014']],
  [/^tamper\/local-farmer-vc/, ['S-018']],
  [/^traces\/local-preauth-farmer/, ['S-018']], [/^traces\/local-preauth-sdjwt/, ['S-019']],
  [/^traces\/trace-FarmerCredential/, ['S-018']], [/^traces\/trace-PlaygroundSdJwt/, ['S-019', 'S-060']],
  [/^traces\/trace-MockVerifiableCredential/, ['S-019']], [/^traces\/trace-DrivingLicenseCredential/, ['S-026']],
  [/^traces\/trace-esignet-authcode/, ['S-024']], [/^traces\/trace-localverify-certdevelop/, ['S-026']],
  [/^traces\/trace-localverify-/, ['S-022']], [/^traces\/trace-vp-/, ['S-020']],
  [/^s060\//, ['S-060']], [/^sidecar\/S-184/, ['S-184']], [/^sidecar\/S-185/, ['S-185']], [/^sidecar\/S-186/, ['S-186']],
  [/^sidecar\/issued-/, ['S-185', 'S-186']], [/^sidecar\/S-193/, ['S-193']],
  [/^peers\/S-195/, ['S-195']], [/^peers\/S-196/, ['S-196']],
  [/^sessions\/S-200/, ['S-200']], [/^sessions\/S-201/, ['S-201']], [/^sessions\/S-202/, ['S-202']],
  [/^collab\//, ['S-005']],
  [/^diagnosis\/S-077/, ['S-077']], [/^diagnosis\/S-120/, ['S-120']],
];
function* walk(d) {
  for (const n of readdirSync(d).sort()) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) yield* walk(p); else yield p;
  }
}
const files = [];
for (const p of walk(here)) {
  const rel = relative(here, p).split(sep).join('/');
  if (rel === 'manifest.json' || rel === 'make-manifest.mjs') continue;
  const rule = RULES.find(([re]) => re.test(rel));
  if (!rule) throw new Error(`no S-ID rule for ${rel}`);
  files.push({ file: rel, sids: rule[1], sha256: createHash('sha256').update(readFileSync(p)).digest('hex') });
}
writeFileSync(join(here, 'manifest.json'), JSON.stringify({
  note: 'Copied from research/spikes/ (plan/11 section 3.2). TEST-ONLY evidence from throwaway local stacks and public Collab well-knowns; no private keys. Regenerate with make-manifest.mjs.',
  files,
}, null, 2) + '\n');
console.log(`manifest.json: ${files.length} files`);
