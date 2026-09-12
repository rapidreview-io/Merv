import { memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './CodeBlock';
import EntityChip from './EntityChip';
import rehypeEntityChips from '../utils/rehypeEntityChips';
import { useAuthedSrc } from './AuthedMedia';

/**
 * Renders a single markdown image. Report figures resolve to blob-store bytes
 * that may 404 (or, in cloud mode, be unavailable) when the figure was never
 * submitted / pinned. Instead of a broken <img>, fall back to an inline
 * placeholder explaining the figure isn't in the submitted set.
 */
function FigureImg({ src, alt, title }) {
  // Failure is remembered per-src (not a bare boolean) so a later render with
  // a different resolved URL retries instead of staying stuck on the fallback.
  const [failedSrc, setFailedSrc] = useState(null);
  // Under hosted auth the bytes need the Bearer header → blob URL; passthrough
  // locally. Covers every markdown consumer (reports, plans, mobile docs).
  const authedSrc = useAuthedSrc(src);
  const filename = ((src || alt || '').split('/').pop()) || 'figure';
  if (!src || failedSrc === src) {
    return (
      <span className="figure-missing">
        <span>Figure not available</span>
        <span className="figure-missing-name">{filename}</span>
      </span>
    );
  }
  if (!authedSrc) return null;
  return <img src={authedSrc} alt={alt || ''} title={title} loading="lazy" onError={() => setFailedSrc(src)} />;
}

// react-markdown uses these functions as React element *types*, so their
// identity must be stable across renders. Defining them inline in render made
// React unmount + remount every image and code block on each poll-driven
// re-render — under hosted auth each remount refetched the figure bytes into
// a fresh blob: URL, blinking every visual on live experiment pages.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeEntityChips];
const STATIC_COMPONENTS = {
  // Injected by rehypeEntityChips for a bare entity id in prose.
  'entity-chip': ({ node, ...props }) => {
    const id = node?.properties?.dataId || props['data-id'] || props.dataId;
    return id ? <EntityChip id={String(id)} compact /> : null;
  },
  // Fenced code blocks land here. The child is the `code` element
  // with the language hint as className.
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const className = child?.props?.className || '';
    const match = /language-(\w+)/.exec(className);
    const code = String(child?.props?.children ?? '').replace(/\n$/, '');
    if (match) {
      return <CodeBlock code={code} language={match[1]} showLineNumbers={false} />;
    }
    return <pre className="md-code-plain"><code>{code}</code></pre>;
  },
  // Inline code (no `pre` ancestor) lands here.
  code({ className, children, ...props }) {
    return <code className={`md-inline-code ${className || ''}`} {...props}>{children}</code>;
  },
  a({ children, ...props }) {
    const external = props.href && /^https?:\/\//i.test(props.href);
    return (
      <a
        {...props}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer noopener' : undefined}
      >
        {children}
      </a>
    );
  },
  table({ children, ...props }) {
    return (
      <div className="md-table-wrap">
        <table {...props}>{children}</table>
      </div>
    );
  },
};

/**
 * Markdown renderer for .md / .markdown files.
 *
 * react-markdown v10 dropped the `inline` prop on the `code` component, so
 * fenced code blocks must be handled at the `pre` level (which is the actual
 * block element). Inline `\`foo\`` reaches the `code` component directly
 * (no `pre` ancestor), so it stays simple.
 *
 * - remark-gfm adds tables, strikethrough, task lists, autolinks.
 * - Fenced code with a language hint renders through CodeBlock (Prism).
 * - External links open in a new tab; in-document anchors stay in place.
 * - artifactFigures: resolve every image as an artifact reference and show its caption.
 * - resolveImageSrc (optional): maps a relative image src (e.g. a report's
 *   `figures/loss.png`) to a fetchable URL. Absolute/data/http srcs pass
 *   through untouched. Must be referentially stable (useCallback) — it keys
 *   both the memo below and the `img` component's identity.
 */
function MarkdownView({ text, resolveImageSrc, artifactFigures = false }) {
  // `img` is the only component that closes over a prop, so it alone is
  // rebuilt — and only when resolveImageSrc actually changes.
  const components = useMemo(() => ({
    ...STATIC_COMPONENTS,
    img({ src, alt, title }) {
      const passthrough = !src
        || /^(https?:|data:|blob:)/i.test(src)
        || src.startsWith('/');
      const resolved = resolveImageSrc && (artifactFigures || !passthrough) ? resolveImageSrc(src) : src;
      const img = <FigureImg src={resolved} alt={alt} title={title} />;
      return artifactFigures ? <span className="md-figure">{img}{alt && <span className="md-figure-caption">{alt}</span>}</span> : img;
    },
  }), [resolveImageSrc, artifactFigures]);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {text || ''}
      </ReactMarkdown>
    </div>
  );
}

// Memoized: with `text` a plain string and a stable resolveImageSrc, parent
// re-renders (poll ticks, store updates) skip the whole parse + render pass.
export default memo(MarkdownView);
