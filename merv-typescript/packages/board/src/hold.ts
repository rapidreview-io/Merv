import { personInterrupts } from '@merv/api/audience';

/** How long after a page's last ask it still counts as open: its active pen asks every 400 ms. */
const WATCHED_MS = 4_000;
/** The longest an answer is held, within every client's tool timeout (Codex allows 60 s). */
const MOST_HOLD_MS = 40_000;
/** About how long a page takes to ask for what was just drawn, before its pen can start. */
const PICKUP_MS = 300;
/**
 * How far the pen may have left to draw when an answer comes: the model writes its next call while
 * the pen draws this one, so neither waits, and a person who steps in stops it within this much.
 */
const AHEAD_MS = 12_000;
/** How often a hold checks that the page is still asking, and how far its telling has got. */
const CHECK_MS = 250;
/** The longest a page's wait for new ink is held open before it asks again. */
const MOST_WAIT_MS = 25_000;
/** How long an agent told of a person's hand may not draw there unless it reads the board first. */
const READ_FIRST_MS = 20_000;
/** How many agents are remembered for each board, and how many boards. */
const [MOST_AGENTS, MOST_BOARDS] = [16, 1000];
/** How many readers, and boards each, have how far they have seen of a board remembered. */
const [MOST_READERS, BOARDS_A_READER] = [1000, 4];

/** A person stepped in while an agent was drawing: they said something, stopped it, or drew. */
export interface SteppedIn {
  how: 'said' | 'stopped' | 'drew';
  /** What they did on the board, in words, as far as it is saved yet (`handLog`). */
  hand?: string[];
}
interface Desk {
  polled: number;
  /** When the pen will have finished what has been drawn here, by the same numbers as the page. */
  penDone: number;
  /** How many times people have done something, and how far each agent has been told. */
  seq: number;
  told: Map<string, number>;
  /** Who was told of a person's hand, and until when they must read before they draw. */
  barred: Map<string, number>;
  /** A hand has come down and what it did has not been saved yet. */
  unsaved: boolean;
  handAt: number;
  wake: Set<() => void>;
  /** The newest revision committed here, and the pages waiting to be told of the next. */
  revision: number;
  landing: Set<() => void>;
  /**
   * What a page that says the lines aloud last told of its telling: the revision it had fetched and
   * how many lines it had still to send to its voice. Absent where no page speaks.
   */
  voice?: { at: number; since: number; unsaid: number };
}

/**
 * Who is watching a board and how far its pen has got, so that while a person watches, a model's
 * pace is the pen's and it can be stopped. In this process, as presence is: Main is one process, and
 * a restart forgets only that an answer was being held, which it then returns. Nothing here is kept
 * or changes what a board stores. Only an agent's own board.write draw is ever held, and only while
 * a page is open on that board: an unattended agent is answered as soon as its call is done.
 */
