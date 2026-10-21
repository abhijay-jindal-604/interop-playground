/**
 * Live e2e helpers for the video takes (plan/13 §2.1 recording rules): the advertised host
 * (`PUBLIC_HOST`, a LAN IP) is masked in every text node and attribute shown on screen, the QR
 * module pattern is blurred (it encodes the response URI with that host), and the page video is
 * copied to `LIVE_TAKE` when set. Shot marks (`mark`) give the cut points of a multi-shot take.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page, TestInfo } from '@playwright/test';

const repo = path.resolve(import.meta.dirname, '..', '..');

/** PUBLIC_HOST from the environment or the repo's `.env` (never printed) */
export function publicHost(): string | null {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  try {
    const m = /^PUBLIC_HOST=(.+)$/m.exec(readFileSync(path.join(repo, '.env'), 'utf8'));
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** masks the host on screen and blurs QR codes (the take never shows a LAN IP) */
export async function maskPrivate(page: Page): Promise<void> {
  const host = publicHost();
  await page.addInitScript((h: string | null) => {
    const style = document.createElement('style');
    style.textContent = 'svg.qr { filter: blur(5px); }';
    const mask = (s: string): string => (h ? s.split(h).join('<PUBLIC_HOST>') : s);
    const walk = (root: Node): void => {
      const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = it.nextNode(); n; n = it.nextNode())
        if (n.nodeValue && h && n.nodeValue.includes(h)) n.nodeValue = mask(n.nodeValue);
      if (root instanceof Element)
        for (const el of [root, ...Array.from(root.querySelectorAll('*'))])
          for (const a of Array.from(el.attributes))
            if (h && a.value.includes(h) && a.name !== 'href')
              el.setAttribute(a.name, mask(a.value));
    };
    const start = (): void => {
      document.head.appendChild(style);
      walk(document.body);
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'characterData') walk(r.target.parentNode ?? r.target);
          for (const n of Array.from(r.addedNodes)) walk(n);
          if (r.type === 'attributes') walk(r.target);
        }
      }).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  }, host);
}

/**
 * shot marks of a multi-shot take. The page video does not run in step with the wall clock (it
 * drops frames while the machine is busy), so each mark also flashes a magenta strip across the
 * top 8 px of the page for 300 ms; `scripts/cut-takes.sh` finds the strips in the video and cuts
 * between them, leaving the strip frames out. The wall-clock seconds are kept in the marks file.
 */
export function marker(page: Page): {
  mark: (shot: string) => Promise<void>;
  /** waits until `sec` seconds into the current shot (counted from the end of its mark strip) */
  at: (sec: number) => Promise<void>;
  marks: [string, number][];
} {
  const t0 = Date.now();
  const marks: [string, number][] = [];
  let shotStart = t0;
  const mark = async (shot: string): Promise<void> => {
    marks.push([shot, (Date.now() - t0) / 1000]);
    await page.evaluate(() => {
      const strip = document.createElement('div');
      strip.dataset.takeMark = '';
      strip.style.cssText =
        'position:fixed;inset:0 0 auto 0;height:8px;background:#ff00ff;z-index:2147483647';
      document.documentElement.appendChild(strip);
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelector('[data-take-mark]')?.remove());
    shotStart = Date.now();
    await page.waitForTimeout(150);
  };
  const at = async (sec: number): Promise<void> => {
    const left = shotStart + sec * 1000 - Date.now();
    if (left > 0) await page.waitForTimeout(left);
  };
  return { mark, at, marks };
}

/** closes the page and copies its video to `LIVE_TAKE` (+ `<take>.marks.json` when marks exist) */
export async function saveTake(
  page: Page,
  testInfo: TestInfo,
  marks: [string, number][] = [],
): Promise<void> {
  const take = process.env.LIVE_TAKE;
  const video = page.video();
  if (!take || !video) return;
  await page.close();
  const out = path.resolve(take);
  mkdirSync(path.dirname(out), { recursive: true });
  copyFileSync(await video.path(), out);
  if (marks.length > 0) writeFileSync(`${out}.marks.json`, `${JSON.stringify(marks)}\n`);
  testInfo.annotations.push({ type: 'take', description: out });
}

/**
 * waits until the page shows settled content: the main heading is visible, web fonts are loaded
 * and every finite entrance animation has finished (headless Chromium can paint the first page
 * after a fresh load seconds late, so a fixed delay after `goto` may still show a blank page)
 */
export async function settled(page: Page, extraMs = 400): Promise<void> {
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity,
        ),
    undefined,
    { timeout: 15_000, polling: 100 },
  );
  // two animation frames: the settled state has been painted, not only computed
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  await page.waitForTimeout(extraMs);
}

/**
 * loads the UI once in a separate, unrecorded browser context, so the recorded page's first load
 * paints at once (a fresh headless browser can paint its first page seconds late). The recorded
 * page stays blank meanwhile; `scripts/cut-takes.sh` trims leading blank frames from every take.
 */
export async function warmUp(browser: Browser, baseURL: string): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(baseURL);
  await settled(p);
  await ctx.close();
}
