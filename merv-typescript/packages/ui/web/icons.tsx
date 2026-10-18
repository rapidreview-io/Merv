/**
 * Every glyph the UI draws: one thin monochrome line on the same 24-unit grid,
 * at 16px with a 1.5-unit stroke, taking the colour of the text it sits in. The
 * first group names places and is keyed by view kind (plus the shell's own
 * `home` and `work`), so a row registered by a plugin is recognised by the
 * same name the KIND table uses; the rail and an empty list draw from it. The
 * second group is what a control says instead of a word, and the third is what
 * a file is before anyone opens it.
 */
const PATHS = {
  home: 'M4.5 10.5 12 4.5l7.5 6V19a1 1 0 0 1-1 1h-4v-5.5h-5V20h-4a1 1 0 0 1-1-1z',
  paper:
    'M11.5 4.5H6A1.5 1.5 0 0 0 4.5 6v13A1.5 1.5 0 0 0 6 20.5h11a1.5 1.5 0 0 0 1.5-1.5v-5M8 9h3M8 13h2M12 14l.8-3.8 6.5-6.5a1.4 1.4 0 0 1 2 2l-6.5 6.5zM17.5 5.5l2 2',
  work: 'M4 6.5l1.5 1.5 3-3M11 6.5h9M4 12.5l1.5 1.5 3-3M11 12.5h9M5.5 18.5h.01M11 18.5h9',
  reflections: 'M7.5 7.5H4v-3M4.3 7.5a8 8 0 1 1-.3 8M12 7.5V12l3 2',
  sessions:
    'M9 3.5v2M15 3.5v2M6.5 5.5h11a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18V7a1.5 1.5 0 0 1 1.5-1.5M9.5 10.5h.01M14.5 10.5h.01M9.5 15h5',
  code: 'm9 8.5-4 3.5 4 3.5M15 8.5l4 3.5-4 3.5',
  chip: 'M7.5 5.5h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM9.5 9.5h5v5h-5zM9 3v2.5M15 3v2.5M9 18.5V21M15 18.5V21M3 9h2.5M3 15h2.5M18.5 9H21M18.5 15H21',
  machines:
    'M6 4.5h12A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V6A1.5 1.5 0 0 1 6 4.5zM4.5 12h15M8 8h.01M11.5 8H16M8 16h.01M11.5 16H16',
  jobs: 'M5 4.5h14A1.5 1.5 0 0 1 20.5 6v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5zM7 9l3 3-3 3M13 15h4',
  spend:
    'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M15 8.5h-4.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H9M12 6.5v12',
  artifacts:
    'M3.5 8V6a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8A1.5 1.5 0 0 1 20.5 8M3.5 10h17l-1.7 8.3a1.5 1.5 0 0 1-1.5 1.2H6.7a1.5 1.5 0 0 1-1.5-1.2z',
  feed: 'M8.5 5.5H20M8.5 12H18M8.5 18.5H20M4 5.5h.01M4 12h.01M4 18.5h.01',
  'legacy-history':
    'M4 4.5h16V8H4zM5.5 8v10.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V8M9 11.5h6M9 15h4',
  settings: 'M4 7h3M11 7h9M4 17h9M17 17h3M7 4.5h4v5H7zM13 14.5h4v5h-4z',
  people:
    'M9 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6M3.5 19.5V18a5.5 5.5 0 0 1 11 0v1.5M16 4.5a3 3 0 0 1 0 6M17.5 13a4.5 4.5 0 0 1 3 4.2v2.3',
  connections: 'M9 8H6a4 4 0 0 0 0 8h3M15 8h3a4 4 0 0 1 0 8h-3M8 12h8',
  boards: 'M4.5 5h3v14h-3zM10.5 5h3v8h-3zM16.5 5h3v11h-3z',
  pi: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M9 10h.01M15 10h.01M8.5 14.25a4.25 4.25 0 0 0 7 0',
  fallback: 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15',

  edit: 'M4.5 19.5l1-4.2L16.6 4.2a1.7 1.7 0 0 1 2.4 0l.8.8a1.7 1.7 0 0 1 0 2.4L8.7 18.5zM14.5 6.3l3.2 3.2',
  plus: 'M12 5.5v13M5.5 12h13',
  chat: 'M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5.5 4V7A1.5 1.5 0 0 1 5 5.5zM8 10h8M8 13.5h5',
  pause: 'M8 6v12M16 6v12',
  play: 'm8 5 11 7-11 7z',
  close: 'm6.5 6.5 11 11M17.5 6.5l-11 11',
  expand: 'M14 4.5h5.5V10M19.5 4.5l-6 6M10 19.5H4.5V14M4.5 19.5l6-6',
  restore: 'M19.5 10H14V4.5M14 10l6-6M4.5 14H10v5.5M10 14l-6 6',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  'chevron-right': 'm9.5 6 6 6-6 6',
  'chevron-left': 'm14.5 6-6 6 6 6',
  chevrons: 'm8 9.5 4-4 4 4M8 14.5l4 4 4-4',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M16 16l4 4',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  upload:
    'M12 15.5v-11M7.5 9 12 4.5 16.5 9M4.5 14.5v4a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-4',
  external:
    'M14 4.5h5.5V10M19.5 4.5l-8 8M10 6.5H6A1.5 1.5 0 0 0 4.5 8v10A1.5 1.5 0 0 0 6 19.5h10a1.5 1.5 0 0 0 1.5-1.5v-4',
  link: 'M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  copy: 'M9.5 8.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1M15.5 8.5v-3a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3',
  source: 'm8.5 8.5-4 3.5 4 3.5M15.5 8.5l4 3.5-4 3.5M13.5 5.5l-3 13',
  alert: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 8v4.5M12 15.5h.01',
  key: 'M8 12.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7M10.5 13.5l9-9M16.5 7.5 19 10M14 10l2 2',
  sidebar:
    'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2M9.5 4.5v15',
  wrap: 'M4.5 6.5h15M4.5 12h12a3 3 0 0 1 0 6H12M14 16l-2 2 2 2M4.5 17.5h4',

  folder: 'M3.5 6.5a1 1 0 0 1 1-1h4.6l2 2h8.4a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z',
  file: 'M13 3H6.5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8zM13 3v5h5.5',
  'file-text':
    'M13 3H6.5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8zM13 3v5h5.5M8.5 12.5h7M8.5 16h5',
  'file-code':
    'M13 3H6.5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8zM13 3v5h5.5M10.5 12l-2 2.25 2 2.25M13.5 12l2 2.25-2 2.25',
  'file-data':
    'M13 3H6.5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8zM13 3v5h5.5M8.5 11.5h7v6h-7zM8.5 14.5h7M12 11.5v6',
  'file-image':
    'M13 3H6.5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8zM13 3v5h5.5M8 17.5l2.6-3 1.9 2 1.4-1.4 2.1 2.4M10 11.5h.01',
} satisfies Record<string, string>;

