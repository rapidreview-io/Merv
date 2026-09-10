/**
 * Inline SVG nav/glyph icons — replace the Unicode symbols (◉ ⚗ ≋ ⋯) that
 * render inconsistently across Android/iOS system fonts. Stroke uses
 * currentColor so the active-tab color flows through unchanged.
 */
const base = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export function IconHome(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 11.5 12 5l8 6.5" />
      <path d="M6 10v9h12v-9" />
    </svg>
  );
}

export function IconFeed(props) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M7 9h6" />
      <path d="M7 12.5h10" />
      <path d="M7 16h10" />
    </svg>
  );
}

export function IconExperiments(props) {
  return (
    <svg {...base} {...props}>
      <path d="M9 3h6" />
      <path d="M10 3v6.5L5.5 17.5A2 2 0 0 0 7.3 20.5h9.4a2 2 0 0 0 1.8-3L14 9.5V3" />
      <path d="M8 15h8" />
    </svg>
  );
}

export function IconActivity(props) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h3l2.5-7 4 14 2.5-9 2 2H21" />
    </svg>
  );
}

export function IconMore(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
