/** Offline integration replay: the real useVoice hook, transports and timers, synthetic media only.
 * These check client behavior, not the remote model or real acoustic echo cancellation. */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mount, unmount } from './ui-render.js';
const { createElement, act } = await import('react');
const { useVoice } = await import('../packages/ui/web/views/pi-voice.js');

async function replay(t: TestContext) {
  const sent: { text: string; at: number }[] = [];
  const controls: { type: string; content?: string }[] = [];
  let channel: { onmessage?: (e: { data: string }) => void } = {};
  let voice!: ReturnType<typeof useVoice>;
  const track = { stop() {} };
  const mic = { getTracks: () => [track], getAudioTracks: () => [track] };
  const remote = { name: 'remote-playback' };
  const upstream: unknown[] = [],
    measured: unknown[] = [];
  let receiveTrack: (stream: unknown) => void = () => {};
  let muted = false,
    muteAt = -1;
  const audio = {
    get muted() {
      return muted;
    },
    set muted(value: boolean) {
      muted = value;
      if (value && muteAt < 0) muteAt = Date.now();
    },
    autoplay: false,
    srcObject: null,
    setAttribute() {},
    play: async () => {},
  };
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = ['Audio', 'AudioContext', 'RTCPeerConnection'].map(
    (k) => [k, globals[k]] as const,
  );
  let rms = 0;
  let constraints: unknown;
  Object.assign(globals, {
    Audio: class {
      constructor() {
        return audio;
      }
    },
    AudioContext: class {
      createAnalyser() {
        return {
          fftSize: 512,
          getByteTimeDomainData(a: Uint8Array) {
            a.fill(128 + Math.round(rms * 128));
          },
        };
      }
      createMediaStreamSource(stream: unknown) {
        return {
          connect() {
            measured.push(stream);
          },
        };
      }
      close() {
        return Promise.resolve();
      }
    },
    RTCPeerConnection: class {
      ontrack?: (event: { streams: unknown[] }) => void;
      constructor() {
        receiveTrack = (stream) => this.ontrack?.({ streams: [stream] });
      }
      iceGatheringState = 'complete';
      localDescription = { sdp: 'synthetic' };
      createDataChannel() {
        return (channel = {
          readyState: 'open',
          send(s: string) {
            controls.push(JSON.parse(s));
          },
        } as typeof channel);
      }
      addTrack(track: unknown) {
        upstream.push(track);
      }
      close() {}
      async createOffer() {
        return { sdp: 'synthetic' };
      }
      async setLocalDescription() {}
      async setRemoteDescription() {}
    },
  });
  const media = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async (requested: unknown) => {
        constraints = requested;
        return mic;
      },
    },
  });
  const pi = {
    active: false,
    selected: 'replay' as string | null,
    snapshot: { conversation: { id: 'replay' }, stage: {}, commands: [] },
    transport: { voice: async () => ({ sdp: 'synthetic' }) },
    warmUp() {},
    send: async (text: string) => {
      sent.push({ text, at: Date.now() });
      return true;
    },
    stop: async () => {},
  };
  function Harness() {
    voice = useVoice(pi as never);
    return null;
  }
  await mount(createElement(Harness));
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  await act(async () => {
    voice.start();
  });
  t.after(async () => {
    await unmount();
    for (const [key, value] of previous)
      value === undefined ? delete globals[key] : (globals[key] = value);
    if (media) Object.defineProperty(navigator, 'mediaDevices', media);
    else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  });
  const event = async (type: string, fields: Record<string, unknown> = {}) => {
    await act(async () => {
      channel.onmessage?.({ data: JSON.stringify({ type, ...fields }) });
    });
  };
  const pass = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50)
      await act(async () => {
        t.mock.timers.tick(Math.min(50, ms - elapsed));
      });
  };
  return {
    sent,
    controls,
    audio,
    event,
    pass,
    constraints: () => constraints,
    upstream,
    measured,
    track,
    micStream: mic,
    remote,
    receiveTrack,
    muteAt: () => muteAt,
    voice: () => voice,
    mic: (level: number) => {
      rms = level;
    },
    word: (delta: string) => event('session.input_transcript.delta', { delta }),
    delegate: () => event('session.delegation.created', { delegation: { id: `d-${Date.now()}` } }),
    speak: async (text: string) => {
      await act(async () => {
        voice.speak(text);
      });
      await event('session.output_transcript.delta', { delta: text });
    },
  };
}

test('voice ignores echoed playback and hands a genuine interruption to the agent once', async (t) => {
  const h = await replay(t);
  assert.deepEqual(h.constraints(), {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  h.receiveTrack(h.remote);
  assert.deepEqual(h.upstream, [h.track], 'only microphone audio goes to Live');
  assert.deepEqual(
    h.measured,
    [h.micStream, h.remote],
    'analysers only measure the separate streams',
  );
  assert.equal(h.audio.srcObject, h.remote, 'remote audio uses one media element');
  await h.speak('Here is the first plan.');
  await h.event('session.input_speech.started');
  await h.word('Show the second plan instead.');
  // Live stops its own WebRTC output. The app must not mute the next reply
  // or send an instruction that interrupts it again after transcription arrives.
  assert.equal(h.audio.muted, false);
  assert.equal(
    h.controls.some((x) => x.type === 'session.instructions.append'),
    false,
  );
  await h.delegate();
  await h.pass(250);
  assert.deepEqual(
    h.sent.map((x) => x.text),
    ['Show the second plan instead.'],
  );
  await h.speak('Please stop at the next checkpoint.');
  h.mic(0.1);
  await h.event('session.input_speech.started');
  for (const part of ['Please ', 'stop ', 'at the next checkpoint.']) {
    await h.word(part);
    await h.pass(1_500);
  }
  assert.equal(h.muteAt(), -1);
  assert.deepEqual(
    h.sent.map((entry) => entry.text),
    ['Show the second plan instead.'],
  );
  assert.equal(h.voice().halted, 0);
  assert.equal(
    h.controls.some((x) => x.type === 'session.instructions.append'),
    false,
  );
  assert.equal(h.audio.muted, false);
});
