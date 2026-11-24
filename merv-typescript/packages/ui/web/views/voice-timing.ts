/**
 * When the moments of one spoken request happened, as this page saw them: how long from the person
 * starting to speak to their last word, the hand-over, the turn being sent, new ink being fetched,
 * the pen reaching its first shape, the first line going to the voice and the first sound coming
 * back. Milliseconds only: no words, no names, no ids. One record a request, sent once.
 */
type Moment = 'word' | 'handed' | 'sent' | 'ink' | 'pen' | 'line' | 'sound';
type TimingRecord = { [moment in Moment]?: number };
const ORDER: Moment[] = ['word', 'handed', 'sent', 'ink', 'pen', 'line', 'sound'];
/** A request whose first sound never comes is sent as far as it got after this long. */
const GIVE_UP_MS = 60_000;

export class VoiceTiming {
  private began?: number;
  private at: TimingRecord = {};
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private report: (record: TimingRecord) => void,
    private now: () => number = () => Date.now(),
  ) {}
  /** The person started to speak: a new request's clock starts, unless one is being answered. */
  begin() {
    if (this.at.handed !== undefined) this.flush();
    if (this.began === undefined) this.began = this.now();
  }
  /** A moment happened. Each counts once, except `again` ones (the last word), which move. */
  mark(moment: Moment, again = false) {
    if (this.began === undefined) {
      // Typed or started some other way: nothing to time against.
      if (moment !== 'word' && moment !== 'handed') return;
      this.began = this.now();
    }
    // A hand-over starts the answering; ink, pen, line and sound count only after it.
    if (moment !== 'word' && moment !== 'handed' && this.at.handed === undefined) return;
    if (moment === 'word' && this.at.handed !== undefined) return;
    if (this.at[moment] !== undefined && !again) return;
    this.at[moment] = Math.max(0, Math.round(this.now() - this.began));
    if (moment === 'handed') {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), GIVE_UP_MS);
    }
    // The pen's first shape and the first sound are the two that matter: with both, it is whole.
    if (this.at.sound !== undefined && (this.at.pen !== undefined || moment === 'sound'))
      this.settle();
  }
  /** Whole enough: sent a moment later, so a pen or sound arriving together is in it. */
  private settle() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.at.pen !== undefined ? 0 : 5_000);
  }
  flush() {
    clearTimeout(this.timer);
    const record = Object.fromEntries(
      ORDER.flatMap((moment) => (this.at[moment] === undefined ? [] : [[moment, this.at[moment]]])),
    ) as TimingRecord;
    const whole = record.handed !== undefined;
    this.began = undefined;
    this.at = {};
    if (whole) this.report(record);
  }
}
