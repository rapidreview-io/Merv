#!/usr/bin/env node
/**
 * Walks the running demo as a person and records it: `node scripts/demo-command-center-walk.mjs OUT`.
 * Start `npm run demo:command-center` first; its connector's process id comes from there.
 * Sketch, Pi distils, edit a check by hand, hand one task to Claude Code and one to Codex, watch
 * their state and verdicts land, then lose the machine: what a phone sees, and hand off from it.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const demo = JSON.parse(
  readFileSync(
    join(process.env.TMPDIR ?? tmpdir(), `board-demo-${process.env.PORT ?? 3210}.json`),
    'utf8',
  ),
);
const cache = join(homedir(), 'Library/Caches/ms-playwright/chromium-1200');
const executablePath = [
  join(
    cache,
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
  join(cache, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
].find((path) => {
  try {
    readFileSync(path, { length: 1 });
    return true;
  } catch {
    return false;
  }
});
const say = (...words) => console.log(new Date().toISOString().slice(11, 19), ...words);
const state = async () => {
  const response = await fetch(`${demo.url}/tools/board.agents.state`, {
    method: 'POST',
    headers: { authorization: `Bearer ${demo.operator}`, 'content-type': 'application/json' },
    body: JSON.stringify({ board: demo.board }),
  });
  return (await response.json()).result;
};
const until = async (test, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const now = await state();
    if (test(now)) return now;
    if (Date.now() > end)
      throw new Error(`timed out: ${what}: ${JSON.stringify(now).slice(0, 600)}`);
    await new Promise((done) => setTimeout(done, 1500));
  }
};
const over = (run) => run && ['passed', 'failed', 'stopped', 'error'].includes(run.state);

const browser = await chromium.launch({ executablePath, headless: true });
async function person({ width, height, video, phone }) {
  const context = await browser.newContext({
    viewport: { width, height },
    ...(video && { recordVideo: { dir: out, size: { width, height } } }),
    ...(phone && { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }),
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('merv:theme', 'light');
    } catch {}
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => say('pageerror', error.message));
  await page.goto(`${demo.url}/ui/boards`, { waitUntil: 'domcontentloaded' });
  await page
    .getByLabel(/bearer credential/i)
    .first()
    .fill(demo.operator);
  await page.getByRole('button', { name: /^continue$/i }).click();
  await page
    .getByRole('button', { name: 'Skip' })
    .click({ timeout: 8000 })
    .catch(() => {});
  await page.goto(`${demo.url}/ui/boards/${demo.board}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.board-agents-pill').waitFor({ timeout: 20000 });
  await page
    .getByRole('button', { name: 'Skip' })
    .click({ timeout: 2500 })
    .catch(() => {});
  return { context, page };
}
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const fit = async (page) => {
  await page
    .locator('.board-canvas canvas')
    .last()
    .click({ position: { x: 12, y: 300 }, force: true })
    .catch(() => {});
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(900);
};

/** Where a shape stands on the screen, by the canvas's own scroll and zoom. */
const screenOf = (page, id) =>
  page.evaluate((target) => {
    const api = window.boardApi;
    const el = api.getSceneElements().find((held) => held.id === target);
    const { scrollX, scrollY, zoom, offsetLeft, offsetTop } = api.getAppState();
    return {
      x: (el.x + el.width / 2 + scrollX) * zoom.value + offsetLeft,
      y: (el.y + el.height / 2 + scrollY) * zoom.value + offsetTop,
    };
  }, id);
/** Brings these shapes, and what stands under them, up to fill the screen. */
const closeUp = async (page, ids) => {
  await page.evaluate((wanted) => {
    const api = window.boardApi;
    const frames = api.getSceneElements().filter((el) => wanted.includes(el.id));
    const left = Math.min(...frames.map((el) => el.x));
    const right = Math.max(...frames.map((el) => el.x + el.width));
    const top = Math.min(...frames.map((el) => el.y));
    const near = api
      .getSceneElements()
      .filter((el) => el.x >= left - 10 && el.x + el.width <= right + 10 && el.y >= top - 40);
    api.scrollToContent(near, { fitToViewport: true, viewportZoomFactor: 0.82, animate: false });
  }, ids);
  await page.waitForTimeout(600);
};
/** Until Pi has stopped drawing and nothing it drew is held back on this page. */
const settled = async (page) => {
  let [count, since] = [-1, Date.now()];
  while (Date.now() - since < 12_000) {
    const now = (await state()).tasks.length;
    if (now !== count) [count, since] = [now, Date.now()];
    await page.waitForTimeout(1000);
  }
  await page
    .locator('.board-status')
    .waitFor({ state: 'hidden', timeout: 90_000 })
    .catch(() => {});
};

