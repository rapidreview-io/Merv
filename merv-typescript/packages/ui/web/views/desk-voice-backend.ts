import { publicError } from '../errors';
import { agentName, readTarget, stopTarget, tellTarget, type VoiceTarget } from './desk-voice';
import {
  ProgressGate,
  QUIET_MS,
  closingOf,
  sayable,
  stillTelling,
  type VoiceBackend,
  type VoiceOutput,
} from './voice-backend';

/** How often a request to an agent on the Mac is looked at while its turn runs. */
const AGENT_LOOK_MS = 1_000;
/** How long after its turn ends an agent's last ink keeps its voice: far longer than Pi's few
 *  seconds, since a Mac agent's draw calls come further apart. */
const AGENT_LAST_INK_MS = 20_000;
/** When the agent hands the voice back, its goodbye is said first: looked at this often, for at most this long. */
const [BACK_LOOK_MS, MOST_GOODBYE_MS] = [250, 10_000];

/** One Mac session's request, approval announcement and live turn watcher. */
export class DeskVoiceBackend implements VoiceBackend {
  private asked?: { delegation: string; command: string; asking?: string };
  private command?: string;
  private timer?: ReturnType<typeof setInterval>;
  /** When its last turn ended, and when the Mac first said this one ended while its answer waits on the pen. */
  private ended?: number;
  private done?: number;
  /** Set once the agent handed the voice back: its goodbye is being said, then Merv takes the voice. */
  private leaving?: ReturnType<typeof setInterval>;
  /** How many lines of this request's turn were said as the agent's pen reached them. */
  private lines = 0;
  /** Which of this request's finished steps are offered to the voice while it works. */
  private progress?: ProgressGate;
  readonly stoppable = true;
  constructor(
    readonly target: VoiceTarget,
    private out: VoiceOutput,
  ) {}
  get pending() {
    return !!this.asked;
  }
  /** Its agent's own lines as its pen reaches them, while its turn runs and a while after; Merv's own
   *  lines, and any other agent's, are not said in this voice. */
  get voicing() {
    return this.asked || (this.ended !== undefined && Date.now() - this.ended < AGENT_LAST_INK_MS)
      ? agentName(this.target.provider)
      : undefined;
  }
  saying(line: string, by?: string) {
    // Its agent's own lines count towards its turn having been told aloud; any drawn line is said,
    // since this is the voice that is on. Merv's own news lines (no by) are not this voice's to say.
    if (!by) return;
    if (by === this.voicing && this.asked) this.lines++;
    this.out.speak(line);
  }
  adopt(delegation: string) {
    if (this.asked) this.asked = { ...this.asked, delegation };
  }
  async send(text: string, delegation: string) {
    const out = this.out;
    // The agent already gave the voice back: these words are for no one here, so Merv takes over now.
    if (this.leaving) return this.handBack(true);
    out.clear();
    this.done = undefined;
    // A second request while one runs steers that turn: the answer then is the turn's, for both.
    if (this.asked) this.asked = { ...this.asked, delegation };
    else {
      this.lines = 0;
      this.progress = new ProgressGate(Date.now());
    }
    out.state('working');
    out.acknowledge?.(delegation);
    const sent = await tellTarget(this.target, text);
    if (!out.current()) return;
    if ('refused' in sent) {
      if (!this.asked) out.state('listening');
      return out.commentary(sent.refused, delegation);
    }
    this.asked = { delegation, command: sent.command };
    out.state('working');
    this.watch();
  }
  stop(delegation?: string) {
    this.cancelLeaving();
    this.asked = undefined;
    this.ended = undefined;
    this.done = undefined;
    this.close();
    this.out.state('listening');
    return stopTarget(this.target).then((result) => {
      if (!this.out.current()) return;
      const name = agentName(this.target.provider);
      const reply =
        result === 'requested'
          ? `Asked ${name} to stop.`
          : result === 'idle'
            ? `That ${name} session appears idle.`
            : result === 'refused'
              ? `The stop request was refused. ${name} may still be running; check the session.`
              : `I couldn't confirm the stop request. ${name} may still be running; check the session.`;
      if (delegation) this.out.commentary(reply, delegation);
      else this.out.speak(reply);
    });
  }
  /** While an agent works on a request, its turn is read from the Mac: the OK it waits for is said
   *  once, and when its turn ends and its pen and lines are done, its own last words are what the voice says back. */
  watch() {
    const command = this.asked?.command;
    if (command === this.command) return;
    this.close();
    this.command = command;
    if (!command) return;
    const target = this.target,
      out = this.out;
    let looking = false;
    const look = async () => {
      if (looking) return;
      looking = true;
      const read = await readTarget(target, command).catch((error: Error) => error);
      looking = false;
      const asked = this.asked;
      if (!out.current() || asked?.command !== command) return;
      if (read instanceof Error) {
        this.asked = undefined;
        this.close();
        out.state('listening');
        out.problem(
          publicError(read, 'The connection to your Mac is paused. Reconnect to try again.'),
        );
        return out.report(
          `I lost your Mac, so I can't say whether that finished.`,
          asked.delegation,
        );
      }
      const turn = read.turn;
      if (turn?.asking && turn.asking !== asked.asking) {
        asked.asking = turn.asking;
        out.speak(`${agentName(target.provider)} needs your OK to go on.`);
      }
      if (!turn || !['done', 'failed', 'stopped', 'unknown'].includes(turn.state)) {
        // Its steps so far, a few and seldom: the voice says one only if it matters to the person.
        const step = turn && !turn.asking && this.progress?.next(turn.steps ?? [], Date.now());
        if (step) out.progress?.(step);
        return;
      }
      // Words and ink run together and the answer comes last: it waits on the pen and the lines still to say.
      const now = Date.now();
      if (stillTelling(out, (this.done ??= now), now)) return;
      this.done = undefined;
      this.ended = now;
      this.asked = undefined;
      this.close();
      out.finish();
      // Told aloud as it was drawn, its closing is one short sentence: the rest was the lines.
      const said = turn.answer
        ? this.lines > 0
          ? closingOf(turn.answer)
          : sayable(turn.answer, out.fullAnswer)
        : '';
      this.lines = 0;
      const result =
        turn.state === 'unknown'
          ? `I lost track of that turn, so I can't say how it ended. Ask again if you need the answer.`
          : turn.state === 'stopped'
            ? `${agentName(target.provider)} stopped.${said ? ` ${said}` : ''}`
            : turn.failed || turn.state === 'failed'
              ? `${agentName(target.provider)} hit a problem. ${said}`
              : said || `${agentName(target.provider)} finished without saying anything.`;
      out.report(`Result: ${result.trim()}`, asked.delegation);
      out.state('listening');
      // The agent itself asked to give the voice back, in this very turn: once its goodbye is said, Merv has it.
      if (turn.back) this.handBack();
    };
    void look();
    this.timer = setInterval(look, AGENT_LOOK_MS);
  }
  /** Waits for the goodbye to be said and a moment of quiet, then hands the line back to Merv. */
  private handBack(now = false) {
    const out = this.out,
      from = Date.now();
    let looks = 0,
      timer: ReturnType<typeof setInterval> | undefined;
    const look = () => {
      // Each hand-back happens once: a look from a cancelled wait does nothing.
      if (!now && this.leaving !== timer) return;
      if (!out.current()) return this.cancelLeaving();
      const said = out.last() > from,
        quiet = Date.now() - out.last() >= QUIET_MS && !out.queued();
      if (!now && ++looks * BACK_LOOK_MS < MOST_GOODBYE_MS && !(said && quiet)) return;
      this.cancelLeaving();
      out.back();
    };
    if (now) return look();
    this.cancelLeaving();
    this.leaving = timer = setInterval(look, BACK_LOOK_MS);
  }
  private cancelLeaving() {
    clearInterval(this.leaving);
    this.leaving = undefined;
  }
  close() {
    clearInterval(this.timer);
    this.command = undefined;
  }
}
