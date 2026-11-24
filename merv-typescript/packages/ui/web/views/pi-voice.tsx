import { PublicError, publicError } from '../errors';
import { AlternativeVoiceLine } from './alternative-voice';
import { ALTERNATIVE_MODEL } from './alternative-mode';
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
import type { Conversation } from './pi-conversation';
import {
  QUIET_MS,
  type VoiceBackend,
  type VoiceChoice,
  type VoiceTarget,
  type VoiceState,
} from './voice-backend';
import { VoiceRouter } from './voice-router';
import { agentName } from '../board-app/sessions';
import { type TellingPort, Telling, blip } from './voice-lines';
import { holdStaleBuild } from '../stale-build';
import { TYPED } from './typed';
import { VoiceTiming } from './voice-timing';
import { VOICE_MIC } from '@merv/protocol/voice-turns';
export { sayable, type VoiceState } from './voice-backend';

/** How long a session may go without anyone speaking, and no answer pending, before it closes. */
const IDLE_MS = 120_000;
/** How long a started session may take to carry the microphone before it counts as failed. */
const LINE_UP_MS = 10_000;
/** Said while the browser holds Merv's sound back until a press. */
const SOUND_HELD = 'Click anywhere to hear Merv.';
interface Live {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  alternative?: AlternativeVoiceLine;
  mic?: MediaStream;
  audio: HTMLAudioElement;
  context: AudioContext;
  allowSound?: () => void;
  input?: AnalyserNode;
  output?: AnalyserNode;
  /** One transcript buffer; only the model can hand it over. */
  heard: string;
  heardBoard?: string | null;
  record?: ((line: SaidLine) => void) | null;
  delivery?: ReturnType<typeof setTimeout>;
  waiting?: string;
  closing?: boolean;
  /** Who spoke last, so a caption starts afresh when the other one speaks. */
  speaker?: 'person' | 'voice';
  last: number;
  quiet?: ReturnType<typeof setTimeout>;
  /** The lines on their way to the voice: one at a time, none dropped, all cut at once on a stop. */
  telling: Telling;
  next?: ReturnType<typeof setTimeout>;
  /** Sound is off after a cut, and the person paused it: either keeps the speaker silent. */
  cut?: boolean;
  paused?: boolean;
  /** When this request's moments happened, for the timing record. */
  timing: VoiceTiming;
  backend: VoiceBackend;
  /** Said once the line is up: who is on it now. */
  greeting?: string;
}

/** A line said aloud in the session, as the open board keeps it on its timeline. */
export interface SaidLine {
  by: 'person' | 'agent';
  name?: string;
  words: string;
}
/** How many drawn lines are remembered as the pen's own, so they are not kept twice. */
const MOST_INKED = 50;

