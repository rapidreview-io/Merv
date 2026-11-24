import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { MervError, type Caller } from '@merv/contracts';
import type { Region, View } from '@merv/contracts/board-view';
import { boardCamera as camera } from '@merv/contracts';
import type { BoardElement } from './models.js';
import type { Board } from './types.js';
import { fontRangeMatcher } from './font-ranges.js';

/** The images a view shows, as Excalidraw takes them, and what brings them for that view. */
type Files = Record<string, { id: string; mimeType: string; dataURL: string; created: number }>;
type ImagesFor = (viewport: Region, signal?: AbortSignal) => Promise<Files>;
type Font = { data: string; range?: string; family: string };
export type Rendered<T extends string> = {
  image: { data: string; mimeType: T };
  viewport: Region;
  width: number;
  height: number;
};

/** Load only pictures in the view, under the same membership as the board. */
export const boardImages =
  (board: Pick<Board, 'image'>, caller: Caller, elements: BoardElement[]): ImagesFor =>
  async (area, signal) => {
    const files: Files = {};
    let room = 32 * 1024 * 1024;
    for (const { fileId, x, y, width, height } of elements) {
      if (signal?.aborted) break;
      // By its widest reach, so a turned image in the view is not missed.
      const reach = Math.hypot(width, height);
      const seen =
        x - reach < area.x + area.width &&
        y - reach < area.y + area.height &&
        x + reach > area.x &&
        y + reach > area.y;
      if (typeof fileId !== 'string' || files[fileId] || !seen) continue;
      const image = await board.image(caller, fileId).catch(() => undefined);
      if (signal?.aborted) break;
      if (!image) continue;
      if (image.content.length > room) break;
      room -= image.content.length;
      const dataURL = `data:${image.mediaType};base64,${image.content.toString('base64')}`;
      files[fileId] = { id: fileId, mimeType: image.mediaType, dataURL, created: 0 };
    }
    return files;
  };

