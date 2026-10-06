import type { Nodes, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import { safeHref, splitIds, type Block, type Inline } from './markdown';

/**
 * The text is read by micromark into mdast, a tree and never HTML, with GFM (tables, task
 * boxes, strikethrough, bare addresses) and `$` math. What this app never reads is switched
 * off: HTML, so a tag an author wrote is text and the Markdown around it still reads; link
 * definitions and footnotes, which would let a line at the end change one at the start and
 * so make a growing text read differently in pieces than whole; and `$$` fences, since a
 * formula is a `$$ … $$` run inside its paragraph, which a blank line ends as it does in TeX.
 */
const READ = {
  extensions: [
    gfm({ singleTilde: false }),
    math(),
    {
      disable: {
        null: [
          'htmlFlow',
          'htmlText',
          'definition',
          'gfmFootnoteDefinition',
          'gfmFootnoteCall',
          'gfmPotentialFootnoteCall',
          'mathFlow',
        ],
      },
    },
  ],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
};

/** Past this the document is shown as the text it was rather than nested any deeper. */
const MAX_DEPTH = 8;
/** A fence in one of these is a formula, typeset rather than shown as code. */
const MATH_FENCES = new Set(['math', 'latex', 'tex']);
const literal = (value: string): Inline => ({ type: 'text', value });
const startOf = (node: Nodes) => node.position!.start.offset!;
const columnOf = (node: Nodes) => node.position!.start.column;
/** What the author wrote for a node, character for character. */
const written = (source: string, node: Nodes) =>
  source.slice(startOf(node), node.position!.end.offset);

/** Adjacent text is one text; an empty one is nothing. */
function add(out: Inline[], node: Inline): void {
  const last = out[out.length - 1];
  if (node.type !== 'text') out.push(node);
  else if (last?.type === 'text') last.value += node.value;
  else if (node.value) out.push(node);
}

/** Words, with each record id its own node so the renderer can name it. */
function words(out: Inline[], value: string, type: 'text' | 'code'): void {
  splitIds(value).forEach((piece, at) => {
    if (at % 2) add(out, { type: 'id', id: piece });
    else if (piece) add(out, { type, value: piece });
  });
}

/**
 * Inline math by Pandoc's rule, which keeps prices prices: the opening `$` has no space after
 * it, and the closing one no space before it and no digit after it, so "$5 and $10" is text.
 */
function priced(source: string, node: Nodes): boolean {
  const from = startOf(node);
  const to = node.position!.end.offset! - 1;
  if (source[from + 1] === '$') return false;
  return (
    /\s/.test(source[from + 1]!) || /\s/.test(source[to - 1]!) || /\d/.test(source[to + 1] ?? '')
  );
}

/**
 * Inline mdast to the tree the page draws. Agents write one fact per line, so a single newline
 * is a line break here and not a space. A link holds no link: inside a label (`linked`) an
 * address stays the text it was written as, and a link or an image is only its words, so a
 * badge opens what its link names, not its picture. An image loads nothing: it is a link that
 * reads as its alt text.
 */
function inlinesOf(
  nodes: PhrasingContent[],
  source: string,
  depth: number,
  linked: boolean,
  out: Inline[] = [],
): Inline[] {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        node.value.split('\n').forEach((line, at) => {
          if (at) add(out, { type: 'break' });
          words(out, line, 'text');
        });
        break;
      case 'inlineCode':
        words(out, node.value.replaceAll('\n', ' '), 'code');
        break;
      case 'inlineMath':
        add(
          out,
          priced(source, node)
            ? literal(written(source, node))
            : { type: 'math', value: node.value },
        );
        break;
      case 'break':
        add(out, { type: 'break' });
        break;
      case 'strong':
      case 'emphasis':
      case 'delete':
        add(
          out,
          depth < MAX_DEPTH
            ? {
                type: node.type === 'emphasis' ? 'em' : node.type === 'delete' ? 'del' : 'strong',
                children: inlinesOf(node.children, source, depth + 1, linked),
              }
            : literal(written(source, node)),
        );
        break;
      case 'link':
      case 'image': {
        const safe = !linked && safeHref(node.url);
        const raw = written(source, node);
        // An address written bare or in angle brackets reads as itself.
        const bracketed = raw[0] === '[' || raw[0] === '!';
        const children =
          node.type === 'image'
            ? [literal(node.alt || node.url)]
            : !bracketed
              ? [literal(raw[0] === '<' ? raw.slice(1, -1) : raw)]
              : depth < MAX_DEPTH
                ? inlinesOf(node.children, source, depth + 1, true)
                : [literal(raw)];
        if (safe)
          add(out, {
            type: 'link',
            ...safe,
            ...(bracketed ? { title: node.title ?? undefined } : {}),
            children,
          });
        else if (bracketed) for (const child of children) add(out, child);
        else add(out, literal(raw));
        break;
      }
      default:
        add(out, literal(written(source, node)));
    }
  }
  return out;
}

