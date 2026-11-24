import assert from 'node:assert/strict';
import test from 'node:test';
const browser = (path: string) => import(new URL(path, import.meta.url).href);
const { serve, unmount } = await browser('./ui-render.js');
const { PiVoiceBackend } = await browser('../packages/ui/web/views/pi-voice-backend.js');
const { DeskVoiceBackend } = await browser('../packages/ui/web/views/desk-voice-backend.js');
const { stopTarget } = await browser('../packages/ui/web/views/desk-voice.js');
const { setProject, setToken } = await browser('../packages/ui/web/api.js');

const output = () => {
  const said: { text: string; delegation: string }[] = [],
    speech: string[] = [],
    reported: string[] = [],
    progress: string[] = [];
  let current = true,
    drawing = false,
    queued = false,
    backs = 0,
    last = Date.now() - 10_000;
  const port = {
    current: () => current,
    drawing: () => drawing,
    state() {},
    problem() {},
    commentary: (text: string, delegation: string) => {
      said.push({ text, delegation });
    },
    // What the system says first is said too, at the person's pause (voice-lines.ts): here, at once.
    report: (text: string, delegation: string) => {
      said.push({ text, delegation });
      reported.push(text);
    },
    progress: (text: string) => {
      progress.push(text);
    },
    speak: (text: string) => {
      speech.push(text);
    },
    clear() {},
    finish() {},
    last: () => last,
    queued: () => queued,
    steer() {},
    back: () => {
      backs++;
    },
  };
  return {
    port,
    said,
    speech,
    reported,
    progress,
    leave: () => {
      current = false;
    },
    ink: (on: boolean) => {
      drawing = on;
    },
    waiting: (on: boolean) => {
      queued = on;
    },
    backs: () => backs,
    spoke: (at: number) => {
      last = at;
    },
  };
};
const snapshot = (id: string, done = false) => ({
  conversation: { id },
  stage: {},
  commands: done
    ? [
        {
          status: 'completed',
          messages: [
            { role: 'user', text: 'Draw this' },
            { role: 'assistant', text: 'It is done.' },
          ],
          outcomes: [],
        },
      ]
    : [],
});

test('Pi owns its pen wait and stops watching an away conversation after its answer or stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const out = output();
  let reads = 0,
    stops = 0;
  const pi = {
    selected: 'a',
    active: false,
    snapshot: snapshot('a'),
    send: async () => true,
    stop: async () => {
      stops++;
    },
    transport: {
      snapshot: async () => {
        reads++;
        return snapshot('a', true);
      },
    },
  };
  const backend = new PiVoiceBackend(() => pi as never, out.port);
  t.after(() => backend.close());
  await backend.send('Draw this', 'delegation');
  out.ink(true);
  pi.snapshot = snapshot('a', true);
  backend.watch();
  assert.equal(out.said.length, 0, 'the answer waits for the pen');
  pi.snapshot = snapshot('b');
  backend.watch();
  await Promise.resolve();
  assert.equal(reads, 1, 'leaving watches the original conversation');
  out.ink(false);
  t.mock.timers.tick(250);
  // The visible conversation is b; its next poll supplies a's completed turn.
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.deepEqual(out.said, [{ text: 'Result: It is done.', delegation: 'delegation' }]);
  const finished = reads;
  t.mock.timers.tick(10_000);
  assert.equal(reads, finished);
  pi.snapshot = snapshot('a');
  await backend.send('Draw this', 'again');
  pi.snapshot = snapshot('b');
  backend.watch();
  backend.stop();
  await Promise.resolve();
  const stopped = reads;
  t.mock.timers.tick(10_000);
  assert.equal(reads, stopped);
  assert.equal(stops, 1);
  assert.equal(out.said.length, 1);
});