export class BoardWatch {
  private desks = new Map<string, Desk>();
  private closed = false;
  /** How far each agent's conversation has seen each board. */
  private sights = new Map<string, Map<string, number>>();
  private lastTold = new Map<string, string[]>();
  private desk(board: string): Desk {
    let desk = this.desks.get(board);
    if (!desk) {
      desk = {
        polled: 0,
        penDone: 0,
        seq: 0,
        told: new Map(),
        barred: new Map(),
        unsaved: false,
        handAt: 0,
        wake: new Set(),
        revision: 0,
        landing: new Set(),
      };
      this.desks.set(board, desk);
      for (const [id, other] of this.desks) {
        if (this.desks.size <= MOST_BOARDS) break;
        if (!other.wake.size && !other.landing.size) this.desks.delete(id);
      }
    }
    return desk;
  }
  /**
   * A person's page asked what changed on this board. A page that speaks the lines says with it how
   * far its telling is: `since`, the revision it holds, and `unsaid`, the lines its pen has not yet
   * handed to its voice.
   */
  asked(board: string, telling?: { since: number; unsaid: number }): void {
    const desk = this.desk(board);
    desk.polled = Date.now();
    if (telling) desk.voice = { at: desk.polled, ...telling };
  }
  /** A board change committed at `revision`: every page waiting on this board is told now. */
  landed(board: string, revision: number): void {
    const desk = this.desk(board);
    desk.revision = Math.max(desk.revision, revision);
    for (const told of [...desk.landing]) told();
  }
  /**
   * Answers as soon as a board changes past `since`, or after `ms`: a page waits here so that
   * new ink reaches it as it lands, not at its next look. A page waiting is a page watching.
   */
  async next(board: string, since: number, ms = MOST_WAIT_MS): Promise<number> {
    const desk = this.desk(board);
    if (desk.revision <= since && !this.closed)
      await new Promise<void>((resolve) => {
        const told = () => {
          clearTimeout(timer);
          clearInterval(here);
          desk.landing.delete(told);
          resolve();
        };
        const timer = setTimeout(told, ms);
        // While it waits it is watching: an agent's answer is held for it as for one that asks.
        const here = setInterval(() => (desk.polled = Date.now()), 1_000);
        desk.polled = Date.now();
        desk.landing.add(told);
      });
    return desk.revision;
  }
  /** A person drew or changed something: `saved` when it is stored, else they have only begun to. */
  hand(board: string, saved = true): void {
    const desk = this.desk(board);
    desk.seq++;
    desk.unsaved = !saved;
    desk.handAt = Date.now();
    for (const wake of desk.wake) wake();
  }
  /**
   * Answers once the pen is within AHEAD_MS of finishing `ms` more of drawing and, where a page speaks the
   * lines, once every line up to `revision` has gone to its voice; at once if nobody is watching,
   * early if a person steps in or stops watching, and says if a person stepped in since this agent
   * was last told. `patient` is false for what must never wait, as a leased worker's call.
   */
  async hold(board: string, agent: string, ms: number, patient: boolean, revision = 0) {
    const desk = this.desk(board);
    const told = desk.told.get(agent) ?? desk.seq;
    const said = personInterrupts.getStore();
    const watched = () => this.watched(board);
    const stepped = () => desk.seq > told || !!said?.aborted;
    // A page that says the lines aloud tells how far it is: the next call waits until it has
    // fetched this one and handed every line of it to its voice, so the model is never more than
    // the chunk being spoken ahead of what the person has heard.
    const speaking = () => !!desk.voice && Date.now() - desk.voice.at < WATCHED_MS;
    const toldAll = () =>
      !speaking() || (desk.voice!.since >= revision && desk.voice!.unsaid === 0);
    if (watched() && ms) {
      const now = Date.now();
      desk.penDone = Math.max(desk.penDone, now + PICKUP_MS) + ms;
      const inked = desk.penDone - AHEAD_MS;
      if (patient && !stepped() && (inked > now || !toldAll()))
        await new Promise<void>((resolve) => {
          const end = () => {
            clearTimeout(timer);
            clearInterval(check);
            desk.wake.delete(end);
            said?.removeEventListener('abort', end);
            resolve();
          };
          const timer = setTimeout(end, MOST_HOLD_MS);
          const check = setInterval(
            () => (!watched() || (Date.now() >= inked && toldAll())) && end(),
            CHECK_MS,
          );
          desk.wake.add(end);
          said?.addEventListener('abort', end);
        });
    }
    if (said?.aborted) {
      desk.told.set(agent, desk.seq);
      return { how: said.reason as 'said' | 'stopped' } satisfies SteppedIn;
    }
    return this.tell(desk, agent, told);
  }
  /** What a person drew since `told`, which `agent` must now read before it draws here. */
  private tell(desk: Desk, agent: string, told: number): SteppedIn | undefined {
    desk.told.set(agent, desk.seq);
    if (desk.told.size > MOST_AGENTS) desk.told.delete(desk.told.keys().next().value!);
    if (desk.seq <= told) return undefined;
    desk.barred.set(agent, Date.now() + READ_FIRST_MS);
    return { how: 'drew' };
  }
  /**
   * Whether a person has drawn here since `agent` last read: if so its next draw does not run. A
   * model sends several calls at once, and the rest of them must not land over what it was just told.
   */
  ahead(board: string, agent: string): SteppedIn | undefined {
    const desk = this.desk(board);
    const stepped = this.tell(desk, agent, desk.told.get(agent) ?? desk.seq);
    if (stepped) return stepped;
    return (desk.barred.get(agent) ?? 0) > Date.now() ? { how: 'drew' } : undefined;
  }
  /** Automatic findings leave room for a hand still drawing or just saved. */
  drawing(board: string): boolean {
    const desk = this.desk(board);
    return Date.now() - desk.handAt < (desk.unsaved ? READ_FIRST_MS : WATCHED_MS);
  }
  /** Whether a page is watching this board now, whose pen says what an agent says with its ink. */
  watched(board: string): boolean {
    return !this.closed && Date.now() - this.desk(board).polled < WATCHED_MS;
  }
  /**
   * Waits up to `ms` for what a hand that has just come down did to be saved. A hand comes down
   * once, and this waits for it once: nothing waits where nothing is on its way.
   */
  async landing(board: string, ms: number): Promise<void> {
    const desk = this.desk(board);
    if (!desk.unsaved || this.closed) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        desk.wake.delete(saved);
        resolve();
      };
      // Another stroke begun meanwhile is still no save.
      const saved = () => (!desk.unsaved || this.closed) && done();
      const timer = setTimeout(done, ms);
      desk.wake.add(saved);
    });
    desk.unsaved = false;
  }
  /** `agent` read the board, as it was told to: all a person has saved is what it now knows. */
  read(board: string, agent: string): void {
    const desk = this.desks.get(board);
    desk?.barred.delete(agent);
    if (desk?.told.has(agent) && !desk.unsaved) desk.told.set(agent, desk.seq);
  }
  /** The boards `reader` knows, each with the revision it has seen of it. */
  seen(reader: string): [string, number][] {
    return [...(this.sights.get(reader) ?? [])];
  }
  /** `reader` has seen `board` as of `revision`; with `first`, only if it had not seen it before. */
  see(reader: string, board: string, revision: number, first = false): void {
    const sights = this.sights.get(reader) ?? new Map<string, number>();
    const had = sights.get(board);
    sights.delete(board);
    sights.set(board, had === undefined ? revision : first ? had : Math.max(had, revision));
    if (sights.size > BOARDS_A_READER) sights.delete(sights.keys().next().value!);
    this.sights.delete(reader);
    this.sights.set(reader, sights);
    if (this.sights.size > MOST_READERS) this.sights.delete(this.sights.keys().next().value!);
  }
  /** Those of `lines` not told to `reader` last time: a person's saves moments apart are one step
   *  of history, so a step already told can come back with the next. */
  fresh(reader: string, board: string, lines: string[]): string[] {
    const key = `${reader}:${board}`;
    const before = this.lastTold.get(key);
    this.lastTold.delete(key);
    if (lines.length) this.lastTold.set(key, lines);
    else if (before) this.lastTold.set(key, before);
    if (this.lastTold.size > MOST_READERS) this.lastTold.delete(this.lastTold.keys().next().value!);
    return lines.filter((line) => !before?.includes(line));
  }
  /** Main is going down: every answer held comes back now. */
  close(): void {
    this.closed = true;
    for (const desk of this.desks.values())
      for (const wake of [...desk.wake, ...desk.landing]) wake();
  }
}
