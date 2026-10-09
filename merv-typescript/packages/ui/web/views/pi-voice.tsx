/**
 * Voice mode (founder, 2026-10-08): GPT-Live is the conversation's ears and voice, and Pi does
 * the work on its own model and tools. The browser offers WebRTC, Main opens the session with
 * its key (pi.voice), and the page runs the delegation: each request GPT-Live hands over is sent
 * as an ordinary Pi turn, and that turn's answer goes back for GPT-Live to say. The full answer
 * stands in the transcript as always. There is no time limit; a quiet session closes itself.
 * The session belongs to the conversation, not to a page: it goes on as the person moves around
 * the app, and the floating window holds its panel away from the Agent page.
 */
import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import type { PiCommand } from '@merv/pi/models';
import type { Conversation } from './pi-conversation';

/** How long a session may go without anyone speaking, and no answer pending, before it closes. */
const IDLE_MS = 120_000;
/** How long after the voice's last word it counts as listening again. */
const QUIET_MS = 1_400;
/** GPT-Live takes at most 500 tokens an append. */
const SAYABLE = 1_800;

export type VoiceState = 'off' | 'connecting' | 'listening' | 'working' | 'speaking' | 'closing';

interface Live {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  mic: MediaStream;
  audio: HTMLAudioElement;
  context: AudioContext;
  input: AnalyserNode;
  output?: AnalyserNode;
  /** What the person said since the last request was handed to Pi. */
  heard: string;
  /** Who spoke last, so a caption starts afresh when the other one speaks. */
  speaker?: 'person' | 'voice';
  last: number;
  quiet?: ReturnType<typeof setTimeout>;
  /** The request Pi is answering: GPT-Live's delegation and the turn sent for it. */
  pending?: { delegation: string; text: string; after: number };
}

