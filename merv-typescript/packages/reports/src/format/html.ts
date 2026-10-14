// HTML for report sections. Styling lives here only; agents never touch it.

import { marked, type Tokens } from 'marked';
import type { Report, Section } from './parse.js';

export const PAGE = {
  width: 1240,
  height: 1754,
  padX: 72,
  padTop: 60,
  padBottom: 60,
  cols: 3,
  gutter: 40,
  gapY: 36,
  bandGap: 52,
  contentW: 0,
  colW: 0,
  contentH: 0,
};
PAGE.contentW = PAGE.width - 2 * PAGE.padX;
PAGE.colW = (PAGE.contentW - (PAGE.cols - 1) * PAGE.gutter) / PAGE.cols;
PAGE.contentH = PAGE.height - PAGE.padTop - PAGE.padBottom;

export const spanWidth = (span: number) => span * PAGE.colW + (span - 1) * PAGE.gutter;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Agent text never becomes markup: raw HTML in Markdown is escaped before rendering.
marked.use({ renderer: { html: (token: Tokens.HTML | Tokens.Tag) => escape(token.text) } });
const inline = (text: string) => marked.parseInline(text, { async: false }) as string;

export const CSS = `
@page { size: ${PAGE.width}px ${PAGE.height}px; margin: 0 }
* { box-sizing: border-box }
body { margin: 0; background: #ECECE8; font-family: 'Source Serif 4', Georgia, serif; color: #2B2B2E; -webkit-font-smoothing: antialiased }
.page { position: relative; width: ${PAGE.width}px; height: ${PAGE.height}px; padding: ${PAGE.padTop}px ${PAGE.padX}px ${PAGE.padBottom}px; background: #fff; overflow: hidden; margin: 0 auto 24px; break-after: page }
@media print { body { background: #fff } .page { margin: 0 } }
.meta { display: flex; justify-content: space-between; font: 11px 'Geist Mono', ui-monospace, monospace; color: #6B6B70 }
h1 { margin: 36px 0 0; font-size: 46px; line-height: 1.1; font-weight: 600; letter-spacing: -0.02em; color: #111113 }
.band { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 48px; margin-top: 32px; align-items: start }
.band .left > p { margin: 0; font-size: 17.5px; line-height: 1.6 }
.band .label { display: block; margin: 24px 0 6px; font: 600 12px Geist, sans-serif; color: #111113 }
.band .left ul { margin: 0; padding-left: 20px; font-size: 16px; line-height: 1.55 }
.band .right p { margin: 18px 0 0; font-size: 15px; line-height: 1.6 }
.band .right p.answer { margin: 0 0 24px; font-size: 26px; line-height: 1.3; font-weight: 600; letter-spacing: -0.01em; color: #111113 }
.divider { position: absolute; left: ${PAGE.padX}px; width: ${PAGE.contentW}px; border-top: 1px solid #111113 }
.body { position: absolute; left: ${PAGE.padX}px; width: ${PAGE.contentW}px }
.block { position: absolute; display: flex; flex-direction: column; gap: 14px }
.block h2 { margin: 0; font-size: 19px; line-height: 1.3; font-weight: 600; color: #111113 }
.block p { margin: 0; font-size: 15px; line-height: 1.65 }
.block ul, .block ol { margin: 0; padding-left: 20px; font-size: 15px; line-height: 1.6 }
.block li + li { margin-top: 2px }
b, strong { font-weight: 600; color: #111113 }
.cite { color: #6B6B70 }
table { border-collapse: collapse; width: auto; min-width: 70%; font: 13px Geist, sans-serif; color: #2B2B2E }
th { font-size: 11px; font-weight: 400; color: #6B6B70; text-align: left; padding: 0 12px 6px 0 }
td { padding: 4px 12px 4px 0; vertical-align: baseline }
th:last-child, td:last-child { padding-right: 0 }
td.num, th.num { text-align: right; font: 11.5px 'Geist Mono', monospace }
.refs { display: flex; flex-direction: column; gap: 4px; font: 13px Geist, sans-serif }
.refs div { display: grid; grid-template-columns: 22px minmax(0, 1fr) 40px; column-gap: 10px }
.refs .n { color: #6B6B70 } .refs .y { text-align: right; font: 11px 'Geist Mono', monospace; color: #6B6B70 }
.chart { width: 100% }
.chart svg { display: block; overflow: visible }
`;

const cite = (html: string) => html.replace(/\[(\d+(?:[,–-]\s?\d+)*)\]/g, '<span class="cite">[$1]</span>');
const NUMERIC = /^[\s$€~≈+−\-–]*[\d.,]+\s*(k|M|B|%|tok|h|m|GPU-h)?(\s*\/\s*[\d.,]+\s*(k|M|B)?)?\s*$/;

function tableHtml(token: Tokens.Table): string {
  const numeric = token.header.map((_, i) => token.rows.every((r) => NUMERIC.test(r[i]?.text ?? '')));
  const th = token.header.map((h, i) => `<th class="${numeric[i] ? 'num' : ''}">${inline(h.text)}</th>`).join('');
  const rows = token.rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${numeric[i] ? 'num' : ''}">${cite(inline(c.text))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
}

function referencesHtml(token: Tokens.List): string {
  return `<div class="refs">${token.items
    .map((item, i) => {
      const m = item.text.match(/^(.*),\s*(\d{4})\s*$/);
      return `<div><span class="n">${i + 1}</span><span>${inline(m ? m[1] : item.text)}</span><span class="y">${m ? m[2] : ''}</span></div>`;
    })
    .join('')}</div>`;
}

/** Inner HTML for one section; charts become placeholders the browser fills. */
export function sectionHtml(section: Pick<Section, 'name' | 'blocks'>, { heading = true } = {}): string {
  const parts = heading ? [`<h2>${escape(section.name)}</h2>`] : [];
  for (const b of section.blocks) {
    if (b.type === 'chart') parts.push(`<div class="chart" data-chart="${escape(b.chart!.spec.id)}"></div>`);
    else if (b.type === 'table') parts.push(tableHtml(b.token as Tokens.Table));
    else if (section.name === 'References' && b.type === 'list') parts.push(referencesHtml(b.token as Tokens.List));
    else parts.push(cite(marked.parser([b.token!], { async: false }) as string));
  }
  return parts.join('\n');
}

export function bandHtml(report: Report): string {
  const find = (name: string) => report.sections.find((s) => s.name === name);
  const inq = find('Inquiry');
  const con = find('Constraints');
  const res = find('Result');
  const answer = res?.blocks.find((b) => b.type === 'paragraph');
  const rest = res ? { name: res.name, blocks: res.blocks.filter((b) => b !== answer) } : null;
  const meta = report.meta as { id?: unknown; date?: unknown };
  return `
<div class="meta"><span>${escape(String(meta.id ?? ''))}</span><span>${escape(String(meta.date ?? ''))}</span></div>
<h1>${inline(report.title ?? '')}</h1>
<div class="band">
  <div class="left">${inq ? sectionHtml(inq, { heading: false }) : ''}${con ? `<span class="label">Constraints</span>${sectionHtml(con, { heading: false })}` : ''}</div>
  <div class="right">${answer ? `<p class="answer">${cite(inline((answer.token as Tokens.Paragraph).text))}</p>` : ''}${rest ? sectionHtml(rest, { heading: false }) : ''}</div>
</div>`;
}

export function shellHtml(fontCss: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}${CSS}</style></head><body><div id="measure" style="position:absolute;left:-10000px;top:0"></div><div id="pages"></div></body></html>`;
}