test('Mac backend owns approval deduplication and drops a late read after the line closes', async (t) => {
  t.after(unmount);
  t.mock.timers.enable({ apis: ['setInterval'] });
  setToken('voice-backend');
  setProject('voice-backend');
  const out = output();
  let reads = 0,
    finish = false;
  serve('/desk/commands', { body: { command: 'command', state: 'completed' } });
  serve('/desk/voice', () => {
    reads++;
    return {
      body: {
        turn: finish
          ? { state: 'done', answer: 'Finished.' }
          : { state: 'working', asking: 'approval' },
      },
    };
  });
  const backend = new DeskVoiceBackend(
    { device: 'mac', thread: 'thread', provider: 'codex', title: 'Task', label: 'Folder' },
    out.port,
  );
  t.after(() => backend.close());
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  await backend.send('Draw this', 'request');
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(out.speech.length, 1, 'the same approval is said once');
  finish = true;
  t.mock.timers.tick(1000);
  out.leave();
  backend.close();
  await flush();
  assert.equal(out.said.length, 0, 'an old line cannot narrate into the new one');
  const closed = reads;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(reads, closed);
});

test("Mac backend's answer waits for the pen and the lines still to say, then comes last", async (t) => {
  t.after(unmount);
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  setToken('voice-wait');
  setProject('voice-wait');
  const out = output();
  serve('/desk/commands', { body: { command: 'command', state: 'completed' } });
  serve('/desk/voice', { body: { turn: { state: 'done', answer: 'Drawn.' } } });
  const backend = new DeskVoiceBackend(
    { device: 'mac', thread: 'thread', provider: 'claude', title: 'Task', label: 'Folder' },
    out.port,
  );
  t.after(() => backend.close());
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  out.ink(true);
  await backend.send('Draw this', 'request');
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(out.said.length, 0, 'the pen is still drawing');
  assert.equal(backend.voicing, 'Claude Code', 'its voice stays while the answer waits');
  out.ink(false);
  out.waiting(true);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(out.said.length, 0, 'a line is still to be said');
  out.waiting(false);
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(out.said, [{ text: 'Result: Drawn.', delegation: 'request' }]);
});

for (const ending of ['goodbye said', 'person speaks', 'stop', 'line closed'] as const)
  test(`a Mac agent's hand-back to Merv: ${ending}`, async (t) => {
    t.after(unmount);
    t.mock.timers.enable({ apis: ['setInterval'] });
    setToken('voice-back');
    setProject('voice-back');
    const out = output();
    let messages = 0;
    serve('/desk/commands', (_call: unknown, body: { kind: string }) => {
      if (body.kind === 'message') messages++;
      return { body: { command: 'command', state: 'completed' } };
    });
    serve('/desk/voice', {
      body: { turn: { state: 'done', steps: [], answer: 'Back to Merv. Bye.', back: true } },
    });
    const backend = new DeskVoiceBackend(
      { device: 'mac', thread: 'thread', provider: 'claude', title: 'Task', label: 'Folder' },
      out.port,
    );
    t.after(() => backend.close());
    const flush = async () => {
      for (let i = 0; i < 12; i++) await Promise.resolve();
    };
    await backend.send('Take me to Merv', 'request');
    await flush();
    assert.deepEqual(
      out.said.map((line) => line.text),
      ['Result: Back to Merv. Bye.'],
    );
    t.mock.timers.tick(1_000);
    await flush();
    assert.equal(out.backs(), 0, 'the goodbye is said before Merv has the voice');
    if (ending === 'goodbye said') {
      out.spoke(Date.now() - 2_000 + 1);
      out.spoke(Date.now() - 1_500);
      t.mock.timers.tick(250);
      assert.equal(out.backs(), 0, 'nothing said since the goodbye began');
      out.spoke(Date.now() + 1);
      t.mock.timers.tick(250);
      assert.equal(out.backs(), 0, 'still saying it');
      out.spoke(Date.now() - 1_500 + 2_000);
    }
    if (ending === 'person speaks') {
      await backend.send('one more thing', 'later');
      await flush();
      assert.equal(out.backs(), 1, 'words after a hand-back go to Merv, not the agent');
      assert.equal(messages, 1);
    }
    if (ending === 'stop') backend.stop();
    if (ending === 'line closed') out.leave();
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(
      out.backs(),
      ending === 'stop' || ending === 'line closed' ? 0 : 1,
      'the voice is handed back once, and never from a stopped or closed line',
    );
  });

