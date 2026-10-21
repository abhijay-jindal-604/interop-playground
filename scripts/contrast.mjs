#!/usr/bin/env node
// Contrast gate (06 UI-73 rule 2, UI-75; plan/11 §4.3 `contrast`). Parses the colour tokens of
// apps/ui/src/tokens.css (or the file given as argv[2]) and computes every pair with the WCAG 2.x
// relative-luminance formula, in the light and the dark theme. Exits 1 and names each failing pair.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  path.join(here, '..', 'apps', 'ui', 'src', 'tokens.css');
const css = readFileSync(file, 'utf8');

const SURFACES = ['--bg', '--surface', '--sunken'];
const TEXT = [
  '--text',
  '--text-muted',
  '--accent',
  '--status-pass',
  '--status-fail',
  '--status-warn',
  '--status-info',
  '--status-neutral',
  '--status-skipped',
];
const STATUS = TEXT.filter((t) => t.startsWith('--status-'));
const BADGE_ALPHA = 0.12; // UI-75: badge background = token at 12 % over --surface

/** Body of the first rule whose selector text equals `selector` (no nesting except @media). */
function block(source, selector) {
  const at = source.indexOf(`${selector} {`);
  if (at < 0) return null;
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}
function colours(body) {
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]] = m[2].toLowerCase();
  }
  return out;
}
function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
function luminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function mix(fg, bg, alpha) {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));
}

const themes = {
  light: block(css, ':root'),
  dark: block(css, ":root[data-theme='dark']"),
};
const failures = [];
const lines = [];
for (const [name, body] of Object.entries(themes)) {
  if (body === null) {
    failures.push(`${name}: token block not found`);
    continue;
  }
  const t = colours(body);
  const need = (token) => {
    if (!t[token]) failures.push(`${name}: token ${token} missing`);
    return t[token] ? rgb(t[token]) : null;
  };
  const check = (fgName, fg, bgName, bg, min) => {
    if (!fg || !bg) return;
    const r = ratio(fg, bg);
    lines.push(`${name.padEnd(5)} ${fgName} on ${bgName}: ${r.toFixed(2)} (min ${min})`);
    if (r < min) failures.push(`${name}: ${fgName} on ${bgName} is ${r.toFixed(2)}, needs ${min}`);
  };
  for (const fg of TEXT) for (const bg of SURFACES) check(fg, need(fg), bg, need(bg), 4.5);
  check('--on-accent', need('--on-accent'), '--accent', need('--accent'), 4.5);
  // ink primary button (ADR-126): its label, and the button against the page as a UI component
  check(
    '--button-primary-text',
    need('--button-primary-text'),
    '--button-primary-bg',
    need('--button-primary-bg'),
    4.5,
  );
  check(
    '--button-primary-text',
    need('--button-primary-text'),
    '--button-primary-hover',
    need('--button-primary-hover'),
    4.5,
  );
  check('--button-primary-bg', need('--button-primary-bg'), '--bg', need('--bg'), 3);
  for (const bg of ['--bg', '--surface']) {
    check('--border-ui', need('--border-ui'), bg, need(bg), 3);
    check('--focus', need('--focus'), bg, need(bg), 3);
  }
  // chrome (top bar and rail): equal to the page values since ADR-126, still checked by name
  for (const bg of ['--chrome-bg', '--chrome-raised']) {
    for (const fg of ['--chrome-text', '--chrome-muted', '--chrome-accent'])
      check(fg, need(fg), bg, need(bg), 4.5);
    for (const fg of ['--chrome-border-ui', '--chrome-focus', '--chrome-pass', '--chrome-warn'])
      check(fg, need(fg), bg, need(bg), 3);
  }
  const surface = need('--surface');
  for (const s of STATUS) {
    const fg = need(s);
    if (fg && surface)
      check(s, fg, `badge(${s} 12% over --surface)`, mix(fg, surface, BADGE_ALPHA), 4.5);
  }
}

// The system-dark block must repeat the explicit dark block, or the two dark themes drift apart.
const media = css.match(
  /@media \(prefers-color-scheme: dark\)\s*{\s*:root:not\(\[data-theme='light'\]\)\s*{([^}]*)}/,
);
if (!media) failures.push('dark: prefers-color-scheme block not found');
else if (themes.dark !== null) {
  const a = colours(themes.dark);
  const b = colours(media[1]);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k])
      failures.push(`dark: ${k} differs between data-theme and prefers-color-scheme blocks`);
  }
}

if (process.argv.includes('--verbose')) for (const l of lines) console.log(l);
if (failures.length > 0) {
  for (const f of failures) console.error(`contrast: FAIL ${f}`);
  process.exit(1);
}
console.log(`contrast: ${lines.length} pairs pass (${path.relative(process.cwd(), file)})`);
