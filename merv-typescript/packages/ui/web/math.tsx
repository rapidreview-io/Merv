import { useEffect, useMemo, useState } from 'react';
import type katexModule from 'katex';

/**
 * Mathematics, typeset. KaTeX and its stylesheet load the first time a formula is
 * drawn; until then, and wherever KaTeX cannot load, the formula stands as the TeX
 * its author wrote. KaTeX is given no trust (no `\href`, `\url` or `\includegraphics`
 * that could reach out), never throws on a formula it cannot read (it prints that
 * one in red instead), and reports nothing it merely frowns on.
 */
let katex: typeof katexModule | undefined;
let loading: Promise<void> | undefined;
const load = () =>
  (loading ??= Promise.all([
    import('katex').then((module) => {
      katex = module.default;
    }),
    // The stylesheet is a nicety: math without it is still read.
    import('./katex-style').catch(() => undefined),
  ]).then(() => undefined));

const typeset = (tex: string, display: boolean): string | undefined => {
  try {
    return katex?.renderToString(tex, {
      displayMode: display,
      trust: false,
      throwOnError: false,
      strict: 'ignore',
    });
  } catch {
    return undefined;
  }
};

export function TeX({ tex, display = false }: { tex: string; display?: boolean }) {
  const [ready, setReady] = useState(!!katex);
  useEffect(() => {
    if (ready) return;
    let live = true;
    load().then(
      () => live && setReady(true),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [ready]);
  const html = useMemo(() => (ready ? typeset(tex, display) : undefined), [ready, tex, display]);
  if (html === undefined)
    return display ? (
      <pre className="math math--display math--source">{tex}</pre>
    ) : (
      <code className="math math--source">{tex}</code>
    );
  // KaTeX's markup is the one string besides Mermaid's diagrams handed to the browser as
  // HTML: KaTeX builds it from the formula alone, escapes the formula's text, and with
  // `trust: false` emits no link, image or attribute the author could choose.
  return display ? (
    <div className="math math--display" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="math" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
