import { chromium, type Browser } from 'playwright-core';
import { check } from '@merv/contracts';

/** One offline browser, serial pictures and isolated pages: it rasterises the chart's own SVG. */
export class MetricsRenderer {
  private browser?: Promise<Browser>;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  async close() {
    this.closed = true;
    await (await this.browser?.catch(() => undefined))?.close();
  }
  render(svg: string, width: number, height: number) {
    const run = this.queue.then(() => this.draw(svg, width, height));
    this.queue = run.catch(() => {});
    return run;
  }
  private async draw(
    svg: string,
    width: number,
    height: number,
  ): Promise<{ data: string; mimeType: 'image/jpeg' }> {
    check(!this.closed, 'metrics_unavailable', 'Metrics renderer is stopping', 503);
    this.browser ??= chromium
      .launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      .catch((error) => {
        this.browser = undefined;
        throw error;
      });
    const browser = await this.browser;
    if (!browser.isConnected()) {
      this.browser = undefined;
      return this.draw(svg, width, height);
    }
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      page.setDefaultTimeout(30000);
      await page.route('**/*', (route) => route.abort());
      await page.setContent(`<!doctype html><body style="margin:0">${svg}</body>`);
      const bytes = await page.screenshot({ type: 'jpeg', quality: 85 });
      check(
        bytes.length <= 700000,
        'metrics_too_large',
        'Use a metric filter for this picture',
        422,
      );
      return { data: bytes.toString('base64'), mimeType: 'image/jpeg' };
    } finally {
      await page.close();
    }
  }
}
