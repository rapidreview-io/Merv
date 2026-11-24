/** Serializes backend narration and handles explicit UI cuts.
 * Live owns spoken interruptions and when to speak supplied commentary.
 */
import { QUIET_MS } from './voice-backend';

/** How long the voice's own sound must have been still, after sounding, to have finished a line. */
export const SETTLE_MS = 350;
/** How long after the voice's last word, at the least, before its line counts as finished. */
const WORD_MS = 250;
/** After a cut, sound stays off until the voice has been still this long, and no longer than this. */
const [CUT_STILL_MS, MOST_CUT_MS] = [350, 5_000];
/** How loud the voice's sound is while it speaks, and how quiet when it does not (0 to 1). */
const [LOUD, STILL] = [0.06, 0.02];
/** How often it looks while something is under way. */
const LOOK_MS = 100;
/** One line on its way. `delegation`, when set, is the request it answers; null is session-wide news. A kept line (a turn's
 *  result, news of finished work) is the system speaking first: a new request does not drop it,
 *  only an explicit stop does. The model decides when to say it. */
export interface Told {
  line: string;
  delegation?: string | null;
  kept?: boolean;
  /** What kind of message it is to the voice ("News"): it goes as "News: …", and several of one
   *  kind waiting together go as one message, which the voice may say as one line. */
  label?: string;
  /** Told once the line goes to the voice (merged with others of its kind, when that one goes): what is said is then
   *  heard, so whoever handed it over may mark it told. A line dropped before it goes is never reported. */
  sent?: () => void;
  /** Told when the line is let go unsaid: dropped by a stop or a closing voice, or refused by a voice still connecting. */
  dropped?: () => void;
}

export interface TellingPort {
  now(): number;
  /** Hands one line to the voice to say, for the request it answers when it names one. Answers false when the voice
   *  could not take it (still connecting, or gone): then it is not said. */
  send(line: string, delegation?: string | null): boolean | void;
  /** Turns the voice's sound off or on, on this device, at once. */
  mute(off: boolean): void;
  /** How loud the voice is right now, where its sound can be measured. */
  level?(): number | undefined;
  /** Whether the voice still has sound of its own to play, where it can say so. */
  pending?(): boolean | undefined;
}

export class Telling {
  private lines: Told[] = [];
  /** The line the voice has and has not finished: when it went, and what was heard of it. */
  private saying?: Told & { at: number; heard: boolean; still?: number };
  private voiceAt = 0;
  private cutAt = 0;
  constructor(private io: TellingPort) {}
  /** Lines waiting for the voice: the pen waits with them. */
  get behind() {
    return this.lines.length > 0;
  }
  /** Whether sound is off after a cut. */
  get cutting() {
    return this.cutAt > 0;
  }
  speak(line: string, options: Omit<Told, 'line'> = {}) {
    this.lines.push({ line, ...options });
  }
  /** The voice made a sound or said a word. */
  voice() {
    this.voiceAt = this.io.now();
    if (this.saying) this.saying.heard = true;
  }
  /** The STT/TTS adapter cancelled playback. Keep important notices for retry. */
  interrupted() {
    if (this.saying?.kept) this.lines.unshift(this.saying);
    this.saying = undefined;
  }
  /** Drops what waits: a new request drops the lines of the old one, a stop (`all`) everything.
   *  A kept line survives a new request: news is still news. */
  clear(all = false) {
    const gone = all ? this.lines : this.lines.filter((told) => !told.kept);
    this.lines = all ? [] : this.lines.filter((told) => told.kept);
    for (const told of gone)
      try {
        told.dropped?.();
      } catch {
        /* the caller's own */
      }
  }
  /** Sound off, now, on this device: no model is asked first. What waits is for the caller to drop. */
  cut() {
    this.cutAt = this.io.now();
    this.saying = undefined;
    this.io.mute(true);
  }
  /**
   * Looks at where things stand and sends the next line if its time has come. Answers in how many
   * milliseconds to look again, or nothing when there is nothing left to wait for.
   */
  tick(): number | undefined {
    const now = this.io.now();
    const level = this.io.level?.();
    if (this.cutAt) {
      const still =
        now - Math.max(this.voiceAt, this.cutAt) >= CUT_STILL_MS &&
        !(level !== undefined && level > LOUD);
      if (!still && now - this.cutAt < MOST_CUT_MS) return LOOK_MS;
      this.cutAt = 0;
      this.io.mute(false);
    }
    const saying = this.saying;
    if (saying) {
      if (level !== undefined && level > LOUD) saying.heard = true;
      if (level !== undefined && level < STILL) saying.still ??= now;
      else saying.still = undefined;
      const pending = this.io.pending?.();
      // The voice says it has finished where it can; else its sound having stopped says so; else,
      // as before there was either, a fixed quiet after its last word.
      const finished =
        pending !== undefined
          ? !pending && now - saying.at >= WORD_MS
          : saying.heard &&
            saying.still !== undefined &&
            now - saying.still >= SETTLE_MS &&
            now - this.voiceAt >= WORD_MS;
      if (!finished && (pending === true || now - Math.max(saying.at, this.voiceAt) < QUIET_MS))
        return LOOK_MS;
      this.saying = undefined;
    }
    if (!this.lines.length) return;
    let told = this.lines.shift()!;
    const parts = [told];
    if (told.label) {
      const same: string[] = [told.line];
      while (this.lines[0]?.label === told.label) {
        const next = this.lines.shift()!;
        same.push(next.line);
        parts.push(next);
      }
      told = { ...told, line: `${told.label}: ${same.join(' ')}`, label: undefined };
    }
    this.saying = { ...told, sent: undefined, dropped: undefined, at: now, heard: false };
    const went = this.io.send(told.line, told.delegation) !== false;
    if (!went) this.saying = undefined;
    for (const part of parts)
      try {
        (went ? part.sent : part.dropped)?.();
      } catch {
        /* the caller's own */
      }
    return LOOK_MS;
  }
}

/** One short falling tone, played on this device, that says a stop was taken: no model speaks it. */
export function blip(context: AudioContext | undefined) {
  try {
    if (!context || context.state === 'closed') return;
    const at = context.currentTime;
    const tone = context.createOscillator();
    const loud = context.createGain();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(660, at);
    tone.frequency.exponentialRampToValueAtTime(330, at + 0.14);
    loud.gain.setValueAtTime(0.0001, at);
    loud.gain.exponentialRampToValueAtTime(0.18, at + 0.015);
    loud.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    tone.connect(loud).connect(context.destination);
    tone.start(at);
    tone.stop(at + 0.18);
  } catch {
    /* no sound here: the orb still shows it */
  }
}
