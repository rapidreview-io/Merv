// Render a parsed report in headless Chromium: measure every body section at every span it allows,
// solve the layout, draw the pages, then capture page images, a PDF, or one chart for review.
// The page has no network: fonts are embedded and every request is refused.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { MervError } from '@merv/contracts';
import {
  compileSpec,
  chartHeights,
  loadRows,
  ROLES,
  type DataFiles,
  type Issue,
} from './format/spec.js';
import { PAGE, spanWidth, sectionHtml, bandHtml, shellHtml } from './format/html.js';
import { solveLayout, type Layout, type LayoutBlock } from './format/layout.js';
import type { Report, Section } from './format/parse.js';

const require = createRequire(import.meta.url);
const pkg = (name: string) => dirname(require.resolve(name));

function fontCss(): string {
  const face = (family: string, file: string, weight: number, style = 'normal') =>
    `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${readFileSync(file).toString('base64')}) format('woff2')}`;
  const serif = (w: number, s: string) =>
    join(pkg('@fontsource/source-serif-4'), 'files', `source-serif-4-latin-${w}-${s}.woff2`);
  const sans = (w: number) =>
    join(pkg('@fontsource/geist-sans'), 'files', `geist-sans-latin-${w}-normal.woff2`);
  const mono = (w: number) =>
    join(pkg('@fontsource/geist-mono'), 'files', `geist-mono-latin-${w}-normal.woff2`);
  return [
    face('Source Serif 4', serif(400, 'normal'), 400),
    face('Source Serif 4', serif(600, 'normal'), 600),
    face('Source Serif 4', serif(400, 'italic'), 400, 'italic'),
    face('Geist', sans(400), 400),
    face('Geist', sans(500), 500),
    face('Geist', sans(600), 600),
    face('Geist Mono', mono(400), 400),
    face('Geist Mono', mono(500), 500),
  ].join('\n');
}

const CLIENT = `
window.renderChart = async (sel, spec) => {
  const el = document.querySelector(sel);
  el.innerHTML = '';
  const vg = vegaLite.compile(spec).spec;
  const view = new vega.View(vega.parse(vg), { renderer: 'svg', container: el, hover: false });
  await view.runAsync();
};
window.lintChart = (sel) => {
  const el = document.querySelector(sel);
  const svg = el.querySelector('svg');
  const issues = [];
  if (!svg) return { issues: [{ level: 'error', message: 'chart did not render' }] };
  const box = svg.getBoundingClientRect();
  const texts = [...svg.querySelectorAll('text')].filter((t) => t.textContent.trim()).map((t) => ({
    text: t.textContent.trim(), r: t.getBoundingClientRect(), size: parseFloat(t.getAttribute('font-size') || getComputedStyle(t).fontSize),
  }));
  const overlap = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 1 && h > 1 && w * h > 6;
  };
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++)
    if (overlap(texts[i].r, texts[j].r)) issues.push({ level: 'error', message: 'labels overlap: "' + texts[i].text + '" and "' + texts[j].text + '"' });
  for (const t of texts) {
    if (t.r.left < box.left - 2 || t.r.right > box.right + 2 || t.r.top < box.top - 2 || t.r.bottom > box.bottom + 2)
      issues.push({ level: 'error', message: 'label is cut off at the chart edge: "' + t.text + '"' });
    if (t.text.endsWith('…')) issues.push({ level: 'error', message: 'label is truncated: "' + t.text + '"; shorten it' });
    if (t.size && t.size < 10) issues.push({ level: 'error', message: 'text smaller than 10px: "' + t.text + '"' });
  }
  // A value label drawn on top of a mark (an interval, a bar) is hard to read.
  const shapes = [...svg.querySelectorAll('.role-mark path, .role-mark rect, .role-mark line')].map((s) => s.getBoundingClientRect()).filter((r) => r.width > 3 && r.height > 1);
  for (const t of texts) if (/^[+−-]?[\\d.,]+%?$/.test(t.text) && shapes.some((s) => overlap(t.r, s)))
    issues.push({ level: 'warning', message: 'value label "' + t.text + '" sits on a mark; offset it or move it to the chart edge' });
  const marks = svg.querySelectorAll('.role-mark > *').length;
  if (!marks) issues.push({ level: 'error', message: 'no marks were drawn; check field names and data' });
  return { issues: issues.filter((i, n, all) => all.findIndex((j) => j.message === i.message) === n) };
};
window.measureBlock = (html, width) => {
  const m = document.getElementById('measure');
  m.innerHTML = '<div class="block" id="mblock" style="position:relative;width:' + width + 'px">' + html + '</div>';
};
window.blockHeight = (sel) => {
  const el = document.querySelector(sel);
  return { h: el.getBoundingClientRect().height, overflow: el.scrollWidth > el.clientWidth + 1 };
};
`;

