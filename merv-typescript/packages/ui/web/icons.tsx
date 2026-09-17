/**
 * The rail's glyphs: one thin monochrome line per destination, drawn on the same
 * 24-unit grid at 16px with a 1.5px stroke. They are keyed by view kind (plus the
 * shell's own `home` and `now`), so a row registered by a plugin is recognised by
 * the same name the KIND table uses. The emoji in that table stay where they are:
 * they name kinds on pages, these name places in the rail.
 */
const PATHS: Record<string, string> = {
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  now: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 7.5V12l3 2',
  claims: 'M9.5 18.5h5M10.5 21h3M12 3a6 6 0 0 0-3.5 10.9v2.1h7v-2.1A6 6 0 0 0 12 3',
  paper: 'M13 3H6.5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8zM13 3v5h5.5',
  work: 'M8.5 12.5 11 15l4.5-4.5M5.5 4h13a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
  reflections:
    'M7.5 3h9a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1M9.5 7.5l5 5M9.5 12l2.5 2.5',
  sessions:
    'M9 3.5v2M15 3.5v2M6.5 5.5h11a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18V7a1.5 1.5 0 0 1 1.5-1.5M9.5 10.5h.01M14.5 10.5h.01M9.5 15h5',
  code: 'm9 8.5-4 3.5 4 3.5M15 8.5l4 3.5-4 3.5',
  artifacts:
    'M16.8 7.6 9.4 15a2.5 2.5 0 0 0 3.5 3.5l7.4-7.4a4.5 4.5 0 0 0-6.4-6.4l-7.4 7.4a6.5 6.5 0 0 0 9.2 9.2l4-4',
  feed: 'M4.5 6.5A1.5 1.5 0 0 1 6 5h12a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 16H9l-4.5 3.5zM8 9h8M8 12.5h5',
  'legacy-history': 'M4 5h16v3.5H4zM5.5 8.5V19a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8.5M10 12.5h4',
  settings: 'M4 7.5h8M16 7.5h4M4 16.5h4M12 16.5h8M14 5v5M10 14v5',
  fallback: 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15',
};

/** One glyph, named by view kind; a kind with no glyph gets the neutral circle. */
export const RowIcon = ({ name }: { name: string }) => (
  <svg
    className="rail-icon"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={PATHS[name] ?? PATHS.fallback} />
  </svg>
);