const samples = new WeakMap<AnalyserNode, Uint8Array<ArrayBuffer>>();
const level = (analyser?: AnalyserNode) => {
  if (!analyser) return 0;
  let data = samples.get(analyser);
  if (!data || data.length !== analyser.fftSize)
    samples.set(analyser, (data = new Uint8Array(analyser.fftSize)));
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
  const captions = useRef({ heard: '', said: '' });
  const [problem, setProblem] = useState('');
  const [muted, renderMuted] = useState(false);
  const micMuted = useRef(false);
  const setMuted = (value: boolean) => {
    micMuted.current = value;
    renderMuted(value);
  };
  const status = useRef({ state, problem });
  status.current = { state, problem };
  useEffect(() => holdStaleBuild(() => status.current.state !== 'off'), []);
  /** How many times the person has spoken over a turn: what is being drawn hurries to its end. */
  const [steered, setSteered] = useState(0);
  const [halted, setHalted] = useState(0);
  const live = useRef<Live | null>(null);
  /** Whom the next line speaks for: Pi, or one agent on the Mac. Changing it reopens the line. */
  const [route, setRoute] = useState<VoiceTarget | null>(null);
  const [choice, setChoice] = useState<VoiceChoice | null>(null);
  /** Whether an open board's pen still has this turn's ink to draw, and so lines to say. */
  const drawing = useRef<() => boolean>(() => false);
  const conversation = useRef(pi);
  conversation.current = pi;
  /** Where each line said aloud goes: the open board keeps it on its timeline, beside the ink. */
  const recorder = useRef<((line: SaidLine) => void) | null>(null);
  /** Lines the pen says as it draws: the board has them on their shapes already. */
  const inked = useRef(new Set<string>());
  const ink = (line: string) => {
    if (inked.current.size >= MOST_INKED) inked.current.clear();
    inked.current.add(line);
  };
  /** A line the voice is handed to say, kept unless the pen said it. */
  const voiced = (words: string) => {
    if (inked.current.delete(words)) return;
    const target = live.current?.backend.target;
    const said = words.replace(/^(?:Result|News|Progress):\s*/, '').trim();
    if (said)
      recorder.current?.({
        by: 'agent',
        name: target ? agentName(target.provider) : 'Merv',
        words: said,
      });
  };

  const routing = useRef<VoiceRouter>();
  const router = (routing.current ??= new VoiceRouter({
    current: () => live.current?.backend,
    conversation: () => conversation.current,
    route: setRoute,
    choice: setChoice,
    commentary: (text, delegation) => commentary(text, delegation),
    reopen: () => {
      teardown();
      void again.current();
    },
  }));
  const { connect, dismissChoice, cancelSpokenConnect } = router;

  /** One event to GPT-Live; commentary on a delegation carries it and what to say. */
  const send = (type: string, content?: string, delegation?: string | null) => {
    const dc = live.current?.alternative ?? live.current?.dc;
    if (dc?.readyState !== 'open') return false;
    const event: Record<string, unknown> = { type, event_id: crypto.randomUUID() };
    // Live requires null for session-wide context; empty IDs are invalid. Content is
    // independent of correlation, including page-originated speech and hush instructions.
    // https://developers.openai.com/api/reference/resources/live/primary-websocket
    if (type === 'session.commentary.append' || type === 'session.instructions.append')
      Object.assign(event, {
        content,
        delegation_id: typeof delegation === 'string' && delegation.trim() ? delegation : null,
      });
    dc.send(JSON.stringify(event));
    if (type === 'session.commentary.append' && content) {
      voiced(content);
    }
    return true;
  };

  const teardown = () => {
    const held = live.current;
    live.current = null;
    if (held?.heard.trim()) held.record?.({ by: 'person', words: held.heard.trim() });
    // What waits for the voice goes with it, unsaid: whoever handed it over hears so.
    held?.telling?.clear(true);
    dismissChoice();
    if (held) {
      held.allowSound?.();
      clearTimeout(held.quiet);
      clearTimeout(held.next);
      clearTimeout(held.delivery);
      held.backend.close();
      for (const track of held.mic?.getTracks() ?? []) track.stop();
      held.alternative?.close();
      held.pc?.close();
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
    held.closing = true;
    if ((held.alternative ?? held.dc)?.readyState === 'open') {
      setState('closing');
      send('session.close');
      // The session says closed once it has settled its usage; a silent end still ends it.
      setTimeout(() => live.current === held && teardown(), 4_000);
    } else teardown();
  };

  /** Sends the next line when the voice has finished the one before, and looks again while any waits. */
  const pump = () => {
    const held = live.current;
    if (!held) return;
    clearTimeout(held.next);
    const wait = (held.alternative ?? held.dc)?.readyState === 'open' ? held.telling.tick() : 100;
    if (wait !== undefined) held.next = setTimeout(pump, wait);
  };
  const speak = (line: string, options?: Parameters<Telling['speak']>[1]) => {
    if (!live.current) return void options?.dropped?.();
    live.current.telling.speak(line, options);
    pump();
  };
  const commentary = (text: string, delegation: string) => {
    if (send('session.commentary.append', text, delegation) === false)
      speak(text, { delegation, kept: true });
  };
  const saying = pi?.snapshot?.stage.saying;
  useEffect(() => {
    if (saying) live.current?.backend.saying(saying);
  }, [saying]);

  /**
   * The person stepped in: the sound goes off on this device at once and what waits is dropped,
   * without asking any model. The voice model is told afterwards, so it stops making what nobody
   * hears. With `confirm`, one short tone says the stop was taken.
   */
  const quiet = (confirm = false) => {
    const held = live.current;
    if (!held) return;
    const speaking =
      Date.now() - held.last <= QUIET_MS ||
      status.current.state === 'speaking' ||
      held.telling.behind;
    // A stop drops everything waiting, news too; a hand on the board or typed words only the lines.
    held.telling.clear(confirm);
    held.telling.cut();
    clearTimeout(held.quiet);
    if (status.current.state === 'speaking')
      setState(held.backend.pending && !confirm ? 'working' : 'listening');
    if (confirm) blip(held.context);
    if (speaking)
      send(
        'session.instructions.append',
        'The person stepped in. Stop what you are saying now. Later messages from Pi are still to be said.',
        null,
      );
    pump();
  };
  /** A person stepped in some way the voice could not hear (a hand on the board, typed words). */
  const hush = () => quiet();

  /** Explicit controls discard buffered input without replacing the voice session. */
  const clearInput = () => {
    const held = live.current;
    if (!held) return;
    clearTimeout(held.delivery);
    if (held.waiting) commentary('That voice request was cancelled.', held.waiting);
    if (held.heard.trim()) held.record?.({ by: 'person', words: held.heard.trim() });
    held.heard = '';
    held.waiting = undefined;
  };

  /** Everything stops now: the voice, what it had still to say, the pen and the turn. */
  const halt = (delegation?: string) => {
    const held = live.current;
    clearInput();
    quiet(true);
    setHalted((times) => times + 1);
    if (held) {
      setState('listening');
      return held.backend.stoppable ? held.backend.stop(delegation) : undefined;
    }
    return conversation.current?.stop();
  };

  /** Baseline handover: take the heard words and send them to the connected backend. */
  const delegate = async (held: Live, id: string, board = conversation.current?.selected) => {
    clearTimeout(held.delivery);
    held.waiting = undefined;
    const text = held.heard.trim(),
      heardBoard = held.heardBoard;
    held.heard = '';
    if (live.current !== held || held.paused || held.closing) return;
    if (!text) return commentary('I missed the words for that request. Please say it again.', id);
    held.record?.({ by: 'person', words: text });
    if (!held.backend.target && (conversation.current?.selected !== board || heardBoard !== board))
      return commentary('The board changed. Please repeat that request on this board.', id);
    try {
      if (/^[\s\p{P}]*stop[\s\p{P}]*$/iu.test(text)) {
        const stopping = held.backend.stoppable;
        await halt(id);
        // Mac stop receipts already describe requested, idle and refused outcomes.
        if (live.current === held && !held.backend.target)
          commentary(stopping ? 'Stop requested.' : 'Nothing is running to stop.', id);
        return;
      }
      held.timing.mark('sent');
      await router.send(held.backend, text, id);
    } catch (error) {
      if (live.current === held)
        commentary(publicError(error, 'Voice request failed. Please try again.'), id);
    }
  };

  /** Started is not yet listening: that waits until the line is connected and the microphone's
   *  sound is going out on it. A line that never gets there is said to have failed. */
  const lineUp = async (held: Live) => {
    const until = Date.now() + LINE_UP_MS;
    while (live.current === held && !held.closing && Date.now() < until) {
      const stats = await held.pc.getStats().catch(() => null);
      let sent = 0;
      stats?.forEach((report) => {
        if (report.type === 'outbound-rtp' && report.kind === 'audio')
          sent += report.packetsSent ?? 0;
      });
      if (held.pc.connectionState === 'connected' && sent > 0) {
        setState((now) =>
          now === 'connecting' ? (held.backend.pending ? 'working' : 'listening') : now,
        );
        if (held.greeting) speak(held.greeting);
        held.greeting = undefined;
        return;
      }
      await new Promise((done) => setTimeout(done, 200));
    }
    if (live.current !== held || held.closing) return;
    setProblem('The voice line did not open. Click the orb to try again.');
    teardown();
  };

  const onEvent = (event: { type?: string; [key: string]: unknown }) => {
    const held = live.current;
    if (!held || (held.closing && event.type !== 'session.closed')) return;
    const delta = typeof event.delta === 'string' ? event.delta : '';
    switch (event.type) {
      case 'session.started':
        void lineUp(held);
        break;
      case 'session.input_transcript.delta': {
        if (held.paused) break;
        held.last = Date.now();
        if (status.current.problem && status.current.problem !== SOUND_HELD) setProblem('');
        held.timing.mark('word', true);
        if (!held.heard) {
          held.heardBoard = conversation.current?.selected;
          held.record = recorder.current;
        }
        held.heard += delta;
        captions.current.heard =
          held.speaker === 'person' ? captions.current.heard + delta : delta.trimStart();
        held.speaker = 'person';
        break;
      }
      case 'session.input_speech.started':
        // Live handles barge-in on its media track; raw activity is not a command.
        held.timing.begin();
        break;
      case 'session.output_audio.cleared':
        // Only the STT/TTS adapter emits this; keep an interrupted notice queued.
        held.telling.interrupted();
        break;
      case 'session.output_audio.delta':
      case 'session.output_transcript.delta':
        held.last = Date.now();
        held.telling.voice();
        // Sound cut on this device: what the voice still makes is neither heard nor shown.
        if (held.telling.cutting) break;
        held.timing.mark('sound');
        pump();
        captions.current.said =
          held.speaker === 'voice' ? captions.current.said + delta : delta.trimStart();
        held.speaker = 'voice';
        if (status.current.state !== 'speaking') setState('speaking');
        clearTimeout(held.quiet);
        held.quiet = setTimeout(function quiet() {
          if (live.current !== held) return;
          if (held.alternative?.pending) {
            held.quiet = setTimeout(quiet, QUIET_MS);
            return;
          }
          setState(held.backend.pending ? 'working' : 'listening');
        }, QUIET_MS);
        break;
      case 'session.delegation.created': {
        const id = (event.delegation as { id: string }).id;
        if (held.paused) {
          commentary('Voice is paused. Please repeat after resuming.', id);
          break;
        }
        held.last = Date.now();
        held.timing.mark('handed');
        const board = conversation.current?.selected;
        if (held.waiting) commentary('I missed the words for the earlier request.', held.waiting);
        clearTimeout(held.delivery);
        // Final transcript words can trail the model handover by about 100 ms.
        held.waiting = id;
        held.delivery = setTimeout(() => void delegate(held, id, board), 250);
        break;
      }
      case 'session.closed':
        teardown();
        break;
      case 'error':
        setProblem(publicError(event, 'Voice hiccup. Please say that again.'));
        break;
    }
  };

  const start = async () => {
    const id = pi?.snapshot?.conversation.id;
    if (live.current || !pi || !id || !pi.transport.voice) return;
    setProblem('');
    captions.current = { heard: '', said: '' };
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
      const backend: VoiceBackend = router.open({
        fullAnswer: pi.snapshot?.conversation.model === ALTERNATIVE_MODEL,
        current: () => live.current?.backend === backend,
        state: setState,
        problem: setProblem,
        commentary: (text, delegation) => commentary(text, delegation),
        // What the system says first waits its turn and the person's pause (voice-lines.ts).
        report: (text, delegation) => speak(text, { delegation, kept: true }),
        progress: (text) => speak(text, { label: 'Progress' }),
        acknowledge: (delegation) => {
          // Only the alternative transport needs this receipt. Send it immediately through
          // the same interruptible audio path, without an LLM turn or a delayed timer.
          if (live.current?.backend === backend && live.current.alternative)
            send('session.commentary.append', 'One moment.', delegation);
        },
        speak,
        clear: () => {
          live.current?.telling.clear();
        },
        // The answer comes after the lines, which it never drops: one still waiting is said first.
        finish: () => {
          if (live.current) live.current.last = Date.now();
        },
        last: () => live.current?.last ?? Date.now(),
        queued: () => !!live.current?.telling.behind || !!live.current?.alternative?.pending,
        drawing: () => drawing.current(),
        steer: () => setSteered((times) => times + 1),
        // Only the line's own agent can give it back, and only while it still holds the line.
        back: () => {
          if (live.current?.backend === backend) connect(null);
        },
      });
      const target = backend.target ?? undefined;
      const mine = (): Live | null => (live.current && live.current === held ? held : null);
      const port: TellingPort = {
        now: () => Date.now(),
        send: (line, delegation) => {
          const on = mine();
          if (!on) return false;
          if (
            send(
              'session.commentary.append',
              line,
              delegation === undefined ? on.backend.delegation : delegation,
            ) === false
          )
            return false;
          on.last = Date.now();
          on.timing.mark('line');
        },
        mute: (off) => {
          const on = mine();
          if (!on) return;
          on.cut = off;
          on.audio.muted = off || !!on.paused;
        },
        // The alternative line knows what it still has to play; the other is listened to.
        level: () => (mine()?.output && !mine()!.alternative ? level(mine()!.output) : undefined),
        pending: () => mine()?.alternative?.pending,
      };
      const telling = new Telling(port);
      const timing = new VoiceTiming((ms) => {
        const drawer = backend.target?.provider ?? 'merv';
        const model =
          drawer === 'merv' ? conversation.current?.snapshot?.conversation.model : undefined;
        void pi.transport
          .voiceTiming?.({ drawer, ...(model && { model }), ms })
          .catch(() => undefined);
      });
      held = {
        pc,
        dc,
        audio,
        context,
        heard: '',
        last: Date.now(),
        telling,
        timing,
        backend,
        greeting: router.takeGreeting(),
      };
      live.current = held;
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: VOICE_MIC,
      });
      if (live.current !== held) return void mic.getTracks().forEach((track) => track.stop());
      const input = context.createAnalyser();
      input.fftSize = 512;
      context.createMediaStreamSource(mic).connect(input);
      Object.assign(held, { mic, input });
      for (const track of mic.getAudioTracks()) track.enabled = !micMuted.current;
      // Explicitly selected alternative: failures never fall back to sending audio to OpenAI.
      if (pi.snapshot?.conversation.model === ALTERNATIVE_MODEL) {
        if (!pi.transport.voiceOptions || !pi.transport.alternativeVoice)
          throw new PublicError('Alternative mode is unavailable.');
        const options = await pi.transport.voiceOptions();
        if (live.current !== held) return;
        {
          if (!options.alternative)
            throw new PublicError(
              'Alternative voice is unavailable for this account. Choose another model explicitly to switch.',
            );
          const grant = await pi.transport.alternativeVoice(id);
          if (live.current !== held) return;
          const alternative = new AlternativeVoiceLine(context, (event) => {
            if (live.current === held) onEvent(event);
          });
          held.alternative = alternative;
          held.output = alternative.output;
          await alternative.start(grant, mic, () => pi.transport.alternativeVoice!(id));
          if (live.current !== held) return;
          setState(held.backend.pending ? 'working' : 'listening');
          if (held.greeting) speak(held.greeting);
          held.greeting = undefined;
          for (const track of mic.getTracks())
            track.onended = () => {
              if (live.current === held) {
                setProblem('The microphone stopped.');
                teardown();
              }
            };
          pi.warmUp();
          return;
        }
      }
      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream || live.current !== held) return;
        audio.srcObject = stream;
        // Started with no press (the board app, on sign-in), a browser may hold the sound until one.
        void audio.play().catch(() => {
          if (live.current !== held) return;
          held!.allowSound?.();
          setProblem(SOUND_HELD);
          const allow = () => {
            held!.allowSound?.();
            setProblem('');
            void context.resume();
            void audio.play().catch(() => undefined);
          };
          held!.allowSound = () => {
            removeEventListener('pointerdown', allow, true);
            removeEventListener('keydown', allow, true);
          };
          addEventListener('pointerdown', allow, true);
          addEventListener('keydown', allow, true);
        });
        const output = context.createAnalyser();
        output.fftSize = 512;
        context.createMediaStreamSource(stream).connect(output);
        held!.output = output;
      };
      for (const track of mic.getTracks()) {
        pc.addTrack(track, mic);
        // The microphone unplugged or taken away: nothing is heard any more, so voice says so.
        track.onended = () => {
          if (live.current !== held) return;
          setProblem('The microphone stopped.');
          teardown();
        };
      }
      // The line gone quietly is voice over, as a closed session is.
      dc.onclose = () => live.current === held && teardown();
      dc.onmessage = (message) => {
        if (live.current !== held) return;
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
      if (live.current !== held) return;
      const answer = await pi.transport.voice(
        id,
        pc.localDescription!.sdp,
        target && { provider: target.provider, title: target.title },
      );
      if (live.current !== held) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      if (live.current !== held) return;
      // The machine starts now, so the first request does not wait for it.
      pi.warmUp();
    } catch (cause) {
      if (live.current === held || !held) {
        setProblem(publicError(cause, 'Voice could not start. Click the orb to try again.'));
        teardown();
      }
    }
  };

  const again = useRef(start);
  again.current = start;

  // Typed input is an explicit UI interruption; Live cannot hear it.
  const stepIn = useRef(() => {});
  stepIn.current = () => {
    if (!live.current) return;
    clearInput();
    quiet();
    setSteered((times) => times + 1);
  };
  useEffect(() => {
    const typed = () => stepIn.current();
    window.addEventListener(TYPED, typed);
    return () => window.removeEventListener(TYPED, typed);
  }, []);

  useEffect(() => live.current?.backend.watch());
  // Close the old speech connection when the server commits a model switch.
  // The next explicit microphone start uses the newly selected pair.
  const selectedModel = pi?.snapshot?.conversation.model;
  const previousModel = useRef(selectedModel);
  useEffect(() => {
    if (
      previousModel.current !== selectedModel &&
      (previousModel.current === ALTERNATIVE_MODEL || selectedModel === ALTERNATIVE_MODEL)
    )
      stop();
    previousModel.current = selectedModel;
  }, [selectedModel]);

  // No time limit; a session nobody has spoken in, with nothing pending, closes itself, and so
  // does one whose page is put away.
  useEffect(() => {
    if (state === 'off') return;
    const watch = setInterval(() => {
      const held = live.current;
      if (
        held &&
        !held.backend.pending &&
        !held.alternative?.pending &&
        Date.now() - held.last > IDLE_MS
      )
        stop();
    }, 5_000);
    const away = () => document.visibilityState === 'hidden' && stop();
    document.addEventListener('visibilitychange', away);
    return () => {
      clearInterval(watch);
      document.removeEventListener('visibilitychange', away);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state === 'off']);

  useEffect(
    () => () => {
      teardown();
      router.close();
    },
    [],
  );

  return {
    compact,
    setCompact,
    paused,
    pause: () => {
      const held = live.current;
      if (!held) return;
      const next = !paused;
      held.paused = next;
      if (next) clearInput();
      held.audio.muted = next || !!held.cut;
      for (const track of held.mic?.getAudioTracks() ?? [])
        track.enabled = !next && !micMuted.current;
      send(next || muted ? 'session.input_audio.mute' : 'session.input_audio.unmute');
      setPaused(next);
    },
    state,
    captions,
    problem,
    muted,
    start: () => void start(),
    stop,
    hush,
    halt: () => halt(),
    /** Merv's own lines (news of the agents, the tour): not said while the line is an agent's.
     *  inked marks a line the pen says as it draws, which the board already keeps on its shape. */
    speak: (line: string, inked?: boolean) => {
      if (inked) ink(line);
      live.current?.backend.saying(line);
    },
    /** News of the person's agents (a worker or job finished, needs them): said in whichever voice
     *  is on, Merv's or an agent's, at the person's next pause, and kept until said or stopped. */
    notice: (line: string, sent?: () => void, dropped?: () => void) =>
      speak(line, { label: 'News', kept: true, delegation: null, sent, dropped }),
    /** The agent on the Mac whose drawn lines the voice says as its pen reaches them, if any. */
    agentVoicing: () => live.current?.backend.voicing,
    /** A line an agent drew and the pen just reached, with who drew it: said only in that agent's own voice. */
    agentSaid: (line: string, by: string) => {
      ink(line);
      live.current?.backend.saying(line, by);
    },
    /** Set by the open board: every line said aloud from here on goes onto its timeline. */
    recorder,
    /** The agent on the Mac the voice is connected to, or none for Merv. */
    route,
    connect,
    /** The exact, ordered candidates for the spoken description, shared with the board picker. */
    choice,
    dismissChoice: () => {
      if (router.hasChoice) clearInput();
      dismissChoice();
    },
    /** A picker selection supersedes pending spoken work while keeping its candidates visible. */
    cancelSpokenConnect: () => {
      clearInput();
      cancelSpokenConnect();
    },
    steered,
    /** Counts the times the person said to stop: what is drawing stops being played. */
    halted,
    drawing,
    /** A line is waiting its turn to be said: the pen waits with it, so words and ink stay together. */
    behind: () => !!live.current?.telling.behind,
    /** A moment of the open board's own for the timing record: new ink fetched, the pen at a shape. */
    mark: (moment: 'ink' | 'pen') => live.current?.timing.mark(moment),
    mute: () => {
      const held = live.current;
      if (!held) return;
      const next = !micMuted.current;
      for (const track of held.mic?.getAudioTracks() ?? []) track.enabled = !next && !held.paused;
      send(next || paused ? 'session.input_audio.mute' : 'session.input_audio.unmute');
      setMuted(next);
    },
    /** How loud the person and the voice are right now, 0 to 1. */
    levels: () => ({ input: level(live.current?.input), output: level(live.current?.output) }),
  };
}
export type Voice = ReturnType<typeof useVoice>;