test('voice stop distinguishes a delivered request, refusal, idle and uncertain delivery', async (t) => {
  t.after(unmount);
  setToken('stop-receipts');
  setProject('stop-receipts');
  const target = {
    device: 'mac',
    thread: 'thread',
    provider: 'codex' as const,
    title: 'Task',
    label: 'Folder',
  };
  const cases = [
    { state: 'completed', said: 'Asked Codex to stop.' },
    { state: 'accepted', said: 'Asked Codex to stop.' },
    { state: 'dispatched', said: 'Asked Codex to stop.' },
    {
      state: 'refused',
      reason: 'stale_target',
      said: 'The stop request was refused. Codex may still be running; check the session.',
    },
    {
      state: 'refused',
      reason: 'read_only_session',
      said: 'The stop request was refused. Codex may still be running; check the session.',
    },
    { state: 'refused', reason: 'not_running', said: 'That Codex session appears idle.' },
    {
      state: 'outcome_unknown',
      said: "I couldn't confirm the stop request. Codex may still be running; check the session.",
    },
    {
      state: 'queued',
      said: "I couldn't confirm the stop request. Codex may still be running; check the session.",
    },
  ];
  for (const { said, ...receipt } of cases) {
    serve('/desk/commands', { body: receipt });
    const out = output(),
      backend = new DeskVoiceBackend(target, out.port);
    backend.stop();
    for (let i = 0; i < 24; i++) await Promise.resolve();
    assert.deepEqual(out.speech, [said], JSON.stringify(receipt));
    backend.close();
  }
  serve('/desk/commands', { network: true });
  assert.equal(
    await stopTarget(target),
    'unknown',
    'a lost response cannot prove refusal or completion',
  );
  serve('/desk/commands', () => assert.fail('an unavailable target must not send an interrupt'));
  assert.equal(await stopTarget({ ...target, thread: '' }), 'refused');
  assert.equal(
    await stopTarget({
      ...target,
      capabilities: { read: true, message: true, stop: false, answer: true },
    }),
    'refused',
  );
});

const LONG =
  'I drew the hash map on the board. It shows the key going through a hash function to a bucket, how collisions chain, and why lookups stay fast.\n\n- **Key**: the word you look up\n- **Bucket**: where it lands';

test('with the voice on, a typed question is answered aloud too; turns over before it listened, or stopped, are not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const out = output();
  const turn = (id: string, status: string, answer: string, drew = false) => ({
    id,
    status,
    error: status === 'interrupted' ? 'cancelled' : null,
    messages: [
      { role: 'user', text: `ask ${id}` },
      ...(answer ? [{ role: 'assistant', text: answer }] : []),
    ],
    outcomes: drew ? [{ name: 'board.write' }] : [],
  });
  const shot = (...commands: unknown[]) => ({ conversation: { id: 'a' }, stage: {}, commands });
  const pi = {
    selected: 'a',
    active: false,
    snapshot: shot(turn('old', 'completed', 'An old answer.')),
    send: async () => true,
    stop: async () => {},
    transport: { snapshot: async () => pi.snapshot },
  };
  const backend = new PiVoiceBackend(() => pi as never, out.port);
  t.after(() => backend.close());
  backend.watch();
  t.mock.timers.tick(5_000);
  assert.deepEqual(out.said, [], 'what was over before the voice listened is not read out');
  // Typed while the voice is on: a short answer, nothing drawn.
  pi.snapshot = shot(turn('old', 'completed', 'An old answer.'), turn('fact', 'working', ''));
  backend.watch();
  pi.snapshot = shot(
    turn('old', 'completed', 'An old answer.'),
    turn('fact', 'completed', 'The capital of Australia is **Canberra**.'),
  );
  backend.watch();
  assert.deepEqual(out.said, [
    { text: 'Result: The capital of Australia is Canberra.', delegation: '' },
  ]);
  backend.watch();
  t.mock.timers.tick(5_000);
  assert.equal(out.said.length, 1, 'once');
  // Typed and drawn: its lines were said as it drew, so only its closing sentence follows, after the pen.
  const drawn = [
    turn('old', 'completed', ''),
    turn('fact', 'completed', ''),
    turn('explain', 'completed', LONG, true),
  ];
  backend.saying('A hash map finds things fast.');
  out.ink(true);
  pi.snapshot = shot(...drawn);
  backend.watch();
  t.mock.timers.tick(3_000);
  assert.equal(out.said.length, 1, 'not while the pen still draws');
  out.ink(false);
  out.spoke(Date.now() - 5_000);
  t.mock.timers.tick(2_000);
  assert.deepEqual(out.said[1], {
    text: 'Result: I drew the hash map on the board.',
    delegation: '',
  });
  // Stopped by the person: nothing is said of it.
  pi.snapshot = shot(...drawn, turn('stopped', 'interrupted', 'Half an answer.'));
  backend.watch();
  t.mock.timers.tick(5_000);
  assert.equal(out.said.length, 2);
  // A spoken request is still answered once, to its own delegation.
  pi.snapshot = shot(...drawn);
  await backend.send('ask spoken', 'delegation');
  pi.snapshot = shot(...drawn, turn('spoken', 'completed', 'Four.'));
  backend.watch();
  t.mock.timers.tick(5_000);
  assert.deepEqual(out.said.slice(2), [{ text: 'Result: Four.', delegation: 'delegation' }]);
});

