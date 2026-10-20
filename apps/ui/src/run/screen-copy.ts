/**
 * Words added with the run-screen visual upgrade (ADR-119). Kept beside the run screen so the
 * existing copy keys in copy.ts stay untouched; they can be folded into copy.ts later unchanged.
 */
export const screenCopy = {
  decoded: {
    copyPayload: 'Copy payload',
    disclosures: (n: number) => `${n} disclosed claim${n === 1 ? '' : 's'}`,
  },
  fix: {
    oneChange: 'One setting changes',
    from: 'Now',
    to: 'Re-run with',
  },
  strip: {
    flipped: 'Outcome flipped',
  },
} as const;
