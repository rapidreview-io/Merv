import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { MervError } from '@merv/contracts';
import { camera, type Region, type View } from '@merv/contracts/board-view';
import type { BoardElement } from './models.js';

/** One offline browser, serial exports, and isolated pages. No board data leaves the server. */
export class BoardRenderer {
  private browser?: Promise<Browser>;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    private readonly executablePath?: string,
    private readonly timeoutMs = 30000,
  ) {}
  async close() {
    this.closed = true;
    await (await this.browser?.catch(() => undefined))?.close();
  }
  render(elements: BoardElement[], current?: Region, view?: View, focus?: string) {
    const run = this.queue.then(() => this.renderNow(elements, current, view, focus));
    this.queue = run.catch(() => {});
    return run;
  }
  private async renderNow(
    elements: BoardElement[],
    current?: Region,
    view?: View,
    focus?: string,
  ): Promise<{
    image: { data: string; mimeType: 'image/jpeg' };
    viewport: Region;
    width: number;
    height: number;
  }> {
    if (this.closed)
      throw new MervError('board_renderer_unavailable', 'Board renderer is stopping', 503);
    this.browser ??= chromium
      .launch({
        executablePath: this.executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      .catch((error) => {
        this.browser = undefined;
        throw error;
      });
    const browser = await this.browser;
    if (!browser.isConnected()) {
      this.browser = undefined;
      return this.renderNow(elements, current, view, focus);
    }
    const page = await browser.newPage();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = async () => {
      page.setDefaultTimeout(this.timeoutMs);
      await page.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({
        path: fileURLToPath(new URL('../dist/renderer.js', import.meta.url)),
      });
      const fonts = JSON.parse(
        readFileSync(new URL('../dist/fonts.json', import.meta.url), 'utf8'),
      );
      await page.evaluate(
        async ({ fonts, text }) => {
          for (const f of fonts) {
            const face = new FontFace(
              f.family,
              `url(data:font/woff2;base64,${f.data})`,
              f.range ? { unicodeRange: f.range } : {},
            );
            document.fonts.add(face);
          }
          await Promise.all(
            [...new Set(fonts.map((f) => f.family))].map((family) =>
              document.fonts.load(`20px "${family}"`, text || 'A'),
            ),
          );
          await document.fonts.ready;
        },
        {
          fonts: fonts as { data: string; range?: string; family: string }[],
          text: elements
            .filter((e) => e.type === 'text')
            .map((e) => e.text ?? '')
            .join(''),
        },
      );
      const bounds = (await page.evaluate(
        ({ elements, focus }) => (window as any).sceneBounds({ elements }, focus),
        { elements: elements as unknown, focus },
      )) as Region | null;
      if (!bounds)
        throw new MervError('board_shape_not_found', `No shape "${focus}" on this board.`, 404);
      const viewport = camera(
        bounds,
        focus ? undefined : current,
        view ?? (focus ? { action: 'fit' } : undefined),
      );
      const result = (await page.evaluate(
        ({ elements, viewport }) => (window as any).renderViewport({ elements }, viewport),
        { elements: elements as unknown, viewport },
      )) as { bytes: number[]; pixels: { width: number; height: number } };
      const data = Buffer.from(result.bytes).toString('base64');
      if (data.length > 700000)
        throw new MervError(
          'board_image_too_large',
          'Use a smaller region to inspect this board',
          422,
        );
      return {
        image: { data, mimeType: 'image/jpeg' as const },
        viewport,
        width: result.pixels.width,
        height: result.pixels.height,
      };
    };
    try {
      return await Promise.race([
        render(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new MervError(
                  'board_render_timeout',
                  'Drawing this board took too long; try a smaller region',
                  504,
                ),
              ),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await page.close();
    }
  }
}
