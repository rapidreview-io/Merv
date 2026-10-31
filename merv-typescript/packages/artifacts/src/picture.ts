import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';
import { boardCamera, check, MervError } from '@merv/contracts';
import type { Region, View } from '@merv/contracts/board-view';

export const PDF = 'application/pdf';
/** The most text one read of a PDF answers, in characters. */
const MOST_TEXT = 64_000;
/** What the browser's processes may hold while a file is open. A PDF of a few MiB can unpack to
 *  many GiB, and much of that (buffers, decoders, canvases) no limit inside the page would count. */
const MOST_MEMORY = 2 * 1024 ** 3;
/** How much of memory a process holds, in bytes; none for one that has gone. */
const heldBy = (pid: number) =>
  (process.platform === 'linux'
    ? readFile(`/proc/${pid}/status`, 'utf8').then((text) => /^VmRSS:\s*(\d+)/m.exec(text)![1]!)
    : promisify(execFile)('ps', ['-o', 'rss=', '-p', String(pid)]).then(({ stdout }) => stdout)
  ).then(
    (kib) => Number(kib) * 1024,
    () => 0,
  );
/** A page may run scripts it was given, but no eval, and may fetch nothing. */
const BLANK = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; font-src data:; img-src data: blob:"></head><body></body></html>`;

/**
 * Decode private rasters and PDFs offline, one at a time in an isolated page. Only bounded JPEG
 * pixels and a PDF's text leave this renderer, and a PDF's scripts are never run (render/pdf.ts).
 */
