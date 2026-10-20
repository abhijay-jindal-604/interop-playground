/**
 * Live-region helper (06 UI-78). Exactly two regions, mounted once by the app shell:
 * `#live-polite` and `#live-assertive`. `announce()` clears the region, waits 50 ms, then sets
 * the text (so a repeat is read again) and keeps at most one polite message per 1.5 s: later polite
 * messages inside the window replace the pending one; assertive messages are never dropped.
 */
export type Politeness = 'polite' | 'assertive';

export const ANNOUNCE_DELAY_MS = 50;
export const POLITE_WINDOW_MS = 1_500;

let lastPoliteAt = Number.NEGATIVE_INFINITY;
let pendingPolite: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;

function region(kind: Politeness): HTMLElement | null {
  return document.getElementById(kind === 'polite' ? 'live-polite' : 'live-assertive');
}

function write(kind: Politeness, text: string): void {
  const el = region(kind);
  if (!el) return;
  el.textContent = '';
  setTimeout(() => {
    el.textContent = text;
  }, ANNOUNCE_DELAY_MS);
}

/** Sends a message to the screen-reader live region (polite by default, assertive for errors). */
export function announce(text: string, kind: Politeness = 'polite'): void {
  if (kind === 'assertive') {
    write('assertive', text);
    return;
  }
  const now = Date.now();
  const wait = lastPoliteAt + POLITE_WINDOW_MS - now;
  if (wait <= 0 && !pendingPolite) {
    lastPoliteAt = now;
    write('polite', text);
    return;
  }
  if (pendingPolite) {
    pendingPolite.text = text; // the last one wins
    return;
  }
  const pending = {
    text,
    timer: setTimeout(
      () => {
        lastPoliteAt = Date.now();
        pendingPolite = null;
        write('polite', pending.text);
      },
      Math.max(wait, 0),
    ),
  };
  pendingPolite = pending;
}

/** Test hook: forget the throttle window. */
export function resetAnnouncer(): void {
  if (pendingPolite) clearTimeout(pendingPolite.timer);
  pendingPolite = null;
  lastPoliteAt = Number.NEGATIVE_INFINITY;
}
