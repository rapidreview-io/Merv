/** Explicit grammars keep the highlighter small and avoid expensive automatic detection. */
const grammars = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  css: () => import('highlight.js/lib/languages/css'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  sql: () => import('highlight.js/lib/languages/sql'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  diff: () => import('highlight.js/lib/languages/diff'),
};
const aliases: Record<string, keyof typeof grammars> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  html: 'xml',
  svg: 'xml',
  yml: 'yaml',
  rs: 'rust',
  golang: 'go',
};
const MAX_HIGHLIGHT_LENGTH = 50_000;
let core: Promise<typeof import('highlight.js/lib/core')> | undefined;
const registered = new Map<string, Promise<void>>();

function canHighlight(text: string, language: string): boolean {
  const name = aliases[language.toLowerCase()] ?? language.toLowerCase();
  return text.length <= MAX_HIGHLIGHT_LENGTH && Object.hasOwn(grammars, name);
}

/** Only highlight.js's escaped generated spans reach the DOM; source HTML stays text. */
export async function renderHighlightedCode(
  text: string,
  language: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted || !canHighlight(text, language)) return;
  const name = (aliases[language.toLowerCase()] ?? language.toLowerCase()) as keyof typeof grammars;
  try {
    const highlighter = (
      await (core ??= import('highlight.js/lib/core').catch((error) => {
        core = undefined;
        throw error;
      }))
    ).default;
    if (signal?.aborted) return;
    let ready = registered.get(name);
    if (!ready) {
      ready = grammars[name]()
        .then((grammar) => {
          highlighter.registerLanguage(name, grammar.default);
        })
        .catch((error) => {
          registered.delete(name);
          throw error;
        });
      registered.set(name, ready);
    }
    await ready;
    if (signal?.aborted) return;
    return highlighter.highlight(text, { language: name, ignoreIllegals: true }).value;
  } catch {
    return;
  }
}