export class ArtifactPicture {
  private browser?: Promise<Browser>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly executablePath?: string,
    private readonly timeoutMs = 30000,
    private readonly mostMemory = MOST_MEMORY,
  ) {}
  async close() {
    await (await this.browser?.catch(() => undefined))?.close();
  }
  render(data: string, mime: string, view?: View, pdfPage = 1) {
    return this.inTurn((page) => this.draw(page, data, mime, view, pdfPage));
  }
  /** Part of a PDF's text, by page: the pages asked for, or on to the first that has any. */
  text(data: string, first: number, count: number) {
    return this.inTurn(async (page) => {
      const pageCount = await this.opened(page, data, first);
      const read: {
        pages: { page: number; text: string; cut?: true }[];
        noText: number[];
        next?: number;
      } = await page.evaluate(
        ({ first, count, chars }) => (window as any).pdfText({ first, count, chars }),
        { first, count, chars: MOST_TEXT },
      );
      if (!read.pages.length) {
        const last = read.noText.at(-1)!;
        throw new MervError(
          'pdf_no_text',
          `Pages ${first}–${last} of ${pageCount} have no text: this PDF looks scanned or image-only. artifact.read look with page shows a page as an image${read.next ? `; text may start after page ${last}` : ''}.`,
          422,
          { noText: read.noText, pageCount, ...(read.next && { next: read.next }) },
        );
      }
      return { pageCount, ...read };
    });
  }
  private inTurn<T>(work: (page: Page) => Promise<T>) {
    const run = this.queue.then(() => this.inPage(work));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async inPage<T>(work: (page: Page) => Promise<T>): Promise<T> {
    this.browser ??= chromium
      .launch({
        executablePath: this.executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      .catch((e) => {
        this.browser = undefined;
        throw e;
      });
    const browser = await this.browser;
    if (!browser.isConnected()) {
      this.browser = undefined;
      return this.inPage(work);
    }
    const page = await browser.newPage();
    // Ended from out here, so a page stuck in a file's work or filling memory still ends.
    let ended: MervError | undefined;
    const end = (error: MervError) => {
      ended ??= error;
      void page.close().catch(() => undefined);
    };
    const deadline = setTimeout(
      () =>
        end(
          new MervError(
            'artifact_picture_timeout',
            'Reading this file took too long; try one page or a smaller region',
            504,
          ),
        ),
      this.timeoutMs,
    );
    const cdp = await browser.newBrowserCDPSession();
    const watch = setInterval(async () => {
      const { processInfo } = await cdp
        .send('SystemInfo.getProcessInfo')
        .catch(() => ({ processInfo: [] }));
      const sizes = await Promise.all(processInfo.map(({ id }) => heldBy(id)));
      if (sizes.reduce((sum, size) => sum + size, 0) > this.mostMemory)
        end(
          new MervError('artifact_picture_memory', 'This file takes too much memory to open', 422),
        );
    }, 200);
    try {
      await page.route('**/*', (route) => route.abort());
      await page.setContent(BLANK);
      return await work(page);
    } catch (error) {
      if (ended) throw ended;
      if (error instanceof MervError) throw error;
      // What a file did to the page (a crash, a decoder's failure) is the file's, not ours.
      throw new MervError(
        'artifact_picture_failed',
        'This file is damaged or too large to open',
        422,
      );
    } finally {
      clearTimeout(deadline);
      clearInterval(watch);
      await cdp.detach().catch(() => undefined);
      await page.close().catch(() => undefined);
    }
  }
  /** Opens a PDF on the page, or says why it cannot, and refuses a page it does not have. */
  private async opened(page: Page, data: string, number: number) {
    await page.addScriptTag({
      path: fileURLToPath(new URL('../dist/pdf.js', import.meta.url)),
    });
    const { failed, pageCount } = (await page.evaluate(
      (data) => (window as any).pdfOpen(data),
      data,
    )) as { failed?: string; pageCount: number };
    check(
      failed !== 'encrypted',
      'pdf_encrypted',
      'This PDF is encrypted and Merv has no password for it',
      422,
    );
    check(!failed, 'pdf_malformed', 'This file cannot be read as a PDF', 422);
    check(
      number <= pageCount,
      'pdf_page',
      `This PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}`,
    );
    return pageCount;
  }
  private async draw(page: Page, data: string, mime: string, view?: View, pdfPage = 1) {
    check(
      [PDF, 'image/jpeg', 'image/png', 'image/webp'].includes(mime),
      'artifact_picture_type',
      'Only JPEG, PNG, WebP and PDF files can be viewed',
    );
    const pageCount = mime === PDF ? await this.opened(page, data, pdfPage) : undefined;
    const source: { width: number; height: number } = await page.evaluate(
      async ({ data, mime, pdfPage }) => {
        if (mime === 'application/pdf') return await (window as any).pdfSize(pdfPage);
        const im = new Image();
        im.src = `data:${mime};base64,${data}`;
        await im.decode();
        (window as any).reference = im;
        return { width: im.naturalWidth, height: im.naturalHeight };
      },
      { data: pageCount ? '' : data, mime, pdfPage },
    );
    check(
      source.width * source.height <= 80_000_000,
      'artifact_picture_size',
      'Reference exceeds 80 megapixels',
    );
    const whole: Region = { x: 0, y: 0, ...source };
    const asked = !view || view.action === 'fit' ? whole : boardCamera(whole, whole, view);
    const [x, y] = [Math.max(0, asked.x), Math.max(0, asked.y)];
    const viewport: Region = {
      x,
      y,
      width: Math.min(source.width, asked.x + asked.width) - x,
      height: Math.min(source.height, asked.y + asked.height) - y,
    };
    check(
      viewport.width > 0 && viewport.height > 0,
      'artifact_picture_view',
      `That is outside this ${source.width}×${source.height} picture`,
    );
    const result = await page.evaluate(
      async ({ viewport, zoom }) => {
        const scale = Math.min(zoom, 1600 / Math.max(viewport.width, viewport.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(viewport.width * scale));
        c.height = Math.max(1, Math.round(viewport.height * scale));
        if ((window as any).pdfDraw) await (window as any).pdfDraw(c, viewport, scale);
        else {
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(
            (window as any).reference,
            viewport.x,
            viewport.y,
            viewport.width,
            viewport.height,
            0,
            0,
            c.width,
            c.height,
          );
        }
        let url = c.toDataURL('image/jpeg', 0.85);
        for (const quality of [0.7, 0.5, 0.3]) {
          if (url.length <= 650000) break;
          url = c.toDataURL('image/jpeg', quality);
        }
        return { data: url.split(',')[1]!, width: c.width, height: c.height };
      },
      // A close look at a page is drawn afresh, so it gains detail; a raster's has none to gain.
      { viewport, zoom: pageCount ? 4 : 1 },
    );
    check(result.data.length <= 700000, 'artifact_picture_size', 'Use a smaller reference region');
    return {
      image: { data: result.data, mimeType: 'image/jpeg' as const },
      viewport,
      width: result.width,
      height: result.height,
      source,
      ...(pageCount && { pdfPage, pageCount }),
    };
  }
}