const { context, page } = await person({ width: 1440, height: 900, video: true });
try {
  await page.waitForTimeout(1500);
  await fit(page);
  await shot(page, '01-sketch');
  say('sketch');

  await page.locator('.board-agents-pill').click();
  await page.getByRole('button', { name: 'Make tasks from this board' }).click();
  say('asked Pi to distil');
  await page.waitForTimeout(800);
  await page.locator('.board-agents-pill').click();
  await until((now) => now.tasks.length >= 2, 240_000, 'tasks');
  await settled(page);
  say(
    'tasks',
    JSON.stringify(
      (await state()).tasks.map((task) => [task.title, task.checks.map((one) => one.text)]),
    ),
  );
  const made = await state();
  await fit(page);
  await shot(page, '02-distilled');

  // A person rewrites one of Pi's checks, in place, as any note.
  const sentence =
    made.tasks[0].checks.find((one) => !one.text.includes('`')) ?? made.tasks[0].checks.at(-1);
  const spot = await screenOf(page, sentence.id);
  await page.mouse.dblclick(spot.x, spot.y);
  const typing = page.locator('.excalidraw-textEditorContainer textarea');
  await typing.waitFor({ timeout: 5000 });
  await typing.fill('The sparkline fits one 80-column line, however long the log is');
  await page.waitForTimeout(600);
  await shot(page, '03-editing-a-check');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await until(
    (now) => now.tasks[0].checks.some((one) => one.text.includes('80-column')),
    15_000,
    'edit saved',
  );
  say('edited a check by hand');
  await page.locator('.board-agents-pill').click();
  await page.locator('.board-agents-pane').waitFor();
  await shot(page, '03-tasks-pane');
  const ways = page.locator('.board-agents-task');
  await ways.nth(0).getByRole('button', { name: 'Claude Code', exact: true }).click();
  say('handed task 1 to Claude Code');
  await page.waitForTimeout(1200);
  await ways.nth(1).getByRole('button', { name: 'Codex', exact: true }).click();
  say('handed task 2 to Codex');
  await page.waitForTimeout(1500);
  await page.locator('.board-agents-pill').click();
  const running = await state();
  const pair = running.tasks.slice(0, 2).map((task) => task.frame);
  await closeUp(page, pair);
  await page.waitForTimeout(12_000);
  await shot(page, '04-running');
  const done = await until(
    (now) => now.tasks.slice(0, 2).every((task) => over(task.latest)),
    540_000,
    'runs',
  );
  say(
    'runs',
    JSON.stringify(done.tasks.map((task) => [task.title, task.said, task.latest?.verdicts])),
  );
  await page.waitForTimeout(3000);
  await closeUp(page, pair);
  await shot(page, '05-results');
  await page.waitForTimeout(2500);
  await fit(page);
  await shot(page, '05-results-whole');
  await page.locator('.board-agents-pill').click();
  await page.waitForTimeout(600);
  await shot(page, '06-results-pane');
  await page.locator('.board-agents-pill').click();
} finally {
  await page.waitForTimeout(800);
  await context.close();
}

if (process.argv.includes('--no-phone')) {
  await browser.close();
  process.exit(0);
}
// The lid closes: the connector goes away, and only then does a phone look.
const connector = execSync(`pgrep -f 'clients/board-connect/connect.mjs.*--server ${demo.url}'`, {
  encoding: 'utf8',
})
  .trim()
  .split('\n')[0];
process.kill(Number(connector));
say('connector stopped', connector);
await until((now) => !now.connector?.online, 30_000, 'offline');
const phone = await person({ width: 390, height: 844, phone: true, video: true });
await phone.page.waitForTimeout(1500);
await shot(phone.page, '07-phone-offline');
await phone.page.locator('.board-agents-pill').click();
await phone.page.locator('.board-agents-pane').waitFor();
await phone.page.waitForTimeout(500);
await shot(phone.page, '08-phone-tasks');
const third = (await state()).tasks.findIndex((task) => !task.latest);
const row = phone.page.locator('.board-agents-task').nth(third >= 0 ? third : 0);
await row.getByRole('button', { name: 'Claude Code', exact: true }).click();
await until((now) => now.waiting === 1, 15_000, 'queued');
await phone.page.waitForTimeout(3000);
await shot(phone.page, '09-phone-queued');
say('handed off from the phone, queued');
await phone.page.waitForTimeout(6000);
// The lid opens.
const back = spawn(
  'node',
  [
    join(root, '../clients/board-connect/connect.mjs'),
    '--server',
    demo.url,
    '--key',
    demo.operator,
    '--workspace',
    demo.workspace,
    '--name',
    'Mac',
    '--trust-checks',
  ],
  { stdio: 'inherit', detached: true },
);
back.unref();
say('connector back', back.pid);
const after = await until(
  (now) => now.waiting === 0 && now.tasks.every((task) => !task.latest || over(task.latest)),
  400_000,
  'queued run',
);
say('after', JSON.stringify(after.tasks.map((task) => [task.title, task.said])));
await phone.page.waitForTimeout(4000);
await shot(phone.page, '10-phone-done');
await phone.context.close();
await browser.close();
