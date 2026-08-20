/**
 * InlineMd — technical inline text for one-line fields (a deliverable, a
 * confirmation, the goal prose). Two layers:
 *
 *   1. the inline markdown subset — `code`, **bold**, *emphasis* — honoured
 *      when the author wrote it;
 *   2. auto-recognition of the technical tokens this prose is full of even
 *      when nobody backticked them: shell commands with their arguments,
 *      call-like spans (Transformer(d_model=32)), file paths and filenames,
 *      snake_case identifiers (train_acc, d_model), name=value pairs.
 *
 * Recognized spans render as the app's code chips (.md-inline-code), so a
 * scanning eye separates artifacts and commands from the prose around them.
 * No paragraphs, no links, no HTML — text stays text.
 */

// Layer 1: explicit markdown tokens.
const MD_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;

// Layer 2: auto tokens inside plain segments, longest-match-first.
const CODE_EXT = 'py|md|json|npz|npy|csv|tsv|txt|yaml|yml|toml|sh|bash|sql|parquet|png|svg|pdf|ipynb|js|jsx|ts|tsx|css|html|lock|env';
const AUTO_RE = new RegExp(
  [
    // a command verb with at least one path/flag/quoted argument
    `(?:\\b(?:python3?|pytest|pip3?|uv|bash|sh|zsh|git|npm|npx|pnpm|node|make|cargo|go|ls|cat|grep|curl|wget|docker|kubectl|psql|sqlite3)(?:\\s+(?:-{1,2}[\\w=:.-]+|"[^"]*"|'[^']*'|[\\w@~.-]*\\/[\\w@~./-]+|[\\w-]+\\.(?:${CODE_EXT})\\b|-c))+)`,
    // call-like span: Name(args) with no space before the paren
    '(?:\\b[A-Za-z_][\\w.]*\\([^()\\n]*\\))',
    // a path containing a slash — the first segment must carry a letter and
    // the whole match a dot, so bare fractions (9409/9409) and slashed word
    // pairs in prose (model/evaluation, train/val/test) stay prose
    '(?:(?<![\\w/])(?=[\\w.-]*[A-Za-z])(?=(?:[\\w.-]+\\/)*[\\w-]*\\.[\\w.-]*)[\\w.-]+(?:\\/[\\w.-]+)+)',
    // a bare filename with a code extension
    `(?:\\b[\\w-]+\\.(?:${CODE_EXT})\\b)`,
    // name=value
    "(?:\\b[\\w.]+=[\\w.'\"-]+)",
    // snake_case identifier (two or more parts — prose never has these)
    '(?:\\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\\b)',
  ].join('|'),
  'g',
);

function autoSpans(text, keyBase) {
  const out = [];
  let cursor = 0;
  for (const match of text.matchAll(AUTO_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) out.push(<span key={`${keyBase}t${cursor}`}>{text.slice(cursor, start)}</span>);
    out.push(<code key={`${keyBase}c${start}`} className="md-inline-code">{match[0]}</code>);
    cursor = start + match[0].length;
  }
  if (cursor < text.length) out.push(<span key={`${keyBase}t${cursor}`}>{text.slice(cursor)}</span>);
  return out;
}

export default function InlineMd({ text, className, auto = true }) {
  const src = String(text ?? '');
  if (!src) return null;
  const parts = src.split(MD_RE);
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (!part) return null;
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return <code key={i} className="md-inline-code">{part.slice(1, -1)}</code>;
        }
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        return auto ? autoSpans(part, i) : <span key={i}>{part}</span>;
      })}
    </span>
  );
}
