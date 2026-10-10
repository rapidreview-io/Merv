import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Caller } from '@merv/contracts';
import { describeScreen, renderScreen, scaleFor } from '../packages/pi/src/screen.js';
import type { PiSnapshot } from '../packages/pi/src/types.js';
import { fixture } from './fixtures/pi.js';

const config = {
  url: 'https://render.example/accounts/{account}/browser-run/screenshot',
  tokenEnv: 'TEST_RENDER_TOKEN',
  accountEnv: 'TEST_RENDER_ACCOUNT',
};

test('a screen is drawn no finer than a vision model reads: its shorter side at most 768 px', () => {
  assert.equal(scaleFor(1280, 800), 0.96);
  assert.equal(scaleFor(2560, 1440), 768 / 1440);
  assert.equal(scaleFor(700, 600), 1, 'a small window is never enlarged');
});

test('the snapshot is drawn by the headless browser at the window size, as a JPEG', async (t) => {
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
    delete process.env.TEST_RENDER_TOKEN;
    delete process.env.TEST_RENDER_ACCOUNT;
  });
  await assert.rejects(
    renderScreen(config, { path: '/ui', html: '<p>', width: 1280, height: 800 }),
    /not set up/,
  );
  process.env.TEST_RENDER_TOKEN = 'cf-test';
  process.env.TEST_RENDER_ACCOUNT = 'acct';
  let sent: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent = { url, init };
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      headers: { 'content-type': 'image/jpeg' },
    });
  }) as typeof fetch;
  const picture = await renderScreen(config, {
    path: '/ui/work',
    html: '<html>x</html>',
    width: 1280,
    height: 800,
  });
  assert.deepEqual([...picture], [0xff, 0xd8, 0xff]);
  assert.equal(sent!.url, 'https://render.example/accounts/acct/browser-run/screenshot');
  assert.equal((sent!.init.headers as Record<string, string>).authorization, 'Bearer cf-test');
  const body = JSON.parse(String(sent!.init.body));
  assert.equal(body.html, '<html>x</html>');
  assert.deepEqual(body.viewport, { width: 1280, height: 800, deviceScaleFactor: 0.96 });
  assert.equal(body.screenshotOptions.type, 'jpeg');
  assert.match(body.addScriptTag[0].content, /data-merv-scroll/, 'scroll offsets are put back');
});

test('the conversation model reads the picture and answers the question in words', async (t) => {
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  let body: {
    model: string;
    input: { content: { type: string; text?: string; image_url?: string }[] }[];
  };
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'The Files page.' }] }],
        usage: { input_tokens: 1200, output_tokens: 20 },
      }),
    );
  }) as typeof fetch;
  const read = await describeScreen(
    'sk',
    'gpt-6.1-sol',
    'Which page?',
    Buffer.from('jpg'),
    '/ui/artifacts',
  );
  assert.deepEqual(read, { text: 'The Files page.', tokens: 1220 });
  assert.equal(body!.model, 'gpt-6.1-sol');
  const [prompt, image] = body!.input[0]!.content;
  assert.match(prompt!.text!, /\/ui\/artifacts/);
  assert.match(prompt!.text!, /Which page\?/);
  assert.equal(image!.image_url, `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`);
});

test("the agent puts a record on the person's screen: their page goes there and says where", async (t) => {
  const f = await fixture(t);
  const { work, input } = await f.begun(f.operator);
  const agent: Caller = {
    ...f.operator,
    conversation: {
      id: input.conversationId,
      commandId: input.commandId,
      runtimeId: work.command.runtimeId,
      epoch: work.command.epoch,
    },
  };
  const id = input.conversationId;
  await assert.rejects(f.pi.show(f.operator, { page: 'Work' }), /own agent/);
  await assert.rejects(f.pi.show(agent, {}), /one record or one page/);
  const shown = f.pi.show(agent, { record: 'art_1' });
  let asked: PiSnapshot['screen'];
  while (!(asked = (await f.pi.snapshot(f.operator, id)).screen))
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(asked.show, { record: 'art_1' });
  const answer = {
    id,
    askId: asked.id,
    opened: { path: '/artifacts/art_1', title: 'Results.md' },
  };
  await f.pi.screen(f.operator, answer);
  assert.deepEqual(await shown, { opened: '/artifacts/art_1', title: 'Results.md' });
  assert.equal((await f.pi.snapshot(f.operator, id)).screen, undefined, 'the ask is over');
  await assert.rejects(f.pi.screen(f.operator, answer), /no longer waiting/);
});

test('a record that draws itself is looked at as drawn, asking no page of the person', async (t) => {
  const f = await fixture(t);
  const { work, input } = await f.begun(f.operator);
  const agent: Caller = {
    ...f.operator,
    conversation: {
      id: input.conversationId,
      commandId: input.commandId,
      runtimeId: work.command.runtimeId,
      epoch: work.command.epoch,
    },
  };
  const drawn: unknown[] = [];
  t.after(
    f.tools.contributePicture('board_', async (_caller, id, focus) => {
      drawn.push([id, focus]);
      return { html: '<svg>board</svg>', width: 800, height: 600, path: `/ui/boards/${id}` };
    }),
  );
  const env = {
    MERV_BROWSER_RENDER_TOKEN: 'cf',
    MERV_BROWSER_RENDER_ACCOUNT: 'acct',
    MERV_PI_MODEL_API_KEY: 'sk',
  };
  Object.assign(process.env, env);
  const real = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push(String(url));
    if (String(url).includes('browser-run'))
      return new Response(new Uint8Array([0xff, 0xd8]), {
        headers: { 'content-type': 'image/jpeg' },
      });
    return new Response(
      JSON.stringify({
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Handwritten: data → objective.' }],
          },
        ],
      }),
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
    for (const key of Object.keys(env)) delete process.env[key];
  });
  const seen = await f.pi.look(agent, {
    question: 'Read it',
    at: { record: 'board_1', focus: 'frame_9' },
  });
  assert.deepEqual(seen, { page: '/ui/boards/board_1', seen: 'Handwritten: data → objective.' });
  assert.deepEqual(drawn, [['board_1', 'frame_9']]);
  assert.equal(
    (await f.pi.snapshot(f.operator, input.conversationId)).screen,
    undefined,
    'no page was asked',
  );
  assert.equal(sent.length, 2, 'drawn once, read once');
});