export interface VisualShot {
  id: string;
  section: string;
  message: string;
  width: number;
  height: number;
  image: Buffer;
  context: Buffer;
  issues: Issue[];
}
export interface Rendered {
  layout: Layout;
  pages: Buffer[];
  pdf?: Buffer;
  visual?: VisualShot;
  /** Problems found only by drawing: overflow and size drift. */
  issues: Issue[];
}
export interface RenderOptions {
  pdf?: boolean;
  pages?: boolean;
  visual?: string;
}

/** A failure while drawing that no check foresaw, as a refusal the agent can act on: what failed
 *  and the browser's own reason, not an opaque internal error (2026-10-17: a chart report.check
 *  accepted failed review_visual twice with only "Internal server error"). Logged for operators. */
function drawFailure(error: unknown, chart?: string): MervError {
  if (error instanceof MervError) return error;
  const text = error instanceof Error ? error.message : String(error);
  // Playwright's reasons end with a period of their own; the message below adds one.
  const reason = text.split('\n')[0]!.trim().slice(0, 300).replace(/\.+$/, '') || 'unknown error';
  process.stderr.write(
    JSON.stringify({
      event: 'report.render_failed',
      chart: chart ?? null,
      reason,
      stack: error instanceof Error ? error.stack?.slice(0, 2000) : undefined,
    }) + '\n',
  );
  const what = chart ? `chart ${chart}` : 'the report';
  return new MervError(
    'report_render_failed',
    `Merv could not draw ${what}: ${reason}. Try once more; if it fails the same way, simplify ${chart ? 'that chart' : 'its largest chart'} (fewer rows or layers, a smaller height) with report.write and review it again`,
    422,
    chart ? { chart } : undefined,
  );
}

function allowedSpans(section: Section): number[] {
  const charts = section.blocks.filter((b) => b.type === 'chart');
  if (charts.some((b) => b.chart!.spec.wide)) return [2, 3];
  if (section.name === 'References') return [1];
  if (charts.length || section.blocks.some((b) => b.type === 'table')) return [1, 2];
  return [1];
}

/** One headless browser per process, rendering one report at a time. */
export class ReportRenderer {
  private browser?: Promise<Browser>;
  private queue: Promise<unknown> = Promise.resolve();
  private fonts?: string;
  private closed = false;
  constructor(private readonly executablePath?: string) {}

  async close(): Promise<void> {
    this.closed = true;
    const browser = this.browser;
    this.browser = undefined;
    await (await browser?.catch(() => undefined))?.close().catch(() => {});
  }

  render(report: Report, files: DataFiles, options: RenderOptions): Promise<Rendered> {
    const run = this.queue
      .then(() => this.renderNow(report, files, options))
      .catch((error: unknown) => {
        throw drawFailure(error, options.visual);
      });
    this.queue = run.catch(() => {});
    return run;
  }

