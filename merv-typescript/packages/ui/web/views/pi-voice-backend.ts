import { publicError } from '../errors';
import type { PiCommand, PiSnapshot } from '@merv/pi/models';
import type { Conversation } from './pi-conversation';
import {
  closingOf,
  sayable,
  stillTelling,
  type VoiceBackend,
  type VoiceOutput,
} from './voice-backend';

/** How long a drawing turn's answer gives the page to bring its last ink, and how often it looks. */
const [LAST_INK_MS, PEN_LOOK_MS] = [1_500, 250];

/** What GPT-Live is told when Pi's turn for a request ends. */
function resultOf(command: PiCommand, full = false, told = false): string {
  const answer = [...command.messages].reverse().find((m) => m.role === 'assistant')?.text ?? '';
  // Told aloud as it was drawn, its closing is one short sentence: the rest was the lines.
  const parts = [answer ? (told ? closingOf(answer) : sayable(answer, full)) : ''];
  if (command.status === 'interrupted')
    parts.push(
      command.error
        ? publicError({ code: command.error }, 'Merv stopped before finishing. Please try again.')
        : 'Merv stopped before finishing.',
    );
  return `Result: ${parts.filter(Boolean).join(' ') || 'Pi finished without saying anything.'}`;
}

/** Pi's turn correlation, pen wait and watching a conversation after the person leaves it. */
export class PiVoiceBackend implements VoiceBackend {
  readonly target = null;
  private request?: { delegation: string; text: string; after: number; id: string | null };
  private ended?: number;
  private answering?: ReturnType<typeof setTimeout>;
  private away?: string;
  private snapshot?: PiSnapshot | null;
  private timer?: ReturnType<typeof setInterval>;
  /** How many lines of this request's turn were said as its pen reached them. */
  private lines = 0;
  /** Turns whose ending this voice has dealt with: answered aloud, or over before it was listening. */
  private settled = new Set<string>();
  private settledIn?: string;
  /** A typed turn that ended, whose answer waits on the pen and the lines: with the voice on, it is said too. */
  private typed?: { id: string; ended: number; timer?: ReturnType<typeof setTimeout> };
  /** How many lines were said while no spoken request was pending: a typed turn's own. */
  private typedLines = 0;
  constructor(
    private conversation: () => Conversation | null,
    private out: VoiceOutput,
  ) {}
  get pending() {
    return !!this.request;
  }
  get stoppable() {
    return !!(this.conversation()?.active || this.request);
  }
  get delegation() {
    return this.request?.delegation;
  }
  /** Every line the pen reaches on the open board is said: Pi's own, and another agent's while this
   *  voice is the one that is on. Only Pi's own count towards its turn having been told aloud. */
  saying(line: string, by?: string) {
    if (by === undefined) this.request ? this.lines++ : this.typedLines++;
    this.out.speak(line);
  }
  adopt(delegation: string) {
    if (this.request) this.request = { ...this.request, delegation };
  }
  async send(text: string, delegation: string) {
    const pi = this.conversation(),
      out = this.out;
    // Said, so the voice never fills the silence with a guess of its own.
    if (!pi) return out.commentary('Merv is still starting. Ask me again in a moment.', delegation);
    out.clear();
    // A turn over but still drawing and still to answer stops as one that runs does.
    if (pi.active || this.request) out.steer();
    clearTimeout(this.answering);
    this.ended = undefined;
    // A request waiting in another conversation is not this one's, and one whose turn is over is
    // superseded: its answer is left unsaid.
    const before = pi.active && this.request?.id === pi.selected ? this.request : undefined;
    const after = (pi.snapshot?.commands.length ?? 0) - (pi.active ? 1 : 0);
    if (!before) this.lines = 0;
    this.request = before
      ? { ...before, delegation }
      : { delegation, text, after, id: pi.selected };
    out.state('working');
    out.acknowledge?.(delegation);
    const sent = await pi.send(text, undefined, true);
    if (!sent && out.current()) {
      this.request = before;
      out.state(before ? 'working' : 'listening');
      out.commentary('Pi could not take that request just now.', delegation);
    }
  }
  stop() {
    this.request = undefined;
    this.close();
    return this.conversation()?.stop();
  }
  /** Once the turn sent for a request has ended in its conversation and its pen and lines are done,
   *  its answer goes back for GPT-Live to say: words and ink run together, and the answer comes last. */
  private answered = (snapshot?: PiSnapshot | null) => {
    const pending = this.request,
      out = this.out;
    if (!out.current() || !pending || !snapshot) return;
    if (pending.id && snapshot.conversation.id !== pending.id) return;
    const turn = snapshot.commands
      .slice(pending.after)
      .find((command) =>
        command.messages.some((m) => m.role === 'user' && m.text.trim() === pending.text),
      );
    if (!turn || (turn.status !== 'completed' && turn.status !== 'interrupted')) return;
    clearTimeout(this.answering);
    const now = Date.now();
    const since = now - (this.ended ??= now);
    const drew = turn.outcomes.some((outcome) => outcome.name === 'board.write');
    // A turn typed since then has the pen now: this answer waits on nothing.
    if (
      !this.conversation()?.active &&
      ((drew && since < LAST_INK_MS) || stillTelling(out, this.ended, now))
    ) {
      this.answering = setTimeout(() => this.answered(this.conversation()?.snapshot), PEN_LOOK_MS);
      return;
    }
    this.request = undefined;
    this.ended = undefined;
    this.close();
    out.finish();
    if (turn.id) this.settled.add(turn.id);
    out.report(resultOf(turn, out.fullAnswer, this.lines > 0), pending.delegation);
    this.lines = 0;
    this.typedLines = 0;
    out.state('listening');
  };
  /**
   * With the voice on, a typed question is answered aloud as a spoken one is: its answer is said
   * when its turn ends and its pen and lines are done. Turns over before this voice was listening,
   * and turns the person stopped, are not.
   */
  private typedAnswer(snapshot?: PiSnapshot | null) {
    const out = this.out;
    if (!snapshot || !out.current()) return;
    if (this.settledIn !== snapshot.conversation.id) {
      // A conversation first seen: what is already over in it was never this voice's to say.
      this.settledIn = snapshot.conversation.id;
      this.dropTyped();
      for (const command of snapshot.commands)
        if (command.id && (command.status === 'completed' || command.status === 'interrupted'))
          this.settled.add(command.id);
      return;
    }
    if (this.request) return;
    const turn = snapshot.commands.at(-1);
    if (!turn?.id || this.settled.has(turn.id)) return;
    if (turn.status === 'interrupted') {
      this.settled.add(turn.id);
      this.typedLines = 0;
      return;
    }
    if (turn.status !== 'completed') return;
    if (this.typed?.id !== turn.id) {
      this.dropTyped();
      this.typed = { id: turn.id, ended: Date.now() };
    }
    const typed = this.typed!,
      now = Date.now();
    clearTimeout(typed.timer);
    const drew = turn.outcomes.some((outcome) => outcome.name === 'board.write');
    if (
      !this.conversation()?.active &&
      ((drew && now - typed.ended < LAST_INK_MS) || stillTelling(out, typed.ended, now))
    ) {
      typed.timer = setTimeout(() => this.typedAnswer(this.conversation()?.snapshot), PEN_LOOK_MS);
      return;
    }
    this.typed = undefined;
    this.settled.add(turn.id);
    const told = this.typedLines > 0;
    this.typedLines = 0;
    out.finish();
    out.report(resultOf(turn, out.fullAnswer, told), '');
  }
  private dropTyped() {
    clearTimeout(this.typed?.timer);
    this.typed = undefined;
  }
  watch() {
    const pi = this.conversation();
    if (this.snapshot !== pi?.snapshot) {
      this.snapshot = pi?.snapshot;
      this.answered(pi?.snapshot);
      this.typedAnswer(pi?.snapshot);
    }
    // Another conversation opened meanwhile: the request's own is read, at once and every few
    // seconds, until its turn ends.
    const away =
      this.request?.id !== pi?.snapshot?.conversation.id
        ? (this.request?.id ?? undefined)
        : undefined;
    if (away === this.away) return;
    clearInterval(this.timer);
    this.away = away;
    if (!away) return;
    const look = () => void pi?.transport.snapshot(away).then(this.answered, () => {});
    look();
    this.timer = setInterval(look, 5_000);
  }
  close() {
    clearTimeout(this.answering);
    clearInterval(this.timer);
    this.away = undefined;
    this.dropTyped();
  }
}
