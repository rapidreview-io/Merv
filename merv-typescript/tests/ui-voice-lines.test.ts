/** Narration queue, explicit UI controls, lifecycle and timing. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Telling, SETTLE_MS } from '../packages/ui/web/views/voice-lines.js';

/** A voice whose sound and clock the test moves. */
function line(options: { level?: boolean; pending?: boolean } = {}) {
  let now = 1_000_000,
    level = 0,
    pending = false;
  const sent: { at: number; line: string; delegation?: string }[] = [],
    muted: boolean[] = [];
  const telling = new Telling({
    now: () => now,
    send: (text, delegation) =>
      sent.push({ at: now, line: text, ...(delegation !== undefined && { delegation }) }),
    mute: (off) => muted.push(off),
    ...(options.level && { level: () => level }),
    ...(options.pending && { pending: () => pending }),
  });
  /** Moves time on in looks of 50 ms, as the page's timer would. */
  const pass = (ms: number) => {
    for (let spent = 0; spent < ms; spent += 50) {
      now += 50;
      telling.tick();
    }
  };
  /** The voice speaks for `ms`: sound, and words coming with it. */
  const speaks = (ms: number) => {
    for (let spent = 0; spent < ms; spent += 50) {
      level = 0.3;
      pending = true;
      telling.voice();
      now += 50;
      telling.tick();
    }
    level = 0;
    pending = false;
  };
  return {
    telling,
    sent,
    muted,
    pass,
    speaks,
    at: () => now,
    lines: () => sent.map((entry) => entry.line),
  };
}

test('the next line goes when the voice has finished the one before, not after a fixed quiet', () => {
  for (const kind of [{ level: true }, { pending: true }]) {
    const v = line(kind);
    v.telling.speak('One.');
    v.telling.speak('Two.');
    v.telling.tick();
    assert.deepEqual(v.lines(), ['One.']);
    v.speaks(3_000);
    assert.deepEqual(v.lines(), ['One.'], 'not while it still speaks');
    const ended = v.at();
    v.pass(SETTLE_MS + 150);
    assert.deepEqual(v.lines(), ['One.', 'Two.']);
    assert.ok(
      v.sent[1]!.at - ended <= SETTLE_MS + 150,
      `sent ${v.sent[1]!.at - ended} ms after the voice finished`,
    );
  }
});

test('a cut silences this device at once, sends nothing while it lasts, and lets sound back when the voice is still', () => {
  const v = line({ level: true });
  v.telling.speak('One.');
  v.telling.speak('Two.');
  v.telling.tick();
  v.speaks(500);
  v.telling.clear();
  v.telling.cut();
  assert.deepEqual(v.muted, [true], 'muted in the same moment: no model was asked');
  assert.equal(v.telling.cutting, true);
  v.telling.speak('A new line.');
  v.speaks(700); // the voice has not stopped yet: none of it is heard
  assert.deepEqual(v.muted, [true]);
  assert.deepEqual(v.lines(), ['One.'], 'and nothing new is sent into the silence');
  v.pass(500);
  assert.deepEqual(v.muted, [true, false]);
  assert.equal(v.telling.cutting, false);
  assert.deepEqual(v.lines(), ['One.', 'A new line.']);
});

test('an interrupted important notice remains queued without repeating its receipt', () => {
  const v = line({ pending: true });
  let receipts = 0;
  v.telling.speak('Warning: tests failed.', { kept: true, sent: () => receipts++ });
  v.telling.tick();
  v.speaks(1_600); // synthesis/playback is explicitly pending beyond the quiet fallback
  v.telling.interrupted();
  v.telling.clear();
  assert.equal(v.telling.behind, true);
  v.telling.tick();
  assert.deepEqual(v.lines(), ['Warning: tests failed.', 'Warning: tests failed.']);
  assert.equal(receipts, 1);
});
