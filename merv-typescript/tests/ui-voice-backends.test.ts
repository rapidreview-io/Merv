import assert from 'node:assert/strict';
import test from 'node:test';
const browser = (path: string) => import(new URL(path, import.meta.url).href);
const { serve, unmount } = await browser('./ui-render.js');
const { PiVoiceBackend } = await browser('../packages/ui/web/views/pi-voice-backend.js');
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
