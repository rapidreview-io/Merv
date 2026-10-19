import { chromium, type Browser } from 'playwright-core';
import { check } from '@merv/contracts';
import type { Region, View } from '@merv/contracts/board-view';

/** Decode private raster references offline. Only bounded JPEG pixels leave this renderer. */
export class ArtifactPicture {
  private browser?: Promise<Browser>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly executablePath?: string) {}
  async close() {
    await (await this.browser?.catch(() => undefined))?.close();
  }
  render(data: string, mime: string, view?: View) {
    const run = this.queue.then(() => this.draw(data, mime, view));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async draw(data: string, mime: string, view?: View) {
    check(
      ['image/jpeg', 'image/png', 'image/webp'].includes(mime),
      'artifact_picture_type',
      'Only JPEG, PNG and WebP references can be viewed',
    );
    this.browser ??= chromium
      .launch({
        executablePath: this.executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      .catch((e) => {
        this.browser = undefined;
        throw e;
      });
    const page = await (await this.browser).newPage();
    const deadline = setTimeout(() => void page.close().catch(() => undefined), 30000);
    try {
      await page.route('**/*', (route) => route.abort());
      await page.setContent('<html><body></body></html>');
      const source = await page.evaluate(
        async ({ data, mime }) => {
          const im = new Image();
          im.src = `data:${mime};base64,${data}`;
          await im.decode();
          (window as any).reference = im;
          return { width: im.naturalWidth, height: im.naturalHeight };
        },
        { data, mime },
      );
      check(
        source.width * source.height <= 80_000_000,
        'artifact_picture_size',
        'Reference exceeds 80 megapixels',
      );
      const viewport: Region =
        view?.action === 'region'
          ? { x: view.x, y: view.y, width: view.width, height: view.height }
          : { x: 0, y: 0, width: source.width, height: source.height };
      check(
        !view || ['fit', 'region'].includes(view.action),
        'artifact_picture_view',
        'Image references support fit or region, in source pixel coordinates',
      );
      const result = await page.evaluate(
        ({ viewport }) => {
          const scale = Math.min(1, 1600 / Math.max(viewport.width, viewport.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(viewport.width * scale));
          c.height = Math.max(1, Math.round(viewport.height * scale));
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
          let url = c.toDataURL('image/jpeg', 0.85);
          for (const quality of [0.7, 0.5, 0.3]) {
            if (url.length <= 650000) break;
            url = c.toDataURL('image/jpeg', quality);
          }
          return { data: url.split(',')[1]!, width: c.width, height: c.height };
        },
        { viewport },
      );
      check(
        result.data.length <= 700000,
        'artifact_picture_size',
        'Use a smaller reference region',
      );
      return {
        image: { data: result.data, mimeType: 'image/jpeg' as const },
        viewport,
        width: result.width,
        height: result.height,
        source,
      };
    } finally {
      clearTimeout(deadline);
      await page.close();
    }
  }
}