test('a request the page handed over itself is answered with no delegation, and a late one from the voice is adopted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  for (const late of [false, true]) {
    const out = output();
    const pi = {
      selected: 'a',
      active: false,
      snapshot: snapshot('a'),
      send: async () => true,
      stop: async () => {},
      transport: { snapshot: async () => snapshot('a', true) },
    };
    const backend = new PiVoiceBackend(() => pi as never, out.port);
    await backend.send('Draw this', '');
    assert.equal(backend.pending, true);
    if (late) backend.adopt('late');
    pi.snapshot = snapshot('a', true);
    backend.watch();
    t.mock.timers.tick(5_000);
    assert.deepEqual(out.said, [{ text: 'Result: It is done.', delegation: late ? 'late' : '' }]);
    backend.close();
  }
});

test("a Mac agent's steps reach the voice through the gate while it works; the voice decides which to say", async (t) => {
  t.after(unmount);
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  setToken('voice-progress');
  setProject('voice-progress');
  const out = output();
  let steps: { id: string; text: string }[] = [],
    state = 'running',
    asking: string | undefined;
  serve('/desk/commands', { body: { command: 'command', state: 'completed' } });
  serve('/desk/voice', () => ({
    body: {
      turn: {
        state,
        steps,
        ...(asking && { asking }),
        ...(state === 'done' && { answer: 'All green.' }),
      },
    },
  }));
  const backend = new DeskVoiceBackend(
    { device: 'mac', thread: 'thread', provider: 'codex', title: 'Task', label: 'Folder' },
    out.port,
  );
  t.after(() => backend.close());
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  await backend.send('Fix the flaky test', 'request');
  await flush();
  steps = [{ id: '1', text: 'Read the test' }];
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1_000);
    await flush();
  }
  assert.deepEqual(out.progress, [], 'not in the first moments');
  steps = [...steps, { id: '2', text: 'Found the race in the setup' }];
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(1_000);
    await flush();
  }
  assert.deepEqual(out.progress, ['2 steps done so far. Latest: Found the race in the setup.']);
  // Waiting on the person, the OK is what is said, not a step.
  asking = 'Run npm test';
  steps = [...steps, { id: '3', text: 'Wrote the fix' }];
  for (let i = 0; i < 25; i++) {
    t.mock.timers.tick(1_000);
    await flush();
  }
  assert.equal(out.progress.length, 1);
  assert.deepEqual(out.speech, ['Codex needs your OK to go on.']);
  asking = undefined;
  state = 'done';
  t.mock.timers.tick(1_000);
  await flush();
  assert.deepEqual(
    out.reported,
    ['Result: All green.'],
    'the result is said by the system first: at the pause',
  );
});
