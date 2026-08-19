/**
 * InlineMd — the inline subset of markdown (`code`, **bold**, *emphasis*)
 * for one-line fields that come out of a markdown document: a requirement's
 * statement, a delivery entry's evidence, a deliverable. No paragraphs, no
 * links, no HTML — the text stays text; only the spans get typographic form.
 */
const TOKEN_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;

export default function InlineMd({ text, className }) {
  const src = String(text ?? '');
  if (!src) return null;
  const parts = src.split(TOKEN_RE);
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (!part) return null;
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return <code key={i} className="inline-md-code">{part.slice(1, -1)}</code>;
        }
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
          return <em key={i}>{part.slice(1, -1)}</em>;
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}
