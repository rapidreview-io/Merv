import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { BrowserService } from '@merv/browser';
import { browserTools } from '@merv/browser/tools';
import { challenged, closedAddress, guard, outlineOf, pageLines, secretField } from '@merv/browser/guard';
import { createApp } from '../src/app.js';
import { openState } from './fixtures/state.js';

const CHROME = process.env.MERV_TEST_CHROME ?? chromium.executablePath();
const publicHost = guard([], async () => ['93.184.216.34']);

test('the guard refuses every form of a private address', async () => {
  for (const address of [
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://2852039166/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://100.64.0.1/',
    'http://localhost:3000/',
    'http://a.localhost/',
    'http://metadata.google.internal/',
    'http://intranet/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'http://user:pw@example.com/',
  ])
    assert.ok(await publicHost(address), address);
  assert.equal(await publicHost('https://example.com/a'), undefined);
  assert.equal(await publicHost('data:text/plain,x'), undefined);
  const resolvesPrivate = guard([], async () => ['93.184.216.34', '10.0.0.1']);
  assert.ok(await resolvesPrivate('https://rebind.example.com/'), 'any private answer refuses');
  const own = guard(['board.example.com'], async () => ['93.184.216.34']);
  assert.ok(await own('https://board.example.com/'));
  assert.ok(await own('https://api.board.example.com/'));
  assert.equal(await own('https://notboard.example.com/'), undefined);
  assert.ok(closedAddress('not an address'));
  assert.ok(!closedAddress('2606:4700::1111'));
});

test('secret fields, blocked pages and the outline', () => {
  const field = (over: object) => ({ tag: 'input', type: 'text', autocomplete: '', words: '', ...over });
  for (const over of [
    { type: 'password' },
    { autocomplete: 'cc-number' },
    { autocomplete: 'current-password' },
    { words: 'card number' },
    { words: 'cvc' },
    { words: 'user_password' },
  ])
    assert.ok(secretField(field(over)), JSON.stringify(over));
  assert.ok(!secretField(field({ words: 'Search Wikipedia q' })));
  assert.ok(challenged('Just a moment...', ''));
  assert.ok(challenged('reddit', "You've been blocked by network security."));
  assert.ok(challenged('', '', 403));
  assert.ok(challenged('', '', 429));
  assert.ok(!challenged('World model', 'A world model is', 200));
  const lines = pageLines(
    '- generic [ref=e1]:\n  - heading "A" [level=1] [ref=e2]\n  - link "B" [ref=e3] [cursor=pointer]:\n    - /url: https://x\n  - generic [ref=e4]',
  );
  assert.deepEqual(lines, ['- heading "A" [level=1] [ref=e2]', '- link "B" [ref=e3]']);
  assert.ok(outlineOf(Array(900).fill('- text: hello there world')).cut);
});

test('with no endpoint the app has no browser tool and no words of it', async (t) => {
  const url = process.env.MERV_BROWSER_CDP_URL;
  t.after(() => void (process.env.MERV_BROWSER_CDP_URL = url));
  for (const name of ['MERV_BROWSER_CDP_URL', 'MERV_BROWSER_RENDER_TOKEN']) delete process.env[name];
  const state = await openState(mkdtempSync(join(tmpdir(), 'merv-browser-')));
  t.after(() => state.close());
  assert.equal(new BrowserService({}, state).enabled, false);
  process.env.MERV_BROWSER_RENDER_ACCOUNT = 'only-half';
  assert.equal(new BrowserService({}, state).enabled, false);
  delete process.env.MERV_BROWSER_RENDER_ACCOUNT;
  const plugin = (await import('@merv/browser/tools')).default;
  let registered = 0;
  plugin.apply({
    browser: { enabled: false },
    effect: () => (registered += 1),
    tools: {},
  } as never);
  assert.equal(registered, 0);
});

