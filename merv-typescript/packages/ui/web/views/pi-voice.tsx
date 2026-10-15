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
import type { PiCommand, PiSnapshot } from '@merv/pi/models';
import { Icon } from '../icons';
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
  mic?: MediaStream;
  audio: HTMLAudioElement;
  context: AudioContext;
  input?: AnalyserNode;
  output?: AnalyserNode;
  /** What the person said since the last request was handed to Pi. */
  heard: string;
  /** Who spoke last, so a caption starts afresh when the other one speaks. */
  speaker?: 'person' | 'voice';
  last: number;
  quiet?: ReturnType<typeof setTimeout>;
  /** The request Pi is answering: GPT-Live's delegation, the turn sent for it and where. */
  pending?: { delegation: string; text: string; after: number; id: string | null };
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
  const [compact, setCompact] = useState(false);
  const [paused, setPaused] = useState(false);
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState('');
  const [muted, setMuted] = useState(false);
  const live = useRef<Live | null>(null);
  const conversation = useRef(pi);
  conversation.current = pi;

  /** One event to GPT-Live; commentary on a delegation carries it and what to say. */
  const send = (type: string, content?: string, delegation?: string | null) => {
    const dc = live.current?.dc;
    if (dc?.readyState !== 'open') return;
    const event: Record<string, unknown> = { type, event_id: crypto.randomUUID() };
    if (delegation !== undefined) Object.assign(event, { delegation_id: delegation, content });
    dc.send(JSON.stringify(event));
  };

  const teardown = () => {
    const held = live.current;
    live.current = null;
    if (held) {
      clearTimeout(held.quiet);
      for (const track of held.mic?.getTracks() ?? []) track.stop();
      held.pc.close();
      held.audio.srcObject = null;
      void held.context.close().catch(() => undefined);
    }
    setPaused(false);
    setCompact(false);
    setState('off');
    setMuted(false);
  };

  const stop = () => {
    const held = live.current;
    if (!held) return;
    if (held.dc.readyState === 'open') {
      setState('closing');
      send('session.close');
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
    held.pending = { delegation, text, after: pi.snapshot?.commands.length ?? 0, id: pi.selected };
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
    if (live.current || !pi || !id || !pi.transport.voice) return;
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
      const pc = new RTCPeerConnection();
      const dc = pc.createDataChannel('oai-events');
      // Held while the microphone is asked for: End ends it there, a refusal closes it.
      held = { pc, dc, audio, context, heard: '', last: Date.now() };
      live.current = held;
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (live.current !== held) return void mic.getTracks().forEach((track) => track.stop());
      const input = context.createAnalyser();
      input.fftSize = 512;
      context.createMediaStreamSource(mic).connect(input);
      Object.assign(held, { mic, input });
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
      const answer = await pi.transport.voice(id, pc.localDescription!.sdp);
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

  /** Once the turn sent for a request has ended in its conversation, its answer goes back for
   *  GPT-Live to say. */
  const answered = (snapshot?: PiSnapshot | null) => {
    const held = live.current;
    const pending = held?.pending;
    if (!held || !pending || !snapshot) return;
    if (pending.id && snapshot.conversation.id !== pending.id) return;
    const turn = snapshot.commands
      .slice(pending.after)
      .find((command) =>
        command.messages.some((m) => m.role === 'user' && m.text.trim() === pending.text),
      );
    if (!turn || (turn.status !== 'completed' && turn.status !== 'interrupted')) return;
    held.pending = undefined;
    held.last = Date.now();
    send('session.commentary.append', resultOf(turn), pending.delegation);
    setState('listening');
  };
  useEffect(() => answered(pi?.snapshot), [pi?.snapshot]);
  // Another conversation opened meanwhile: the request's own is read, at once and every few
  // seconds, until its turn ends.
  const asked = live.current?.pending?.id;
  const away = asked !== pi?.snapshot?.conversation.id && asked;
  useEffect(() => {
    if (!away) return;
    const look = () => void pi?.transport.snapshot(away).then(answered, () => {});
    look();
    const timer = setInterval(look, 5_000);
    return () => clearInterval(timer);
  }, [away]);

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
    compact,
    setCompact,
    paused,
    pause: () => {
      const held = live.current;
      if (!held) return;
      const next = !paused;
      held.audio.muted = next;
      for (const track of held.mic?.getAudioTracks() ?? []) track.enabled = !next && !muted;
      send(next || muted ? 'session.input_audio.mute' : 'session.input_audio.unmute');
      setPaused(next);
    },
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
      for (const track of held.mic?.getAudioTracks() ?? []) track.enabled = !next && !paused;
      send(next || paused ? 'session.input_audio.mute' : 'session.input_audio.unmute');
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
  const clickTimer = useRef<ReturnType<typeof setTimeout>>();
  const current = useRef(voice);
  current.current = voice;
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  const showChat = () => {
    clearTimeout(clickTimer.current);
    voice.setCompact(false);
  };
  const pause = () => {
    clearTimeout(clickTimer.current);
    voice.pause();
  };
  const { state } = voice;
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const { input, output } = voice.levels();
      const now = voice.paused
        ? 0
        : state === 'speaking'
          ? output
          : state === 'listening' && !voice.muted
            ? input
            : 0;
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
  if (voice.compact)
    return (
      <section
        className="voice voice--sphere"
        data-state={voice.paused ? 'paused' : state}
        aria-label="Voice"
      >
        <button
          className="voice-sphere-button"
          aria-label={voice.paused ? 'Resume voice' : 'Pause voice'}
          aria-pressed={voice.paused}
          onClick={(event) => {
            if (event.detail === 0) return pause();
            clearTimeout(clickTimer.current);
            if (event.detail === 1)
              clickTimer.current = setTimeout(() => current.current.pause(), 320);
          }}
          onDoubleClick={showChat}
        >
          <div className="voice-orb" ref={orb} aria-hidden="true" />
        </button>
        <div className="voice-hover-controls" role="group" aria-label="Voice controls">
          <button type="button" onClick={showChat} title="Show chat">
            <Icon name="chat" size={18} />
            <span className="sr-only">Chat</span>
          </button>
          <button
            type="button"
            onClick={pause}
            title={voice.paused ? 'Resume audio' : 'Pause audio'}
          >
            <Icon name={voice.paused ? 'play' : 'pause'} size={18} />
            <span className="sr-only">{voice.paused ? 'Resume' : 'Pause'}</span>
          </button>
          <button
            type="button"
            title="End audio"
            className="voice-close"
            onClick={() => {
              clearTimeout(clickTimer.current);
              voice.stop();
            }}
          >
            <Icon name="close" size={18} />
            <span className="sr-only">Close</span>
          </button>
        </div>
        <span className="sr-only" role="status">
          {voice.paused ? 'Paused' : WORDS[state]}. {voice.problem || caption}
        </span>
      </section>
    );
  return (
    <section
      className={`voice${voice.compact ? ' voice--compact' : ''}`}
      data-state={state}
      aria-label="Voice"
    >
      <button
        type="button"
        className="voice-control"
        aria-pressed={voice.paused || voice.muted}
        onClick={voice.paused ? voice.pause : voice.mute}
        disabled={state === 'connecting' || state === 'closing'}
      >
        {voice.paused ? 'Resume' : voice.muted ? 'Unmute' : 'Mute'}
      </button>
      <div className="voice-center">
        <div className="voice-orb" ref={orb} aria-hidden="true" />
        <p className="voice-state" role="status">
          {voice.paused ? 'Paused' : voice.muted && state === 'listening' ? 'Muted' : WORDS[state]}
        </p>
        <p className="voice-caption" aria-live="polite">
          {voice.problem || caption}
        </p>
      </div>
      <button
        type="button"
        className="voice-control voice-display"
        onClick={() => voice.setCompact(!voice.compact)}
      >
        {voice.compact ? 'Show chat' : 'Collapse to voice'}
      </button>
      <button type="button" className="voice-control voice-end" onClick={voice.stop}>
        End
      </button>
    </section>
  );
}
