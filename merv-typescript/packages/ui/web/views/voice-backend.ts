import type { VoiceTarget } from './desk-voice';
export type { VoiceTarget, VoiceChoice } from './desk-voice';
export type VoiceState = 'off' | 'connecting' | 'listening' | 'working' | 'speaking' | 'closing';
export const QUIET_MS = 1_400;
const SAYABLE = 1_800;

/** A backend owns its turn and watchers; the line owns sound, narration and connection lifetime. */
export interface VoiceBackend {
  readonly target: VoiceTarget | null;
  readonly pending: boolean;
  readonly stoppable: boolean;
  readonly delegation?: string;
  /** `delegation` is the voice's own hand-over, or '' when the page handed the words over itself. */
  send(text: string, delegation: string): Promise<void>;
  /** The voice handed over, late, the request the page already sent: its answer goes to that delegation. */
  adopt?(delegation: string): void;
  stop(delegation?: string): void | Promise<void>;
  watch(): void;
  /** A line to say. With by, it is one an agent drew and the pen just reached on the open board: this voice says it, whoever drew it. */
  saying(line: string, by?: string): void;
  /** The agent on the Mac whose drawn lines this voice says now, if any. */
  readonly voicing?: string;
  close(): void;
}
export interface VoiceOutput {
  /** Read the complete answer through a supplied-text speech transport. */
  readonly fullAnswer?: boolean;
  current(): boolean;
  state(state: 'working' | 'listening'): void;
  problem(message: string): void;
  /** Said now: the reply to what the person just asked (a refusal, "Stopped.", a choice). */
  commentary(text: string, delegation: string): void;
  /** Said first by the system (a turn's result, a lost turn): kept, and said at the person's next
   *  pause, never over them. A request just handed over is answered at once, since they are silent. */
  report(text: string, delegation: string): void;
  /** A step an agent finished while it works, offered to the voice, which says it only if it matters. */
  progress?(text: string): void;
  /** A fixed receipt while dispatching a request, never an answer or completion claim. */
  acknowledge?(delegation: string): void;
  speak(text: string): void;
  clear(): void;
  finish(): void;
  last(): number;
  queued(): boolean;
  drawing(): boolean;
  steer(): void;
  /** The connected agent handed the voice back: Merv takes the line again. */
  back(): void;
}

/**
 * Who says a line the pen reached on the open board: whenever the voice is on, somebody does. The
 * line's own voice says it, Merv's or the connected agent's, whoever drew it, so a person always
 * hears whoever is drawing. With the voice off it stays a caption.
 */
export const sayer = (state: VoiceState | undefined, agent: boolean): 'pi' | 'agent' | undefined =>
  !state || state === 'off' || state === 'closing' ? undefined : agent ? 'agent' : 'pi';

/** Screen text for speech. Full narration preserves table cells and code; GPT keeps its brief preview. */
export function sayable(markdown: string, full = false): string {
  // A brief preview skips code blocks and tables without saying so.
  const text = markdown
    .replace(/```[\s\S]*?```/g, (block) => (full ? block.replace(/^```[^\n]*\n?|```$/g, '') : ' '))
    .split('\n')
    .filter((line) => (full ? !/^\s*\|?[\s:|-]+\|\s*$/.test(line) : !/^\s*\|/.test(line)))
    .map((line) => (full ? line.replace(/^\s*\||\|\s*$/g, '').replace(/\s*\|\s*/g, ', ') : line))
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_`~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return full || text.length <= SAYABLE
    ? text
    : `${text.slice(0, SAYABLE).replace(/[^.!?]*$/, '') || text.slice(0, SAYABLE)}`;
}

/** How long a finished turn's answer waits on a telling that has stood still (nothing said, though ink
 *  or lines remain) before it goes anyway. A telling that is still moving is never cut into. */
const STALLED_MS = 60_000;
/** Whether a finished turn's answer must still wait: there is ink to draw or a line to say, and the
 *  voice has said something within STALLED_MS of now or of the turn's end. */
export const stillTelling = (
  out: Pick<VoiceOutput, 'drawing' | 'queued' | 'last'>,
  ended: number,
  now = Date.now(),
) =>
  (out.drawing() || out.queued() || now - out.last() < QUIET_MS) &&
  now - Math.max(ended, out.last()) < STALLED_MS;

const CLOSING_WORDS = 25;
/**
 * What is said of a turn's answer when the turn was told aloud as it was drawn: its first sentence,
 * at most 25 words. The explanation was the lines; an answer that explains it again is not read out.
 */
export function closingOf(answer: string): string {
  const text = sayable(answer);
  const first = /^.*?[.!?。](?=\s|$)/.exec(text)?.[0] ?? text;
  const words = first.split(/\s+/).filter(Boolean);
  return words.length <= CLOSING_WORDS
    ? first
    : `${words
        .slice(0, CLOSING_WORDS)
        .join(' ')
        .replace(/[,;:]$/, '')}.`;
}

/** How long an agent has worked before its first step is offered to the voice, and how long after one
 *  step is offered the next may be. */
const PROGRESS_MS = 20_000;
/**
 * Which of an agent's finished steps reach the voice while it works. Whether one is said is the voice
 * model's choice (the progress rule in its instructions): only a step that changes what the person
 * knows or must decide. This gate only keeps it from being flooded: a quick turn offers nothing, since
 * its result says it all; after that, at most one step every PROGRESS_MS, always the newest, never a
 * repeat, with how many are done so far.
 */
export class ProgressGate {
  private seen = new Set<string>();
  private offeredAt: number;
  private waiting?: string;
  private offered?: string;
  private done = 0;
  constructor(started: number) {
    this.offeredAt = started;
  }
  /** The step to offer the voice now, given every step the turn has done so far, oldest first. */
  next(steps: readonly { id: string; text: string }[], now: number): string | undefined {
    for (const step of steps) {
      if (this.seen.has(step.id)) continue;
      this.seen.add(step.id);
      this.done++;
      const text = step.text.trim();
      if (text && text !== this.offered) this.waiting = text;
    }
    if (!this.waiting || now - this.offeredAt < PROGRESS_MS) return;
    const line = `${this.done} ${this.done === 1 ? 'step' : 'steps'} done so far. Latest: ${this.waiting.replace(/[.!?]*$/, '')}.`;
    this.offered = this.waiting;
    this.waiting = undefined;
    this.offeredAt = now;
    return line;
  }
}
