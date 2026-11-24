import { useSyncExternalStore } from 'react';
import { useLazyRich } from './lazy-rich';

/** The theme the page wears, drawn again when the appearance changes. */
const worn = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const onWorn = (changed: () => void) => {
  const watch = new MutationObserver(changed);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => watch.disconnect();
};

/** Every component initially renders source; modules and fonts load only near the viewport. */
export function HighlightedCode({ text, language }: { text: string; language: string }) {
  const { ref, value } = useLazyRich(
    `${language}\0${text}`,
    async (signal) => {
      const { renderHighlightedCode } = await import('./render-code');
      return renderHighlightedCode(text, language, signal);
    },
    !!language && text.length <= 50_000,
  );
  return value === undefined ? (
    <code ref={ref}>{text}</code>
  ) : (
    <code ref={ref} dangerouslySetInnerHTML={{ __html: value }} />
  );
}

export function MathContent({ text, display = false }: { text: string; display?: boolean }) {
  const { ref, value } = useLazyRich(
    `${display}\0${text}`,
    async (signal) => {
      const [{ renderMath }] = await Promise.all([
        import('./render-math'),
        import('katex/dist/katex.min.css'),
      ]);
      return renderMath(text, display, signal);
    },
    text.length <= 8_000,
  );
  const Tag = display ? 'div' : 'span';
  return (
    <Tag
      ref={ref}
      className={display ? 'prose-math prose-math-display' : 'prose-math'}
      data-find-text={text}
      data-find-block={display || undefined}
    >
      {value === undefined ? (
        <span data-find-ignore className="prose-math-source">
          {text}
        </span>
      ) : (
        <span data-find-ignore dangerouslySetInnerHTML={{ __html: value }} />
      )}
    </Tag>
  );
}

export function MermaidContent({ text }: { text: string }) {
  const theme = useSyncExternalStore(onWorn, worn, () => 'dark' as const);
  const { ref, value } = useLazyRich(
    `${theme}\0${text}`,
    async (signal) => {
      const { renderMermaid } = await import('./render-mermaid');
      return renderMermaid(text, signal, theme);
    },
    text.length <= 12_000,
  );
  return (
    <div ref={ref} className="prose-mermaid" data-find-text={text} data-find-block>
      {value === undefined ? (
        <pre data-find-ignore className="prose-code">
          {text}
        </pre>
      ) : (
        <div
          data-find-ignore
          className="prose-diagram"
          dangerouslySetInnerHTML={{ __html: value }}
        />
      )}
    </div>
  );
}
