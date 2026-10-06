import type { HighlighterCore, LanguageInput } from 'shiki/core';

/**
 * Colour for code, fetched only when code is shown. Shiki's core, its JavaScript
 * regex engine (no WebAssembly) and the two GitHub themes are one lazy chunk, and
 * each grammar is a chunk of its own, loaded the first time a block in that
 * language is drawn. What comes back is tokens, never HTML: each carries both
 * themes' colours as custom properties, and styles.css picks the one the page
 * wears, so a change of theme recolours code without reading it again.
 */

/** One stretch of a line in one style. */
export interface Piece {
  content: string;
  className?: string;
  /** Shiki's `--shiki-light`/`--shiki-dark` colours and font styles for this stretch. */
  style?: Record<string, string>;
}

type Load = () => Promise<{ default: LanguageInput }>;
/**
 * Every language this page colours: Shiki's id, the word a person reads, and the
 * names it is known by — a fence's info word, a file's extension or a whole file
 * name (`Dockerfile`) — all in one place.
 */
const LANGUAGES: [id: string, label: string, names: string, load: Load][] = [
  ['typescript', 'TypeScript', 'ts typescript mts cts', () => import('shiki/langs/typescript.mjs')],
  ['tsx', 'TSX', 'tsx', () => import('shiki/langs/tsx.mjs')],
  ['javascript', 'JavaScript', 'js javascript mjs cjs', () => import('shiki/langs/javascript.mjs')],
  ['jsx', 'JSX', 'jsx', () => import('shiki/langs/jsx.mjs')],
  ['json', 'JSON', 'json ipynb', () => import('shiki/langs/json.mjs')],
  ['jsonc', 'JSONC', 'jsonc json5', () => import('shiki/langs/jsonc.mjs')],
  ['python', 'Python', 'py python python3 py3 pyi', () => import('shiki/langs/python.mjs')],
  [
    'shellscript',
    'Shell',
    'sh bash shell zsh shellscript',
    () => import('shiki/langs/shellscript.mjs'),
  ],
  ['yaml', 'YAML', 'yaml yml', () => import('shiki/langs/yaml.mjs')],
  ['toml', 'TOML', 'toml', () => import('shiki/langs/toml.mjs')],
  ['sql', 'SQL', 'sql', () => import('shiki/langs/sql.mjs')],
  ['rust', 'Rust', 'rs rust', () => import('shiki/langs/rust.mjs')],
  ['go', 'Go', 'go golang', () => import('shiki/langs/go.mjs')],
  ['c', 'C', 'c h', () => import('shiki/langs/c.mjs')],
  ['cpp', 'C++', 'cpp c++ cc cxx hpp hh hxx', () => import('shiki/langs/cpp.mjs')],
  ['java', 'Java', 'java', () => import('shiki/langs/java.mjs')],
  ['r', 'R', 'r', () => import('shiki/langs/r.mjs')],
  ['julia', 'Julia', 'jl julia', () => import('shiki/langs/julia.mjs')],
  ['latex', 'LaTeX', 'latex tex sty cls', () => import('shiki/langs/latex.mjs')],
  ['html', 'HTML', 'html htm', () => import('shiki/langs/html.mjs')],
  ['css', 'CSS', 'css', () => import('shiki/langs/css.mjs')],
  ['xml', 'XML', 'xml svg xsd xsl', () => import('shiki/langs/xml.mjs')],
  ['diff', 'Diff', 'diff patch', () => import('shiki/langs/diff.mjs')],
  [
    'dockerfile',
    'Dockerfile',
    'dockerfile docker containerfile',
    () => import('shiki/langs/dockerfile.mjs'),
  ],
  ['makefile', 'Makefile', 'makefile make mk', () => import('shiki/langs/makefile.mjs')],
  ['markdown', 'Markdown', 'md markdown mdx', () => import('shiki/langs/markdown.mjs')],
  ['lean', 'Lean', 'lean lean4', () => import('shiki/langs/lean.mjs')],
];
export interface Language {
  id: string;
  label: string;
  load: Load;
}
const BY_NAME = new Map<string, Language>(
  LANGUAGES.flatMap(([id, label, names, load]) => {
    const language = { id, label, load };
    return names.split(' ').map((name) => [name, language] as const);
  }),
);

/**
 * The language a fence's info word or a file's name says, or nothing: the word
 * itself (`ts`, `Python`, `Dockerfile`), and failing that what follows its last dot.
 */
export function languageOf(word: string | undefined): Language | undefined {
  const name = (word ?? '').trim().toLowerCase();
  return BY_NAME.get(name) ?? BY_NAME.get(name.slice(name.lastIndexOf('.') + 1));
}

/**
 * Past either a text is drawn plain: colour is not worth a page's second on a file nobody
 * scans, and the highlighter takes about that long at a few times this length.
 */
const MAX_HIGHLIGHT = 40_000;
const MAX_HIGHLIGHT_LINES = 5_000;
export const highlightable = (code: string) =>
  code.length <= MAX_HIGHLIGHT &&
  code.split('\n', MAX_HIGHLIGHT_LINES + 1).length <= MAX_HIGHLIGHT_LINES;
/**
 * A grammar's time on one line grows far faster than the line: a minified line would hold the
 * highlighter for a minute. A block with a line past this is left uncoloured.
 */
const MAX_HIGHLIGHT_LINE = 1_000;
export const colourable = (code: string) =>
  highlightable(code) && code.split('\n').every((line) => line.length <= MAX_HIGHLIGHT_LINE);

let core: Promise<HighlighterCore> | undefined;
const grammars = new Map<string, Promise<void>>();

const highlighter = () =>
  (core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        // A grammar whose patterns the engine cannot translate exactly still colours what it can.
        engine: createJavaScriptRegexEngine({ forgiving: true }),
        themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
        langs: [],
      }),
  ));

/**
 * The lines of `code` in the language `lang` names coloured, once the highlighter and its grammar
 * load, with `begin` called as the colouring starts; null where they cannot be. Some lines take a
 * grammar seconds even within colourable()'s bounds, so the page calls this off its thread
 * (code-block.tsx), where a block not coloured in time is left plain.
 */
export async function colour(
  code: string,
  lang: string,
  begin: () => void = () => {},
): Promise<Piece[][] | null> {
  const language = languageOf(lang);
  if (!language || !colourable(code)) return null;
  try {
    const shiki = await highlighter();
    let grammar = grammars.get(language.id);
    if (!grammar)
      grammars.set(
        language.id,
        (grammar = language.load().then((module) => shiki.loadLanguage(module.default))),
      );
    await grammar;
    begin();
    return shiki
      .codeToTokens(code, {
        lang: language.id,
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false,
        // Shiki stops a line after 500 ms and colours its rest as one token. A grammar compiles as
        // it first reads, so a busy machine could cut the first theme's line and not the second's:
        // the colours would hang on the clock. The page's clock bounds the work instead.
        tokenizeTimeLimit: 0,
      })
      .tokens.map((line) =>
        line.map((token) => ({
          content: token.content,
          style: token.htmlStyle as Record<string, string>,
        })),
      );
  } catch {
    return null;
  }
}