/** An answer written for the screen, as words to be said: no markup, no tables, no code. */
export function sayable(markdown: string): string {
  let shown = false;
  const text = markdown
    .replace(/```[\s\S]*?```/g, () => ((shown = true), ' '))
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line) || ((shown = true), false))
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_`~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut =
    text.length <= SAYABLE
      ? text
      : `${text.slice(0, SAYABLE).replace(/[^.!?]*$/, '') || text.slice(0, SAYABLE)}`;
  return shown ? `${cut} (Details are on screen.)` : cut;
}

/** What GPT-Live is told when Pi's turn for a request ends. */
function resultOf(command: PiCommand): string {
  const answer = [...command.messages].reverse().find((m) => m.role === 'assistant')?.text ?? '';
  const waiting = (command.proposals ?? []).filter((p) => !p.ran);
  const parts = [answer ? sayable(answer) : ''];
  if (waiting.length)
    parts.push(
      `Needs the person's approval: ${waiting
        .map((p) => p.act?.title ?? p.name)
        .join('; ')}. They can tap Run on screen.`,
    );
  if (command.status === 'interrupted')
    parts.push(`Pi stopped before it finished (${command.error ?? 'interrupted'}).`);
  return parts.filter(Boolean).join(' ') || 'Pi finished without saying anything.';
}

const level = (analyser?: AnalyserNode) => {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) sum += ((value - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / data.length) * 4);
};

/** The voice session of one conversation: its state, its two captions, and its controls. */
export function useVoice(pi: Conversation | null) {
  const [state, setState] = useState<VoiceState>('off');
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState('');
  const [muted, setMuted] = useState(false);
  const live = useRef<Live | null>(null);
  const conversation = useRef(pi);
  conversation.current = pi;

  const send = (type: string, content: string, delegation: string | null) => {
    const dc = live.current?.dc;
    if (dc?.readyState !== 'open') return;
    const event: Record<string, unknown> = { type, event_id: crypto.randomUUID() };
    if (type !== 'session.close') Object.assign(event, { delegation_id: delegation, content });
    dc.send(JSON.stringify(event));
  };

  const teardown = () => {
    const held = live.current;
    live.current = null;
    if (held) {
      clearTimeout(held.quiet);
      for (const track of held.mic.getTracks()) track.stop();
      held.pc.close();
      held.audio.srcObject = null;
      void held.context.close().catch(() => undefined);
    }
    setState('off');
    setMuted(false);
  };

  const stop = () => {
    const held = live.current;
    if (!held) return;
    if (held.dc.readyState === 'open') {
      setState('closing');
      send('session.close', '', null);
      // The session says closed once it has settled its usage; a silent end still ends it.
      setTimeout(() => live.current === held && teardown(), 4_000);
    } else teardown();
  };

  /** A request GPT-Live handed over: it becomes a Pi turn on the conversation's own model. */
  const delegate = async (delegation: string) => {
    const held = live.current;
    if (!held) return;
    const text = held.heard.trim();
    held.heard = '';
    const pi = conversation.current;
    if (!pi) return;
    if (!text) return send('session.commentary.append', "I didn't catch that.", delegation);
    if (held.pending || pi.active)
      return send(
        'session.commentary.append',
        'Pi is still working on the last request; I will tell you when it is done.',
        delegation,
      );
    held.pending = { delegation, text, after: pi.snapshot?.commands.length ?? 0 };
    setState('working');
    const sent = await pi.send(text);
    if (!sent && live.current === held) {
      held.pending = undefined;
      setState('listening');
      send('session.commentary.append', 'Pi could not take that request just now.', delegation);
    }
  };

  const onEvent = (event: { type?: string; [key: string]: unknown }) => {
    const held = live.current;
    if (!held) return;
    const delta = typeof event.delta === 'string' ? event.delta : '';
    switch (event.type) {
      case 'session.started':
        setState('listening');
        break;
      case 'session.input_transcript.delta':
        held.last = Date.now();
        held.heard += delta;
        setHeard((before) => (held.speaker === 'person' ? before + delta : delta.trimStart()));
        held.speaker = 'person';
        if (!held.pending) setState('listening');
        break;
      case 'session.output_transcript.delta':
        held.last = Date.now();
        setSaid((before) => (held.speaker === 'voice' ? before + delta : delta.trimStart()));
        held.speaker = 'voice';
        setState('speaking');
        clearTimeout(held.quiet);
        held.quiet = setTimeout(() => {
          if (live.current === held) setState(held.pending ? 'working' : 'listening');
        }, QUIET_MS);
        break;
      case 'session.delegation.created':
        held.last = Date.now();
        void delegate((event.delegation as { id: string }).id);
        break;
      case 'session.closed':
        teardown();
        break;
      case 'error':
        setProblem(
          typeof (event.error as { message?: unknown })?.message === 'string'
            ? (event.error as { message: string }).message
            : typeof event.message === 'string'
              ? event.message
              : 'Voice reported an error.',
        );
        break;
    }
  };

  const start = async () => {
    const id = pi?.snapshot?.conversation.id;
    if (live.current || !pi || !id) return;
    setProblem('');
    setHeard('');
    setSaid('');
    setState('connecting');
    let held: Live | null = null;
    try {
      // On iPad Safari this routes the audio as a call, so the speaker and the mic share echo
      // cancellation; everything below starts inside the press that opened voice.
      const session = (navigator as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = 'play-and-record';
      const audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      const context = new AudioContext();
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const input = context.createAnalyser();
      input.fftSize = 512;
      context.createMediaStreamSource(mic).connect(input);
      const pc = new RTCPeerConnection();
      const dc = pc.createDataChannel('oai-events');
      held = { pc, dc, mic, audio, context, input, heard: '', last: Date.now() };
      live.current = held;
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream || live.current !== held) return;
        audio.srcObject = stream;
        void audio.play().catch(() => undefined);
        const output = context.createAnalyser();
        output.fftSize = 512;
        context.createMediaStreamSource(stream).connect(output);
        held!.output = output;
      };
      for (const track of mic.getTracks()) pc.addTrack(track, mic);
      dc.onmessage = (message) => {
        try {
          onEvent(JSON.parse(String(message.data)));
        } catch {
          /* not an event */
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && live.current === held) {
          setProblem('The voice connection dropped.');
          teardown();
        }
      };
      await pc.setLocalDescription(await pc.createOffer());
      // The offer goes whole, with its candidates, once gathering ends or has had its moment.
      await new Promise<void>((done) => {
        if (pc.iceGatheringState === 'complete') return done();
        const timer = setTimeout(done, 2_500);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            done();
          }
        });
      });
      const answer = await call<{ sdp: string }>('pi.voice', {
        id,
        sdp: pc.localDescription!.sdp,
      });
      if (live.current !== held) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      // The machine starts now, so the first request does not wait for it.
      pi.warmUp();
    } catch (cause) {
      if (live.current === held || !held) {
        setProblem(
          cause instanceof DOMException && cause.name === 'NotAllowedError'
            ? 'Microphone access was refused.'
            : cause instanceof Error
              ? cause.message
              : 'Voice could not start.',
        );
        teardown();
      }
    }
  };

  // When the turn sent for a request ends, its answer goes back for GPT-Live to say.
  useEffect(() => {
    const held = live.current;
    const pending = held?.pending;
    const commands = pi?.snapshot?.commands;
    if (!held || !pending || !commands) return;
    const turn = commands
      .slice(pending.after)
      .find((command) =>
        command.messages.some((m) => m.role === 'user' && m.text.trim() === pending.text),
      );
    if (!turn || (turn.status !== 'completed' && turn.status !== 'interrupted')) return;
    held.pending = undefined;
    held.last = Date.now();
    send('session.commentary.append', resultOf(turn), pending.delegation);
    setState('listening');
  }, [pi?.snapshot]);

  // No time limit; a session nobody has spoken in, with nothing pending, closes itself, and so
  // does one whose page is put away.
  useEffect(() => {
    if (state === 'off') return;
    const watch = setInterval(() => {
      const held = live.current;
      if (held && !held.pending && Date.now() - held.last > IDLE_MS) stop();
    }, 5_000);
    const away = () => document.visibilityState === 'hidden' && stop();
    document.addEventListener('visibilitychange', away);
    return () => {
      clearInterval(watch);
      document.removeEventListener('visibilitychange', away);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state === 'off']);

  useEffect(() => () => teardown(), []);

  return {
    state,
    heard,
    said,
    problem,
    muted,
    start: () => void start(),
    stop,
    mute: () => {
      const held = live.current;
      if (!held) return;
      const next = !muted;
      for (const track of held.mic.getAudioTracks()) track.enabled = !next;
      if (held.dc.readyState === 'open')
        held.dc.send(
          JSON.stringify({
            type: next ? 'session.input_audio.mute' : 'session.input_audio.unmute',
            event_id: crypto.randomUUID(),
          }),
        );
      setMuted(next);
    },
    /** How loud the person and the voice are right now, 0 to 1. */
    levels: () => ({ input: level(live.current?.input), output: level(live.current?.output) }),
  };
}
export type Voice = ReturnType<typeof useVoice>;

const WORDS: Record<VoiceState, string> = {
  off: '',
  connecting: 'Connecting',
  listening: 'Listening',
  working: 'Pi is working',
  speaking: 'Speaking',
  closing: 'Ending',
};

/** Where the composer stood while voice is on: the orb, what was last said, and two controls. */
export function VoicePanel({ voice, progress }: { voice: Voice; progress?: string }) {
  const orb = useRef<HTMLDivElement>(null);
  const { state } = voice;
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const { input, output } = voice.levels();
      const now = state === 'speaking' ? output : state === 'listening' && !voice.muted ? input : 0;
      orb.current?.style.setProperty('--level', now.toFixed(3));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [voice, state]);
  const caption =
    state === 'speaking'
      ? voice.said
      : state === 'working'
        ? voice.heard || progress || ''
        : voice.heard || voice.said;
  return (
    <section className="voice" data-state={state} aria-label="Voice">
      <button
        type="button"
        className="voice-control"
        aria-pressed={voice.muted}
        onClick={voice.mute}
        disabled={state === 'connecting' || state === 'closing'}
      >
        {voice.muted ? 'Unmute' : 'Mute'}
      </button>
      <div className="voice-center">
        <div className="voice-orb" ref={orb} aria-hidden="true" />
        <p className="voice-state" role="status">
          {voice.muted && state === 'listening' ? 'Muted' : WORDS[state]}
        </p>
        <p className="voice-caption" aria-live="polite">
          {voice.problem || caption}
        </p>
      </div>
      <button type="button" className="voice-control voice-end" onClick={voice.stop}>
        End
      </button>
    </section>
  );
}
