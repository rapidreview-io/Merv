import { useLazyRich } from './lazy-rich';
import { Mermaid } from '../mermaid';

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

/** A diagram in prose, drawn by the page's one Mermaid (../mermaid.tsx): fitted, strict, and
 *  shown at full size on a press; while it loads, or where it cannot be read, its source. */
export function MermaidContent({ text }: { text: string }) {
  return (
    <div className="prose-mermaid" data-find-text={text} data-find-block>
      <div data-find-ignore className="prose-diagram">
        <Mermaid source={text} />
      </div>
    </div>
  );
}