/** One offline browser, serial exports, and isolated pages. No board data leaves the server. */
export class BoardRenderer {
  private browser?: Promise<Browser>;
  // Build assets are immutable for this renderer's lifetime; pages still own all scene data.
  private fonts?: Font[];
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private active?: AbortController;
  private readonly retiring = new Set<Promise<void>>();
  constructor(
    private readonly executablePath?: string,
    // Large boards need time for bounded image conversion and vector export;
    // retain a hard deadline for a stalled browser.
    private readonly timeoutMs = 60000,
  ) {}
  async close() {
    this.closed = true;
    this.fonts = undefined;
    // Playwright 1.57 supervises this private-pipe process: close force-kills after 30s.
    await (await this.browser?.catch(() => undefined))?.close();
    await Promise.all(this.retiring);
  }
  render(
    elements: BoardElement[],
    current?: Region,
    view?: View,
    focus?: string,
    images?: ImagesFor,
    pngLimit?: undefined,
    paper?: string,
    theme?: 'light' | 'dark',
  ): Promise<Rendered<'image/jpeg'>>;
  render(
    elements: BoardElement[],
    current: Region | undefined,
    view: View | undefined,
    focus: string | undefined,
    images: ImagesFor | undefined,
    pngLimit: number,
    paper?: string,
    theme?: 'light' | 'dark',
  ): Promise<Rendered<'image/png'>>;
  render(
    elements: BoardElement[],
    current?: Region,
    view?: View,
    focus?: string,
    images?: ImagesFor,
    pngLimit?: number,
    /** The board's paper, when it wears a look; white otherwise. */
    paper?: string,
    theme?: 'light' | 'dark',
  ) {
    // Queue time consumes the same budget: a burst cannot add one full timeout per export.
    const deadline = Date.now() + this.timeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new MervError(
          'board_render_timeout',
          'Drawing this board took too long; try a smaller region',
          504,
        );
        controller.abort(error);
        if (this.active === controller) {
          this.active = undefined;
          const retired = this.browser;
          this.browser = undefined;
          // Retire the stalled transport; its late continuations see the aborted signal.
          if (retired) {
            const closing = retired.then((browser) => browser.close()).catch(() => {});
            this.retiring.add(closing);
            void closing.then(() => this.retiring.delete(closing));
          }
        }
        reject(error);
      }, this.timeoutMs);
    });
    const run = this.queue.then(async () => {
      controller.signal.throwIfAborted();
      if (deadline - Date.now() < Math.min(10_000, this.timeoutMs / 2))
        throw new MervError(
          'board_render_timeout',
          'Drawing this board took too long; try a smaller region',
          504,
        );
      this.active = controller;
      try {
        return await this.renderNow(
          elements,
          current,
          view,
          focus,
          images,
          pngLimit,
          paper,
          theme,
          deadline,
          controller,
        );
      } finally {
        if (this.active === controller) this.active = undefined;
      }
    });
    // Include queueing, browser setup and page cleanup; expired entries release their scenes.
    const result = Promise.race([run, timeout]).finally(() => {
      clearTimeout(timer);
      controller.abort();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private async renderNow(
    elements: BoardElement[],
    current?: Region,
    view?: View,
    focus?: string,
    images?: ImagesFor,
    pngLimit?: number,
    paper?: string,
    theme?: 'light' | 'dark',
    deadline = Date.now() + this.timeoutMs,
    controller = new AbortController(),
  ): Promise<Rendered<'image/jpeg' | 'image/png'>> {
    controller.signal.throwIfAborted();
    if (this.closed)
      throw new MervError('board_renderer_unavailable', 'Board renderer is stopping', 503);
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0)
        throw new MervError(
          'board_render_timeout',
          'Drawing this board took too long; try a smaller region',
          504,
        );
      return ms;
    };
    remaining();
    const allFonts: Font[] = (this.fonts ??= JSON.parse(
      readFileSync(new URL('../dist/fonts.json', import.meta.url), 'utf8'),
    ));
    // Retain every family and unrestricted face; only omit unicode subsets no export can use.
    // ASCII covers native text metrics, spacing, truncation and the default "Frame" label.
    const characters =
      Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') +
      '\u00A0\u200B\u25CC\uFFFD\n' +
      elements
        .flatMap((element) =>
          element.type === 'text'
            ? [String(element.text ?? ''), String(element.originalText ?? '')]
            : element.type === 'frame'
              ? [String(element.name ?? 'Frame')]
              : [],
        )
        .join('\n');
    const matches = fontRangeMatcher(characters);
    const fonts = allFonts.filter((font) => matches(font.range));
    // At most two browser processes may be alive, including stalled retirements.
    // Refuse recovery until one exits instead of creating another process per timeout.
    if (!this.browser && this.retiring.size >= 2)
      throw new MervError(
        'board_renderer_unavailable',
        'Board renderer is recovering; try again shortly',
        503,
      );
    const launched =
      this.browser ??
      chromium
        .launch({
          executablePath: this.executablePath,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          timeout: remaining(),
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        })
        .catch((error) => {
          if (this.browser === launched) this.browser = undefined;
          throw error;
        });
    this.browser = launched;
    const browser = await launched;
    controller.signal.throwIfAborted();
    if (!browser.isConnected()) {
      this.browser = undefined;
      return this.renderNow(
        elements,
        current,
        view,
        focus,
        images,
        pngLimit,
        paper,
        theme,
        deadline,
        controller,
      );
    }
    remaining();
    const page = await browser.newPage();
    const render = async () => {
      controller.signal.throwIfAborted();
      page.setDefaultTimeout(remaining());
      await page.route('**/*', (route) => route.abort());
      await page.setContent('<!doctype html><html><body></body></html>');
      await page.addScriptTag({
        path: fileURLToPath(new URL('../dist/renderer.js', import.meta.url)),
      });
      await page.evaluate(
        async ({ fonts, text, families }) => {
          for (const f of fonts) {
            const face = new FontFace(
              f.family,
              `url(data:font/woff2;base64,${f.data})`,
              f.range ? { unicodeRange: f.range } : {},
            );
            document.fonts.add(face);
          }
          await Promise.all(
            families.map((family: string) => document.fonts.load(`20px "${family}"`, text || 'A')),
          );
          await document.fonts.ready;
        },
        {
          fonts,
          families: [...new Set(allFonts.map((font) => font.family))],
          text: elements
            .map((e) => (e.type === 'text' ? e.text : e.type === 'frame' ? e.name : '') ?? '')
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
      controller.signal.throwIfAborted();
      const files = (await images?.(viewport, controller.signal)) ?? {};
      controller.signal.throwIfAborted();
      const mimeType: 'image/jpeg' | 'image/png' =
        pngLimit === undefined ? 'image/jpeg' : 'image/png';
      let scale = 1;
      const draw = async () =>
        (await page.evaluate(
          ({ elements, files, viewport, mimeType, scale, paper, theme }) =>
            (window as any).renderViewport({ elements, files }, viewport, {
              mimeType,
              scale,
              paper,
              theme,
            }),
          { elements: elements as unknown, files, viewport, mimeType, scale, paper, theme },
        )) as { bytes: number[]; pixels: { width: number; height: number } };
      let result = await draw();
      // Keep the whole drawing when a PNG is too large to hand to an agent.
      while (pngLimit !== undefined && result.bytes.length > pngLimit) {
        if (result.pixels.width === 1 && result.pixels.height === 1)
          throw new MervError('board_image_too_large', 'This drawing cannot fit in a command', 422);
        scale *= Math.min(0.75, Math.sqrt(pngLimit / result.bytes.length) * 0.9);
        result = await draw();
      }
      const data = Buffer.from(result.bytes).toString('base64');
      if (pngLimit === undefined && data.length > 700000)
        throw new MervError(
          'board_image_too_large',
          'Use a smaller region to inspect this board',
          422,
        );
      return {
        image: { data, mimeType },
        viewport,
        width: result.pixels.width,
        height: result.pixels.height,
      };
    };
    try {
      return await render();
    } finally {
      controller.abort();
      await page.close();
    }
  }
}
