/**
 * A web page or a document, pasted, as Markdown. What it carries as HTML is read in an inert document
 * (nothing in it runs or loads) and only its structure is taken: headings, lists, tables, emphasis,
 * code, links. Google Docs and Word say bold and italic in styles on spans, so styles are read too.
 */
const skipped = new Set([
  'SCRIPT',
  'STYLE',
  'META',
  'LINK',
  'TITLE',
  'HEAD',
  'IMG',
  'SVG',
  'NOSCRIPT',
]);
const blocks = new Set([
  'P',
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'ASIDE',
  'NAV',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'PRE',
  'BLOCKQUOTE',
  'TABLE',
  'HR',
]);

/** A person's words stay words: only what Markdown would take as a mark is escaped. */
const escaped = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/([\\`*[\]])/g, '\\$1')
    .replace(/(^|\s)_(?=\S)/g, '$1\\_')
    .replace(/^(\s*)(#{1,6} |>|[-+] |\d+[.)] )/, '$1\\$2');

const wrapped = (text: string, mark: string) => {
  const [, before, words, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return words ? `${before}${mark}${words}${mark}${after}` : text;
};

function inline(node: Node, inCode = false): string {
  if (node.nodeType === 3)
    return inCode ? (node.textContent ?? '') : escaped(node.textContent ?? '');
  if (node.nodeType !== 1) return '';
  const el = node as HTMLElement;
  if (skipped.has(el.tagName)) return '';
  if (el.tagName === 'BR') return '  \n';
  const inner = [...el.childNodes]
    .map((child) => inline(child, inCode || el.tagName === 'CODE'))
    .join('');
  const { fontWeight, fontStyle, textDecoration } = el.style;
  const weight = Number(fontWeight);
  // Google Docs wraps a whole paste in a <b> that says it is normal.
  const bold =
    (['B', 'STRONG'].includes(el.tagName) && fontWeight !== 'normal') ||
    fontWeight === 'bold' ||
    weight >= 600;
  const italic = ['I', 'EM'].includes(el.tagName) || fontStyle === 'italic';
  const struck =
    ['S', 'DEL', 'STRIKE'].includes(el.tagName) || textDecoration.includes('line-through');
  let out = inner;
  if (el.tagName === 'CODE' && !inCode) return out.trim() ? `\`${out}\`` : out;
  if (el.tagName === 'A' && el.getAttribute('href')) {
    const href = el.getAttribute('href')!;
    if (/^(https?:|mailto:)/i.test(href) && out.trim())
      out = `[${out.trim()}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
  }
  if (struck) out = wrapped(out, '~~');
  if (italic) out = wrapped(out, '*');
  if (bold) out = wrapped(out, '**');
  return out;
}

const hasBlock = (el: Element): boolean =>
  [...el.children].some((child) => blocks.has(child.tagName) || hasBlock(child));

function listOf(list: Element, depth: number): string {
  const ordered = list.tagName === 'OL';
  const pad = '  '.repeat(depth);
  return [...list.children]
    .filter((item) => item.tagName === 'LI')
    .map((item, index) => {
      const nested = [...item.children].filter((child) => ['UL', 'OL'].includes(child.tagName));
      const words = [...item.childNodes]
        .filter((child) => !nested.includes(child as Element))
        .map((child) => inline(child))
        .join('')
        .trim();
      const marker = ordered ? `${index + 1}. ` : '- ';
      return [
        `${pad}${marker}${words}`,
        ...nested.map((child) => listOf(child, depth + (ordered ? 2 : 1))),
      ].join('\n');
    })
    .join('\n');
}

function tableOf(table: Element): string {
  const rows = [...table.querySelectorAll('tr')].map((row) =>
    [...row.children].map((cell) =>
      inline(cell).replace(/\s+/g, ' ').trim().replaceAll('|', '\\|'),
    ),
  );
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
}

function blocksOf(root: Element): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => {
    if (run.trim()) out.push(run.trim());
    run = '';
  };
  for (const node of root.childNodes) {
    if (node.nodeType !== 1 || !blocks.has((node as Element).tagName)) {
      // A wrapper that holds blocks (Google Docs' <b>) is read through; words are gathered.
      if (node.nodeType === 1 && hasBlock(node as Element)) {
        flush();
        out.push(...blocksOf(node as Element));
      } else run += inline(node);
      continue;
    }
    flush();
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} ${inline(el).trim()}`);
    else if (tag === 'UL' || tag === 'OL') out.push(listOf(el, 0));
    else if (tag === 'PRE') out.push(`\`\`\`\n${el.textContent?.replace(/\n$/, '') ?? ''}\n\`\`\``);
    else if (tag === 'BLOCKQUOTE')
      out.push(
        blocksOf(el)
          .join('\n\n')
          .split('\n')
          .map((line) => `> ${line}`.trimEnd())
          .join('\n'),
      );
    else if (tag === 'TABLE') out.push(tableOf(el));
    else if (tag === 'HR') out.push('---');
    else if (hasBlock(el)) out.push(...blocksOf(el));
    else if (inline(el).trim()) out.push(inline(el).trim());
  }
  flush();
  return out;
}

/** The Markdown of pasted HTML, or null where it says no more than its plain text would. */
export function markdownOf(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const shaped = doc.body.querySelector(
    'h1,h2,h3,h4,h5,h6,ul,ol,table,pre,blockquote,a,b,strong,i,em,code,[style*="font-weight"],[style*="font-style"]',
  );
  if (!shaped) return null;
  return blocksOf(doc.body).join('\n\n') || null;
}
