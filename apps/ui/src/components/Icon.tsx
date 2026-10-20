/**
 * The one inline SVG sprite (06 UI-75 Icons: 24 px grid, 2 px stroke, currentColor, no icon font,
 * no CDN) and the `Icon` that references it. Status silhouettes follow UI-74 and stay distinct in
 * greyscale: circle, square, octagon, ring, triangle, dashed ring, slashed circle, dotted circle.
 */
import type { ReactElement } from 'react';

const S = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;
/** marks drawn on top of a filled glyph use the page colour */
const ON = { ...S, stroke: 'var(--bg)' } as const;

const SYMBOLS: Record<string, ReactElement> = {
  // ----- navigation and chrome -----
  playground: (
    <g {...S}>
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="9.5" y="4" width="5" height="16" rx="1.5" />
      <rect x="16" y="4" width="5" height="16" rx="1.5" />
    </g>
  ),
  history: (
    <g {...S}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4.5l3 2" />
    </g>
  ),
  matrix: (
    <g {...S}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </g>
  ),
  tamper: (
    <g {...S}>
      <path d="M9 3h6" />
      <path d="M10 3v6.5L4.8 18.2A1.8 1.8 0 0 0 6.4 21h11.2a1.8 1.8 0 0 0 1.6-2.8L14 9.5V3" />
      <path d="M7.5 15h9" />
    </g>
  ),
  drafts: (
    <g {...S}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </g>
  ),
  environment: (
    <g {...S}>
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.5" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" />
      <path d="M7.5 7.25h.01M7.5 16.75h.01" />
    </g>
  ),
  runs: (
    <g {...S}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </g>
  ),
  menu: (
    <g {...S}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </g>
  ),
  close: (
    <g {...S}>
      <path d="M6 6l12 12M18 6L6 18" />
    </g>
  ),
  chevron: (
    <g {...S}>
      <path d="M9 6l6 6-6 6" />
    </g>
  ),
  sun: (
    <g {...S}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </g>
  ),
  moon: (
    <g {...S}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </g>
  ),
  system: (
    <g {...S}>
      <rect x="3" y="4" width="18" height="12.5" rx="1.5" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </g>
  ),
  keyboard: (
    <g {...S}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9" />
    </g>
  ),
  copy: (
    <g {...S}>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
    </g>
  ),
  refresh: (
    <g {...S}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4.5h-4.5" />
    </g>
  ),
  tunnel: (
    <g {...S}>
      <path d="M3 20V12a9 9 0 0 1 18 0v8" />
      <path d="M7.5 20v-7a4.5 4.5 0 0 1 9 0v7" />
    </g>
  ),
  qr: (
    <g {...S}>
      <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
      <rect x="14.5" y="3.5" width="6" height="6" rx="1" />
      <rect x="3.5" y="14.5" width="6" height="6" rx="1" />
      <path d="M14.5 14.5h2v2h-2zM18.5 18.5h2v2h-2zM14.5 20.5v-2M20.5 14.5h-2" />
    </g>
  ),
  // ----- status glyphs (UI-74) -----
  'st-pass': (
    <g>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="M7.5 12.4l3 3 6-6.3" {...ON} />
    </g>
  ),
  'st-fail': (
    <g>
      <rect x="2.5" y="2.5" width="19" height="19" rx="3" fill="currentColor" />
      <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" {...ON} />
    </g>
  ),
  'st-blocked': (
    <g>
      <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="currentColor" />
      <path d="M7 12h10" {...ON} />
    </g>
  ),
  'st-lenient': (
    <g {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 10h8M8 14h8" />
    </g>
  ),
  'st-inconclusive': (
    <g {...S}>
      <path d="M12 3L2.5 20h19z" />
      <path d="M10 11a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5" />
      <path d="M12 17.5h.01" />
    </g>
  ),
  'st-no-submission': (
    <g {...S}>
      <circle cx="12" cy="12" r="9" strokeDasharray="3.5 2.5" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </g>
  ),
  'st-n/a': (
    <g {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 18.4L18.4 5.6" />
    </g>
  ),
  'st-not-run': (
    <g {...S}>
      <circle cx="12" cy="12" r="9" strokeDasharray="0.1 3.6" strokeWidth="2.4" />
    </g>
  ),
  // run-level states (UI-74 rule f)
  'st-queued': (
    <g {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </g>
  ),
  'st-running': (
    <g {...S}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor" />
    </g>
  ),
  'st-cancelled': (
    <g {...S}>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="0.5" fill="currentColor" />
    </g>
  ),
  'st-failed': (
    <g {...S}>
      <path d="M12 3L2.5 20h19z" />
      <path d="M12 9.5v4.5M12 17.5h.01" />
    </g>
  ),
};

export type IconName = keyof typeof SYMBOLS;

/** Mounted once by the app shell. */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        {Object.entries(SYMBOLS).map(([name, body]) => (
          <symbol key={name} id={`i-${name}`} viewBox="0 0 24 24">
            {body}
          </symbol>
        ))}
      </defs>
    </svg>
  );
}

/** Renders one of the built-in SVG icons by name; hidden from assistive technology, so callers give the control its own text. */
export function Icon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#i-${name}`} />
    </svg>
  );
}

/** The brand mark: a signal tile with three joined parties, drawn on the ink chrome (ADR-117). */
export function BrandMark() {
  // three parties joined by one path (issuer, wallet, verifier) on the signal tile (ADR-117)
  return (
    <svg
      className="brand-mark"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0.5" y="0.5" width="23" height="23" rx="6.5" fill="var(--chrome-accent)" />
      <path
        d="M6 16.5 L12 7.5 L18 16.5"
        fill="none"
        stroke="var(--chrome-bg)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="16.5" r="2.4" fill="var(--chrome-bg)" />
      <circle cx="12" cy="7.5" r="2.4" fill="var(--chrome-bg)" />
      <circle
        cx="18"
        cy="16.5"
        r="2.4"
        fill="var(--chrome-accent)"
        stroke="var(--chrome-bg)"
        strokeWidth="1.8"
      />
    </svg>
  );
}
