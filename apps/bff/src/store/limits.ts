/**
 * Size limits of 05 §5 (ADR-37: one body-cap rule) and the pure helpers that apply them.
 * Every limit is enforced in the sink and has a unit test (limits.test.ts, sink.test.ts).
 */
const KiB = 1024;
const MiB = 1024 * KiB;

export const LIMITS = {
  /** stored body cap: first 256 KiB kept, `truncated`, original size + full-body SHA-256 kept */
  bodyBytes: 256 * KiB,
  /** inline body in an SSE / replay event (wire only) */
  wireInlineBytes: 64 * KiB,
  headerValueChars: 8 * KiB,
  headersTotalChars: 32 * KiB,
  urlChars: 8 * KiB,
  /** event payload JSON excluding blobs */
  payloadJsonChars: 64 * KiB,
  /** `engine.call` input/output summaries (04 §7.3) */
  summaryJsonChars: 16 * KiB,
  checkMessageChars: 4 * KiB,
  artifactBytes: 1 * MiB,
  eventsPerRun: 4000,
  bodyBytesPerRun: 24 * MiB,
  runSpecJsonChars: 16 * KiB,
  /** gzip level 6 at or above this size, identity below (05 §4.3) */
  gzipFromBytes: 1 * KiB,
} as const;

export const ELLIPSIS = '…';
/** synthetic header that carries the full-body SHA-256 of a truncated body (05 §4.3) */
export const BODY_SHA_HEADER = 'x-playground-body-sha256';

/**
 * Truncates to at most `max` characters, ending with an ellipsis when something was cut.
 * Cut to at most `max` characters, the last one being `…`.
 */
export function cut(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + ELLIPSIS;
}

export type HeaderList = [name: string, value: string][];

/** names lowercased, each value ≤ 8 KiB, total (JSON) ≤ 32 KiB, longer values cut with `…` (05 §4.3) */
export function capHeaders(headers: HeaderList): HeaderList {
  const out: HeaderList = [];
  let total = 2; // "[]"
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase();
    let value = cut(rawValue, LIMITS.headerValueChars);
    const overhead = JSON.stringify([name, '']).length + 1;
    const room = LIMITS.headersTotalChars - total - overhead;
    if (room <= 1) {
      value = ELLIPSIS;
    } else if (JSON.stringify(value).length - 2 > room) {
      value = cut(value, Math.max(1, room - 8));
    }
    const len = JSON.stringify([name, value]).length + 1;
    if (total + len > LIMITS.headersTotalChars) break;
    total += len;
    out.push([name, value]);
  }
  return out;
}

/** Caps a URL to the stored length limit. */
export function capUrl(url: string): string {
  return cut(url, LIMITS.urlChars);
}

/** replaces a JSON summary longer than 16 KiB by its first 16 KiB of JSON text (04 §7.3) */
export function capSummary(v: unknown): unknown {
  if (v === undefined) return null;
  const text = JSON.stringify(v) ?? 'null';
  return text.length <= LIMITS.summaryJsonChars ? v : cut(text, LIMITS.summaryJsonChars);
}

/**
 * Payload JSON (blobs already replaced by refs) over 64 KiB: the longest string fields are cut
 * until it fits and `truncated: true` is set (05 §5).
 */
export function capPayload(payload: Record<string, unknown>): Record<string, unknown> {
  let text = JSON.stringify(payload);
  if (text.length <= LIMITS.payloadJsonChars) return payload;
  const copy = structuredClone(payload);
  copy.truncated = true;
  for (let guard = 0; guard < 10_000; guard++) {
    text = JSON.stringify(copy);
    const excess = text.length - LIMITS.payloadJsonChars;
    if (excess <= 0) break;
    const leaf = longestString(copy);
    if (!leaf || leaf.value.length <= 64) break;
    const target = Math.max(64, leaf.value.length - excess - 16);
    leaf.set(cut(leaf.value, target));
  }
  return copy;
}

function longestString(root: unknown): { value: string; set: (s: string) => void } | null {
  let best: { value: string; set: (s: string) => void } | null = null;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (typeof v === 'string') {
          if (!best || v.length > best.value.length) best = { value: v, set: (s) => (node[i] = s) };
        } else visit(v);
      });
    } else if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (k === '$blob') continue;
        if (typeof v === 'string') {
          if (!best || v.length > best.value.length) best = { value: v, set: (s) => (obj[k] = s) };
        } else visit(v);
      }
    }
  };
  visit(root);
  return best;
}

/**
 * True for content types whose bodies are stored as UTF-8 text; a missing type is treated as text.
 * Textual content types are stored and shown as UTF-8, everything else as base64 (05 §4.3)
 */
export function isTextual(contentType: string | null | undefined): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    /json|xml|javascript|x-www-form-urlencoded|jwt|yaml|html|sd-jwt|ecmascript/.test(ct)
  );
}
