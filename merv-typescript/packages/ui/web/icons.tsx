/**
 * Every glyph the UI draws: one thin monochrome line on the same 24-unit grid,
 * at 16px with a 1.5px stroke, taking the colour of the text it sits in. The
 * first group names places and is keyed by view kind (plus the shell's own
 * `home`, `now` and `work`), so a row registered by a plugin is recognised by the
 * same name the KIND table uses; the rail and an empty list draw from it. The
 * second group is what a control says instead of a word, and the third is what
 * a file is before anyone opens it.
 */
const PATHS = {
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  now: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 7.5V12l3 2',
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
  people:
    'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M3.5 19c0-3 2.4-5 5.5-5s5.5 2 5.5 5M16 11a2.5 2.5 0 1 0 0-5M17 14.3c2.1.5 3.5 2.3 3.5 4.7',
  connections: 'M9 3.5v4M15 3.5v4M6.5 7.5h11v4a5.5 5.5 0 0 1-11 0zM12 17v3.5',
  fallback: 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15',

  edit: 'M4.5 19.5l1-4.2L16.6 4.2a1.7 1.7 0 0 1 2.4 0l.8.8a1.7 1.7 0 0 1 0 2.4L8.7 18.5zM14.5 6.3l3.2 3.2',
  plus: 'M12 5.5v13M5.5 12h13',
  close: 'm6.5 6.5 11 11M17.5 6.5l-11 11',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  'chevron-right': 'm9.5 6 6 6-6 6',
  'chevron-left': 'm14.5 6-6 6 6 6',
  chevrons: 'm8 9.5 4-4 4 4M8 14.5l4 4 4-4',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M16 16l4 4',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  external:
    'M14 4.5h5.5V10M19.5 4.5l-8 8M10 6.5H6A1.5 1.5 0 0 0 4.5 8v10A1.5 1.5 0 0 0 6 19.5h10a1.5 1.5 0 0 0 1.5-1.5v-4',
  link: 'M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  copy: 'M9.5 8.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1M15.5 8.5v-3a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3',
  source: 'm8.5 8.5-4 3.5 4 3.5M15.5 8.5l4 3.5-4 3.5M13.5 5.5l-3 13',
  alert: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 8v4.5M12 15.5h.01',
  key: 'M8 12.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7M10.5 13.5l9-9M16.5 7.5 19 10M14 10l2 2',
  sidebar:
    'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2M9.5 4.5v15',
  switch: 'M4 9h15l-4-4M20 15H5l4 4',
  upload: 'M12 15.5v-11M7.5 9 12 4.5 16.5 9M4.5 15v3.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V15',

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

export interface IconProps {
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

/** A place in the rail, named by view kind. */
export const RowIcon = ({ name }: { name: string }) => <Icon name={name} className="rail-icon" />;

/** The same glyphs by their own names, for a control that always draws the same one. */
const named = (name: IconName) => (props: IconProps) => <Icon name={name} {...props} />;
export const EditIcon = named('edit');
export const PlusIcon = named('plus');
export const CloseIcon = named('close');
export const CheckIcon = named('check');
export const ChevronRightIcon = named('chevron-right');
export const ChevronLeftIcon = named('chevron-left');
export const ChevronsIcon = named('chevrons');
export const ArrowRightIcon = named('arrow-right');
export const ExternalIcon = named('external');
export const CopyIcon = named('copy');
export const SourceIcon = named('source');
export const SidebarIcon = named('sidebar');
export const SwitchIcon = named('switch');
export const UploadIcon = named('upload');

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
