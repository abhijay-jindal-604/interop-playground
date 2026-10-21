/**
 * `Stamp` (ADR-134): the verdict stamp, the one decorative element of the "Document" direction. A
 * double-ruled rectangle in the status colour with the outcome word in serif capitals (the capitals
 * come from CSS, so assistive technology reads a normal word), turned -3 degrees and pressed once
 * on reveal. `small` is the flat row version for tables (History, Matrix, Report steps). The shared
 * `.stamp` rules in `styles.css` own the look; this module decides the word, status and second line.
 */
import type { RunVerdict } from '@interop-playground/api';
import { runCopy } from '../copy.js';

export type StampStatus = 'pass' | 'fail' | 'expired' | 'warn' | 'neutral' | 'skipped';
/** a stamp word key; its text lives in `runCopy.stamp` */
export type StampWord = keyof typeof runCopy.stamp;

type VerdictLike = Pick<RunVerdict, 'outcome' | 'verification'>;

const isStampWord = (w: string): w is StampWord => Object.hasOwn(runCopy.stamp, w);

/** The stamp of a verdict: Valid / Invalid / Expired for verifications, Issued for issuance, else the outcome. */
export function stampOf(
  v: VerdictLike | null | undefined,
): { word: StampWord; status: StampStatus } | null {
  if (!v) return null;
  switch (v.outcome) {
    case 'pass':
      if (v.verification === 'valid-but-expired') return { word: 'expired', status: 'expired' };
      if (v.verification === 'valid') return { word: 'valid', status: 'pass' };
      if (v.verification === null) return { word: 'issued', status: 'pass' };
      return { word: 'pass', status: 'pass' };
    case 'fail':
      return v.verification === 'invalid'
        ? { word: 'invalid', status: 'fail' }
        : { word: 'fail', status: 'fail' };
    case 'blocked':
      return { word: 'blocked', status: 'fail' };
    case 'inconclusive':
      return { word: 'inconclusive', status: 'warn' };
    case 'lenient':
      return { word: 'lenient', status: 'neutral' };
    case 'no-submission':
      return { word: 'no-submission', status: 'neutral' };
    default:
      return null;
  }
}

/**
 * `stampOf` for loose outcome strings (reports, history rows); an unknown or missing outcome gets a
 * grey "Not run" stamp.
 */
export function stampFor(
  outcome: string | null | undefined,
  verification?: string | null,
): { word: string; status: StampStatus } {
  const s = outcome
    ? stampOf({
        outcome: outcome as VerdictLike['outcome'],
        verification: (verification ?? null) as VerdictLike['verification'],
      })
    : null;
  return s ?? { word: 'Not run', status: 'skipped' };
}

/** "21 Oct 2026" in UTC, so a stamp reads the same on every machine */
export function stampDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** One stamp. `small` (or `size="sm"`) is the unrotated row version; `line` is the date and who decided. */
export function Stamp({
  word,
  status,
  line,
  small = false,
  size,
  press = true,
  className,
}: {
  /** a `runCopy.stamp` key ("valid"), or a ready display word in sentence case */
  word: string;
  status: StampStatus;
  /** small second line, e.g. "21 Oct 2026 · Inji Verify"; not shown on the small stamp */
  line?: string | null;
  small?: boolean;
  size?: 'sm' | 'md';
  /** play the press once when it first renders (off under reduced motion via CSS) */
  press?: boolean;
  className?: string;
}) {
  const isSmall = small || size === 'sm';
  const key = isStampWord(word) ? word : word.toLowerCase();
  const text = isStampWord(word) ? runCopy.stamp[word] : word;
  const cls = ['stamp', isSmall ? 'stamp-sm' : press ? 'stamp-press' : null, className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} data-status={status} data-stamp={key} data-testid="stamp">
      <span className="stamp-word">{text}</span>
      {line && !isSmall ? <span className="stamp-line">{line}</span> : null}
    </span>
  );
}