  private async launch(): Promise<Browser> {
    if (this.closed)
      throw new MervError('reports_unavailable', 'The report renderer is stopping', 503);
    this.browser ??= chromium
      .launch({
        executablePath: this.executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      .catch((error: Error) => {
        this.browser = undefined;
        throw new MervError(
          'reports_renderer_unavailable',
          `The report renderer could not start a browser: ${error.message.split('\n')[0]}`,
          503,
        );
      });
    const browser = await this.browser;
    if (!browser.isConnected()) {
      this.browser = undefined;
      return await this.launch();
    }
    return browser;
  }

  private async renderNow(
    report: Report,
    files: DataFiles,
    options: RenderOptions,
  ): Promise<Rendered> {
    const browser = await this.launch();
    const context = await browser.newContext({
      viewport: { width: 1400, height: 1900 },
      deviceScaleFactor: 2,
      javaScriptEnabled: true,
    });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    try {
      this.fonts ??= fontCss();
      await page.setContent(shellHtml(this.fonts));
      await page.addScriptTag({ path: join(pkg('vega'), 'vega.min.js') });
      await page.addScriptTag({ path: join(pkg('vega-lite'), 'vega-lite.min.js') });
      await page.addScriptTag({ content: CLIENT });
      await page.evaluate(async () => {
        await Promise.all(
          [
            '17px "Source Serif 4"',
            '600 17px "Source Serif 4"',
            'italic 17px "Source Serif 4"',
            '13px Geist',
            '500 13px Geist',
            '600 13px Geist',
            '11px "Geist Mono"',
          ].map((f) => document.fonts.load(f)),
        );
        await document.fonts.ready;
      });
      const drawn = await this.layout(page, report, files);
      const out: Rendered = { layout: drawn.layout, pages: [], issues: drawn.issues };
      if (options.pages)
        for (let i = 0; i < drawn.pageCount; i++)
          out.pages.push(await page.locator(`#p${i}`).screenshot({ scale: 'css', type: 'png' }));
      if (options.visual)
        out.visual = await this.visual(page, report, options.visual, drawn.charts);
      if (options.pdf) {
        await page.emulateMedia({ media: 'print' });
        out.pdf = await page.pdf({
          width: `${PAGE.width}px`,
          height: `${PAGE.height}px`,
          printBackground: true,
          preferCSSPageSize: true,
        });
      }
      return out;
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async drawCharts(
    page: Page,
    report: Report,
    files: DataFiles,
    rootSel: string,
    heightFor: (hs: { base: number; max: number }) => number,
  ) {
    const ids = await page.$$eval(`${rootSel} .chart`, (els) =>
      els.map((e) => [(e as HTMLElement).dataset.chart!, e.getBoundingClientRect().width] as const),
    );
    const drawn: Record<string, { width: number; height: number; base: number; max: number }> = {};
    for (const [id, width] of ids) {
      const chart = report.charts.find((c) => c.spec.id === id)!;
      const rows = loadRows(chart.spec.data, files, report.criteria);
      const hs = chartHeights(chart.spec, rows);
      const height = heightFor(hs);
      const vl = compileSpec(chart.spec, {
        width: Math.floor(width),
        height,
        files,
        criteria: report.criteria,
      });
      try {
        await page.evaluate(([sel, spec]) => (window as any).renderChart(sel, spec), [
          `${rootSel} .chart[data-chart="${id}"]`,
          vl,
        ] as const);
      } catch (error) {
        throw new MervError(
          'report_chart_failed',
          `Chart ${id} could not be drawn: ${(error as Error).message.split('\n')[0]}`,
          422,
        );
      }
      drawn[id] = { width: Math.floor(width), height, base: hs.base, max: hs.max };
    }
    return drawn;
  }

  private async layout(page: Page, report: Report, files: DataFiles) {
    await page.evaluate((html) => {
      document.getElementById('pages')!.innerHTML = '<div class="page" id="p0">' + html + '</div>';
    }, bandHtml(report));
    const bandCharts = await this.drawCharts(page, report, files, '#p0 .band', (hs) => hs.base);
    const bandBottom = await page.$eval(
      '#p0 .band',
      (el) => el.getBoundingClientRect().bottom - el.closest('.page')!.getBoundingClientRect().top,
    );
    const bodyTop0 = Math.ceil(bandBottom + PAGE.bandGap);
    await page.evaluate(
      (top) => {
        const d = document.createElement('div');
        d.className = 'divider';
        d.style.top = top + 'px';
        document.getElementById('p0')!.appendChild(d);
      },
      Math.round(bandBottom + PAGE.bandGap / 2),
    );

    const body = report.sections.filter((s) => s.zone === 'body');
    const blocks: (LayoutBlock & { html: string })[] = [];
    const issues: Issue[] = [];
    for (const s of body) {
      const html = sectionHtml(s);
      const options: { span: number; h: number }[] = [];
      let elastic = 0;
      for (const span of allowedSpans(s)) {
        await page.evaluate(([h, w]) => (window as any).measureBlock(h, w), [
          html,
          spanWidth(span),
        ] as const);
        const drawn = await this.drawCharts(page, report, files, '#mblock', (hs) => hs.base);
        const { h, overflow } = await page.evaluate(() => (window as any).blockHeight('#mblock'));
        elastic = Object.values(drawn).reduce((sum, d) => sum + (d.max - d.base), 0);
        if (!overflow) options.push({ span, h: Math.ceil(h) });
      }
      if (!options.length) {
        issues.push({
          level: 'error',
          where: s.name,
          message: 'content is wider than the page; shorten table cells or labels',
        });
        options.push({
          span: Math.max(...allowedSpans(s)),
          h: Math.ceil((await page.evaluate(() => (window as any).blockHeight('#mblock'))).h),
        });
      }
      blocks.push({ id: s.name, options, elastic, html });
    }
    const layout = solveLayout(blocks, {
      cols: PAGE.cols,
      gap: PAGE.gapY,
      pageHeight: (p) => (p === 0 ? PAGE.height - PAGE.padBottom - bodyTop0 : PAGE.contentH),
    });
    const pageCount = Math.max(0, ...layout.placed.map((p) => p.page)) + 1;
    await page.evaluate(
      ({ count, padTop, bodyTop0 }) => {
        const pages = document.getElementById('pages')!;
        for (let i = 0; i < count; i++) {
          let pg = document.getElementById('p' + i);
          if (!pg) {
            pg = document.createElement('div');
            pg.className = 'page';
            pg.id = 'p' + i;
            pages.appendChild(pg);
          }
          const div = document.createElement('div');
          div.className = 'body';
          div.id = 'b' + i;
          div.style.top = (i === 0 ? bodyTop0 : padTop) + 'px';
          pg.appendChild(div);
        }
        document.getElementById('measure')!.innerHTML = '';
      },
      { count: pageCount, padTop: PAGE.padTop, bodyTop0 },
    );
    const charts = { ...bandCharts };
    for (const p of layout.placed) {
      const b = blocks.find((x) => x.id === p.id)!;
      const left = p.col * (PAGE.colW + PAGE.gutter);
      await page.evaluate(
        ({ page, id, html, left, top, width }) => {
          const div = document.createElement('div');
          div.className = 'block';
          div.dataset.section = id;
          div.style.cssText = `left:${left}px;top:${top}px;width:${width}px`;
          div.innerHTML = html;
          document.getElementById('b' + page)!.appendChild(div);
        },
        { page: p.page, id: p.id, html: b.html, left, top: p.top, width: spanWidth(p.span) },
      );
      const share = b.elastic > 0 ? p.extra / b.elastic : 0;
      Object.assign(
        charts,
        await this.drawCharts(page, report, files, `.block[data-section="${p.id}"]`, (hs) =>
          Math.round(hs.base + (hs.max - hs.base) * share),
        ),
      );
    }
    if (pageCount > 1)
      issues.push({
        level: 'warning',
        where: 'page',
        message: `the report runs to ${pageCount} pages; it should fit on one`,
      });
    return { layout, pageCount, charts, issues };
  }

  private async visual(
    page: Page,
    report: Report,
    id: string,
    sizes: Record<string, { width: number; height: number }>,
  ): Promise<VisualShot> {
    const chart = report.charts.find((c) => c.spec.id === id);
    if (!chart) throw new MervError('not_found', `No chart with id "${id}"`, 404);
    const sel = `.chart[data-chart="${id}"]`;
    const image = await page.locator(sel).screenshot({ type: 'png' });
    const context = await page
      .locator(`.block:has(${sel}), .band:has(${sel})`)
      .first()
      .screenshot({ type: 'png', scale: 'css' });
    const lint = (await page.evaluate((s) => (window as any).lintChart(s), sel)) as {
      issues: Issue[];
    };
    const roles = new Set<string>();
    for (const l of chart.spec.layer) {
      if (typeof l.color === 'string') roles.add(l.color);
      else if (l.color?.map) Object.values(l.color.map).forEach((r) => roles.add(String(r)));
    }
    const neutral = [...roles].filter((r) => r in ROLES && r !== 'result' && r !== 'warn');
    if (neutral.length > 2)
      lint.issues.push({
        level: 'warning',
        message: `${neutral.length} neutral colour roles; keep the chart mostly ink and grey`,
      });
    if (chart.spec.layer.length > 5)
      lint.issues.push({
        level: 'warning',
        message: `${chart.spec.layer.length} layers; check every layer earns its place`,
      });
    return {
      id,
      section: chart.section,
      message: chart.spec.message,
      ...sizes[id],
      image,
      context,
      issues: lint.issues,
    };
  }
}