/** A paragraph, less the breaks at either end that a formula cut off it left behind. */
function paragraph(nodes: PhrasingContent[], source: string, out: Block[]): void {
  const children = inlinesOf(nodes, source, 0, false);
  while (children[0]?.type === 'break') children.shift();
  while (children[children.length - 1]?.type === 'break') children.pop();
  if (children.length) out.push({ type: 'paragraph', children });
}

/** A `$$ … $$` run on lines of its own is a formula set apart; within a line it stays inline. */
const display = (nodes: PhrasingContent[], at: number, source: string) => {
  const [before, node, after] = [nodes[at - 1], nodes[at]!, nodes[at + 1]];
  return (
    node.type === 'inlineMath' &&
    source[startOf(node) + 1] === '$' &&
    (!before ||
      before.type === 'break' ||
      (before.type === 'text' && before.value.endsWith('\n'))) &&
    (!after || after.type === 'break' || (after.type === 'text' && after.value.startsWith('\n')))
  );
};

/**
 * Lists nest the way agents write them: two spaces under any marker, whatever the marker's own
 * width. CommonMark reads a list indented less than its parent's marker as a list beside it;
 * here it goes into the parent's last item.
 */
function nest(nodes: RootContent[]): RootContent[] {
  const out: RootContent[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.type === 'list' && last?.type === 'list' && columnOf(node) > columnOf(last))
      last.children[last.children.length - 1]!.children.push(node);
    else out.push(node);
  }
  return out;
}

function blocksOf(nodes: RootContent[], source: string, depth: number): Block[] {
  const out: Block[] = [];
  for (const node of nest(nodes)) {
    if (depth > MAX_DEPTH) {
      out.push({ type: 'paragraph', children: [literal(written(source, node))] });
      continue;
    }
    switch (node.type) {
      case 'heading':
        out.push({
          type: 'heading',
          level: node.depth,
          children: inlinesOf(node.children, source, 0, false),
        });
        break;
      case 'paragraph': {
        let from = 0;
        node.children.forEach((_, at) => {
          if (!display(node.children, at, source)) return;
          paragraph(node.children.slice(from, at), source, out);
          out.push({ type: 'math', value: (node.children[at] as { value: string }).value.trim() });
          from = at + 1;
        });
        paragraph(node.children.slice(from), source, out);
        break;
      }
      case 'code':
        out.push(
          node.lang && MATH_FENCES.has(node.lang.toLowerCase())
            ? { type: 'math', value: node.value }
            : { type: 'code', ...(node.lang ? { lang: node.lang } : {}), value: node.value },
        );
        break;
      case 'blockquote':
        out.push({ type: 'quote', children: blocksOf(node.children, source, depth + 1) });
        break;
      case 'list':
        out.push({
          type: 'list',
          ordered: !!node.ordered,
          start: node.start ?? 1,
          loose: !!node.spread || node.children.some((item) => item.spread),
          items: node.children.map((item) => ({
            ...(typeof item.checked === 'boolean' ? { checked: item.checked } : {}),
            children: blocksOf(item.children, source, depth + 1),
          })),
        });
        break;
      case 'table': {
        const align = node.align ?? [];
        const [head, ...rows] = node.children.map((row) =>
          align.map((_, column) =>
            inlinesOf(row.children[column]?.children ?? [], source, 0, false),
          ),
        );
        out.push({ type: 'table', align, head: head!, rows });
        break;
      }
      case 'thematicBreak':
        out.push({ type: 'rule' });
        break;
      default:
        out.push({ type: 'paragraph', children: [literal(written(source, node))] });
    }
  }
  return out;
}

/**
 * Markdown source to its tree. Pure, and total: whatever it is given — half a table,
 * an unclosed fence, a thousand nested quotes, no Markdown at all — it answers with
 * blocks, and a text it cannot read as anything else is a paragraph of that text.
 */
export function parseMarkdown(source: string): Block[] {
  try {
    return blocksOf(fromMarkdown(source, READ).children, source, 0);
  } catch {
    return source.trim() ? [{ type: 'paragraph', children: [literal(source)] }] : [];
  }
}

/** The inline tree of a text's paragraphs. */
export const parseInline = (source: string): Inline[] =>
  parseMarkdown(source).flatMap((block) => (block.type === 'paragraph' ? block.children : []));