export type IconName = keyof typeof PATHS;
const known = (name: string): name is IconName => Object.hasOwn(PATHS, name);

interface IconProps {
  /** The drawn size in px; the stroke scales with it. */
  size?: number;
  className?: string;
}

/**
 * One glyph by name. A name this build has no glyph for — a view kind a service
 * outside this process published — gets the neutral circle. It is decoration
 * beside a word, or the face of a control that carries its own aria-label, so it
 * is always hidden from the accessibility tree.
 */
export const Icon = ({ name, size = 16, className }: IconProps & { name: string }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={PATHS[known(name) ? name : 'fallback']} />
  </svg>
);

const CODE =
  /\.(m?[jt]sx?|py|rs|go|java|kt|swift|rb|php|c|h|cc|cpp|hpp|cs|sh|bash|zsh|sql|css|html?|xml|toml|ya?ml|ipynb|diff|patch)$/i;
const DATA = /\.(csv|tsv|jsonl?|ndjson|parquet|xlsx?|arrow|npy|npz)$/i;
const TEXT = /\.(md|markdown|mdx|txt|rst|tex|pdf|docx?|log)$/i;
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|tiff?)$/i;

/**
 * Which glyph a file wears, read from the media type it was retained with and,
 * where that says nothing of the kind (`text/plain`, `application/octet-stream`,
 * or nothing at all), from the end of its name. What neither names is a plain file.
 */
export function fileIcon(mediaType?: string | null, name?: string | null): IconName {
  const type = (mediaType ?? '').toLowerCase().split(';')[0]!.trim();
  if (type.startsWith('image/')) return 'file-image';
  if (/csv|tab-separated|json|parquet|spreadsheet|excel|arrow/.test(type)) return 'file-data';
  if (/markdown|pdf|msword|wordprocessing|rtf/.test(type)) return 'file-text';
  if (
    /javascript|typescript|python|x-sh|shellscript|sql|css|html|xml|yaml|toml|diff|patch/.test(type)
  )
    return 'file-code';
  const file = name ?? '';
  if (IMAGE.test(file)) return 'file-image';
  if (DATA.test(file)) return 'file-data';
  if (CODE.test(file)) return 'file-code';
  if (TEXT.test(file) || type.startsWith('text/')) return 'file-text';
  return 'file';
}