let chrome: ChildProcess;
let port = 0;
const profile = mkdtempSync(join(tmpdir(), 'merv-browser-chrome-'));
const hits: string[] = [];
const page = `<title>Test page</title><h1>Hello there</h1>
<a href="/second">Second page</a>
<a href="/second" target="_blank">New window</a>
<a href="/redirect">Redirecting link</a>
<input aria-label="Search" id="q"><input aria-label="Secret" type="password" id="pw">
<input aria-label="Number on it" autocomplete="cc-number"><input aria-label="Upload" type="file">
<button onclick="document.title=document.getElementById('q').value">Go</button>
<img src="http://127.0.0.1:PORT/secret.png"><div style="height:3000px;background:#eee" id="tall">Tall</div>`;
const site = createServer((req, res) => {
  hits.push(req.url!);
  if (req.url === '/redirect') {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
    return res.end();
  }
  if (req.url === '/forbidden') {
    res.writeHead(403);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(
    req.url === '/second'
      ? '<title>Second</title><h1>Second</h1>'
      : page.replace('PORT', String(port)),
  );
});
const caller = (actorId: string) => ({ actorId, projectId: 'p' });
let state: Awaited<ReturnType<typeof openState>>;
let service: BrowserService;
const fresh = (config = {}, addressOk: ((ip: string) => boolean) | undefined = () => true) =>
  new BrowserService(config, state, {
    // Only names ending .test count as public here; Chrome maps them to this server.
    guard: guard([], async () => ['93.184.216.34']),
    addressOk,
  });
const ref = (outline: string, text: string) =>
  new RegExp(`${text}[^\\n]*\\[ref=(\\w+)\\]`).exec(outline)![1]!;

before(async () => {
  await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
  port = (site.address() as AddressInfo).port;
  chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--host-resolver-rules=MAP public.test 127.0.0.1',
  ]);
  const url = await new Promise<string>((done, fail) => {
    let said = '';
    chrome.stderr!.on('data', (chunk) => {
      said += chunk;
      const found = /DevTools listening on (\S+)/.exec(said);
      if (found) done(found[1]!);
    });
    chrome.once('exit', () => fail(new Error(said)));
  });
  process.env.MERV_BROWSER_CDP_URL = url;
  state = await openState(mkdtempSync(join(tmpdir(), 'merv-browser-')));
  service = fresh();
  await service.initialize();
});
after(async () => {
  await service.close();
  delete process.env.MERV_BROWSER_CDP_URL;
  await state.close();
  await new Promise((done) => {
    chrome.once('exit', done);
    chrome.kill('SIGKILL');
  });
  site.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const at = (path: string) => `http://public.test:${port}${path}`;

test('a real Chrome: open, find, act, look, popups', async () => {
  const me = caller('a');
  const opened = await service.open(me, at('/'));
  assert.equal(opened.title, 'Test page');
  assert.match(opened.outline, /heading "Hello there"/);
  assert.ok(!hits.includes('/secret.png'), 'a private subresource is never requested');
  const { matches } = await service.find(me, 'second');
  assert.ok(matches.some((line) => /link "Second page"/.test(line)));
  const typed = await service.act(
    me,
    [
      { type: { ref: ref(opened.outline, 'textbox "Search"'), text: 'world model' } },
      { click: ref(opened.outline, 'button "Go"') },
      { scroll: { dy: 200 } },
    ],
    () => undefined,
  );
  assert.equal(typed.done, 3);
  assert.equal(typed.title, 'world model');
  const looked = await service.look(me);
  assert.deepEqual([looked.width, looked.height], [1200, 750]);
  assert.equal(looked.bytes.subarray(0, 2).toString('hex'), 'ffd8');
  // A new window opens in the one window there is.
  const again = await service.open(me, at('/'));
  await service.act(me, [{ click: ref(again.outline, 'link "New window"') }, { wait: 1000 }], () => undefined);
  assert.equal((await service.find(me, 'second')).title, 'Second');
  const full = await service.shot(me, { full: true });
  assert.ok(full.bytes.length < 2 * 1024 ** 2);
  await service.closeFor('a');
});

test('a real Chrome: secret and file fields are refused, in code', async () => {
  const me = caller('b');
  const { outline } = await service.open(me, at('/'));
  for (const [name, why] of [
    ['textbox "Secret"', /Password and payment/],
    ['textbox "Number on it"', /Password and payment/],
  ] as const) {
    const answer = await service.act(
      me,
      [{ type: { ref: ref(outline, name), text: 'hunter2' } }, { wait: 1 }],
      () => undefined,
    );
    assert.equal(answer.done, 0, 'it stops at the first failure');
    assert.match(answer.failed!.error, why);
  }
  const press = await service.act(me, [{ press: 'a' }], () => undefined);
  assert.match(press.failed!.error, /named keys/);
  await service.closeFor('b');
});

test('a real Chrome: a redirect to a private address never reaches it', async () => {
  const me = caller('c');
  hits.length = 0;
  await assert.rejects(service.open(me, at('/redirect')), /does not open a private address/);
  assert.deepEqual(hits, ['/redirect'], 'the hop to /secret was not requested');
  const blocked = await service.open(me, at('/forbidden'));
  assert.ok(blocked.blocked, '403 is blocked');
  await assert.rejects(service.shot(me, {}), /challenge/);
  await service.closeFor('c');
});

test('a real Chrome: a host that answers privately after the check is left', async () => {
  const strict = fresh({}, (ip) => !closedAddress(ip));
  await assert.rejects(strict.open(caller('d'), at('/second')), /private address/);
  await strict.close();
});

test('budgets: a person, everyone, shots and sessions', async () => {
  const day = new Date().toISOString().slice(0, 10);
  const set = (actor: string, ms: number, shots = 0) =>
    state.transaction((tx) =>
      tx.run('INSERT INTO browser_usage(day,actor_id,ms,shots) VALUES(?,?,?,?)', day, actor, ms, shots),
    );
  await set('spent', 15 * 60_000);
  await assert.rejects(service.open(caller('spent'), at('/')), /browser minutes used up/);
  await set('shooter', 0, 30);
  await service.open(caller('shooter'), at('/'));
  await assert.rejects(service.shot(caller('shooter'), {}), /screenshots used up/);
  await service.closeFor('shooter');
  const one = fresh({ sessions: 1 });
  await one.open(caller('e'), at('/second'));
  await assert.rejects(one.open(caller('f'), at('/second')), /Too many people/);
  await one.close();
  const everyone = fresh({ deploymentMinutesPerDay: 1 });
  await assert.rejects(everyone.open(caller('g'), at('/')), /used up for everyone/);
});

test('shot goes through artifact and draw under the caller, and stays on their boards', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-browser-app-'));
  const { readFileSync } = await import('node:fs');
  const { stateConfig } = await import('./fixtures/state.js');
  process.env.MERV_PI_MODEL_API_KEY = 'unused';
  const composition = JSON.parse(
    readFileSync(new URL('../config/board.json', import.meta.url), 'utf8'),
  );
  const app = await createApp({
    directory,
    config: {
      plugins: composition.plugins.map((entry: { id: string }) =>
        entry.id === 'state' ? { ...entry, config: stateConfig(directory) } : entry,
      ),
    },
    port: 0,
  });
  t.after(() => app.stop());
  const { ctx } = app;
  const person = await ctx.scope.credentials.bootstrap({ projectName: 'Mine', actorName: 'Me' });
  const me = { actorId: person.actor.id, projectId: person.project.id };
  const other = await ctx.scope.credentials.bootstrap({ projectName: 'Other', actorName: 'You' });
  const them = { actorId: other.actor.id, projectId: other.project.id };
  const { board } = (await ctx.tools.call('board.write:draw', me as never, {
    title: 'Pages',
    ops: [{ op: 'text', key: 'top', text: 'Top' }],
  })) as { board: { id: string } };
  // The registered tool needs a public page: this test's browser sees the guard's own world.
  const tool = browserTools(ctx, fresh());
  const open = tool.actions!.open!.handler as never as (c: unknown, i: unknown) => Promise<unknown>;
  const shot = tool.actions!.shot!.handler as never as (c: unknown, i: unknown) => Promise<{
    placed: Record<string, unknown>;
    url: string;
  }>;
  await open(them, { url: at('/second') });
  await assert.rejects(shot(them, { board: board.id }), /not|unknown|forbidden|access/i);
  await open(me, { url: at('/second') });
  const placed = await shot(me, { board: board.id, caption: 'From the test' });
  assert.ok(placed.placed.shot && placed.placed.source);
  const scene = (await ctx.tools.call('board.read:get', me as never, { board: board.id })) as object;
  assert.match(JSON.stringify(scene), /public\.test/);
});
