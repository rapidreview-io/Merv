/**
 * Screenshots of items' cards against a running demo (scripts/ui-demo.ts with
 * MERV_TRACKIO_PYTHON), in light and dark: the Work list, an item running, completed, failed and
 * without metrics, items on a board and the autoresearch timeline.
 *
 * Usage: node --import tsx scripts/ui-items-screens.ts <ui url> <operator token> <out dir>
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const [base, token, out = 'output/item-screens'] = process.argv.slice(2);
if (!base || !token)
  throw new Error('Usage: ui-items-screens.ts <ui url> <operator token> [out dir]');
const origin = new URL(base).origin;
const tool = async (name: string, input: Record<string, unknown> = {}) => {
  const response = await fetch(`${origin}/tools/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as { result?: any; error?: { message: string } };
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  return body.result;
};

const home = await tool('ui.home');
const experiment = (name: string) =>
  home.experiments.find((item: { name: string }) => item.name === name)?.id as string;
const task = (title: string) =>
  home.tasks.find((item: { title: string }) => item.title === title)?.id as string;
const boards = await tool('board.read', { action: 'list', list: {} });
const board = (Array.isArray(boards) ? boards : boards.boards).find(
  (item: { title: string }) => item.title === 'Grokking: what moves the step',
)?.id as string;

const shots: [name: string, path: string, wait?: (page: Page) => Promise<void>][] = [
  [
    'list',
    '/work',
    async (page) => {
      await page.getByRole('button', { name: /^All work/ }).click();
      await page.waitForSelector('.item-spark');
    },
  ],
  [
    'item-running',
    `/experiments/${experiment('decay-sensitivity-p113')}`,
    async (page) => void (await page.waitForSelector('.item-curve svg path')),
  ],
  [
    'item-completed',
    `/experiments/${experiment('decay-sweep-p97')}`,
    async (page) => void (await page.waitForSelector('.item-figure img')),
  ],
  [
    'item-failed',
    `/experiments/${experiment('lr-3e-3-stability')}`,
    async (page) => void (await page.waitForSelector('.item-figure img')),
  ],
  [
    'item-no-metrics',
    `/tasks/${task('Check training configuration')}`,
    async (page) => void (await page.waitForSelector('.item-summary')),
  ],
  [
    'board',
    `/boards/${board}`,
    async (page) =>
      void (await page.waitForSelector('.canvas-item .item-card', { timeout: 30000 })),
  ],
  [
    'autoresearch',
    '/autoresearch',
    async (page) => void (await page.waitForSelector('.autoresearch-timeline .wake-run')),
  ],
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const written: string[] = [];
try {
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      viewport: { width: 1360, height: 1000 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    await context.addInitScript((value) => localStorage.setItem('merv:theme', value), theme);
    const page = await context.newPage();
    await page.goto(`${base.replace(/\/$/, '')}/work`);
    await page.locator('input[type="password"]').fill(token);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForSelector('.work-page', { timeout: 30000 });
    // The first-run welcome is said once per person: skip it, as they would.
    const skip = page.locator('.board-welcome-skip');
    if (await skip.isVisible({ timeout: 4000 }).catch(() => false)) await skip.click();
    for (const [name, path, wait] of shots) {
      await page.goto(`${base.replace(/\/$/, '')}${path}`);
      await (wait?.(page) ?? page.waitForLoadState('networkidle'));
      await page.waitForTimeout(1500);
      const file = join(out, `${name}-${theme}.png`);
      await page.screenshot({ path: file, fullPage: name !== 'board' });
      written.push(file);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(written.join('\n'));
