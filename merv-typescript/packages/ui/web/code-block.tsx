import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { parseAnsi } from './ansi';
import { CopyButton } from './components';
import {
  highlight,
  highlightable,
  highlightNow,
  languageOf,
  type Language,
  type Piece,
} from './highlight';
import { WrapIcon } from './icons';

/**
 * Code as it is read here, wherever it stands: a fence in a document, a file, a
 * check's output. A quiet head names the language and offers the two moves code
 * needs, to wrap its long lines and to copy it; the body is the text as written,
 * drawn plain at once and coloured once its grammar loads (highlight.ts); text in
 * no language it knows is read as a terminal's, coloured by its own escapes (ansi.ts).
 * Line numbers are drawn by the stylesheet beside each line, never inside it, so
 * whatever a reader selects and copies is the code alone.
 */

/** A styled stretch as an element, and a plain one as its text. */
const pieceOf = (piece: Piece, key: number): ReactNode =>
  piece.className || piece.style ? (
    <span key={key} className={piece.className} style={piece.style as CSSProperties}>
      {piece.content}
    </span>
  ) : (
    piece.content
  );
/** One line's pieces as elements: what a highlighter's tokens become, never HTML. */
export const lineElements = (line: Piece[]): ReactNode[] => line.map(pieceOf);

/** Pieces of one text, cut at its newlines into lines. */
function linesOf(pieces: Piece[]): Piece[][] {
  const lines: Piece[][] = [[]];
  for (const piece of pieces)
    piece.content.split('\n').forEach((part, at) => {
      if (at) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ ...piece, content: part });
    });
  return lines;
}

/** A terminal's text as styled spans, escapes gone: for output that needs no head of its own. */
export const AnsiText = ({ text }: { text: string }) => (
  <>
    {parseAnsi(text).map((run, key) =>
      pieceOf({ content: run.text, className: run.className }, key),
    )}
  </>
);

/** How long text must stand unchanged before it is coloured again: a block streaming in is not. */
const STILL_MS = 300;

/**
 * The lines of `code` coloured: as first drawn where the highlighter already holds
 * its grammar, otherwise once that loads. Text that then changes, a block still
 * streaming in, is coloured again only once it has stood still a moment, never with
 * every piece that arrives. Until then, and for a language it does not know, there
 * is nothing, and the code is drawn plain.
 */
export function useHighlight(code: string, language: Language | undefined) {
  const [drawn] = useState(() => ({ code, language, lines: highlightNow(code, language) }));
  const [later, setLater] = useState<{ code: string; language: Language; lines: Piece[][] }>();
  const first = drawn.code === code && drawn.language === language;
  const now = first ? drawn.lines : undefined;
  useEffect(() => {
    if (now || !language || !highlightable(code)) return;
    let live = true;
    const still = setTimeout(
      () =>
        void highlight(code, language, () => live).then((lines) => {
          if (live && lines) setLater({ code, language, lines });
        }),
      first ? 0 : STILL_MS,
    );
    return () => {
      live = false;
      clearTimeout(still);
    };
  }, [code, language, now, first]);
  return now ?? (later?.code === code && later.language === language ? later.lines : undefined);
}

/** The head every block of code wears: what it is, any move of its own, and copy. */
export function CodeHead({
  label,
  copy,
  children,
}: {
  label: string;
  copy: string;
  children?: ReactNode;
}) {
  return (
    <div className="code-head">
      <span className="code-lang">{label}</span>
      <span className="code-tools">
        {children}
        <CopyButton text={copy} label="Copy" />
      </span>
    </div>
  );
}

/** A fence is numbered once it is longer than a glance. */
export const NUMBERED_FROM = 10;

export function CodeBlock({
  code,
  lang,
  label,
  numbered = false,
}: {
  code: string;
  /** A fence's info word or a file's name: what the code is written in, where it says. */
  lang?: string;
  /** What the head calls it where the language does not: output, a log. */
  label?: string;
  numbered?: boolean;
}) {
  const [wrap, setWrap] = useState(false);
  const language = languageOf(lang);
  // A trailing newline ends the last line rather than opening another.
  const body = code.endsWith('\n') ? code.slice(0, -1) : code;
  const coloured = useHighlight(body, language);
  // Text in no language this page colours is read as a terminal's: its escapes colour it.
  const runs = useMemo(() => (language ? undefined : parseAnsi(body)), [language, body]);
  const plain = useMemo(() => runs?.map((run) => run.text).join('') ?? code, [runs, code]);
  // Past the highlighter's limits a text is one run, not a span a line.
  const lined = useMemo(() => highlightable(body), [body]);
  const lines = useMemo(
    () =>
      lined
        ? (coloured ??
          linesOf(
            runs?.map((run) => ({ content: run.text, className: run.className })) ?? [
              { content: body },
            ],
          ))
        : undefined,
    [lined, coloured, runs, body],
  );
  const diff = language?.id === 'diff';
  const tint = (line: Piece[]) => {
    const first = line[0]?.content ?? '';
    if (!diff || /^(\+\+\+|---)( |$)/.test(first)) return '';
    return first.startsWith('+')
      ? ' code-line--add'
      : first.startsWith('-')
        ? ' code-line--del'
        : '';
  };
  const gutter = numbered && lines ? String(lines.length).length : 0;
  return (
    <div
      className={`code-block${wrap ? ' code-block--wrap' : ''}${gutter ? ' code-block--numbered' : ''}`}
    >
      <CodeHead label={language?.label ?? label ?? (lang?.trim() || 'Text')} copy={plain}>
        <button
          type="button"
          className="btn-icon btn-icon--inline"
          aria-pressed={wrap}
          aria-label="Wrap long lines"
          title="Wrap long lines"
          onClick={() => setWrap(!wrap)}
        >
          <WrapIcon size={14} />
        </button>
      </CodeHead>
      <pre
        className="code-body"
        style={gutter ? ({ '--gutter': `${gutter}ch` } as CSSProperties) : undefined}
      >
        <code>
          {lines
            ? lines.map((line, at) => (
                <Fragment key={at}>
                  {at > 0 && '\n'}
                  <span className={`code-line${tint(line)}`}>{lineElements(line)}</span>
                </Fragment>
              ))
            : (runs?.map((run, key) =>
                pieceOf({ content: run.text, className: run.className }, key),
              ) ?? body)}
        </code>
      </pre>
    </div>
  );
}
