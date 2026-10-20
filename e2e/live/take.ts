/**
 * Live e2e helpers for the video takes (plan/13 §2.1 recording rules): the advertised host
 * (`PUBLIC_HOST`, a LAN IP) is masked in every text node and attribute shown on screen, the QR
 * module pattern is blurred (it encodes the response URI with that host), and the page video is
 * copied to `LIVE_TAKE` when set. Shot marks (`mark`) give the cut points of a multi-shot take.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

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

/** seconds since the page opened, for the shot list of a multi-shot take */
export function marker(): { mark: (shot: string) => void; marks: [string, number][] } {
  const t0 = Date.now();
  const marks: [string, number][] = [];
  return { mark: (shot) => marks.push([shot, (Date.now() - t0) / 1000]), marks };
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
