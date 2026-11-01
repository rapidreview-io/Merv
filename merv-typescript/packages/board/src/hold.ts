import { personInterrupts } from '@merv/api/audience';

/** How long after a page's last ask it still counts as open: its asks come every 1.5 s or sooner. */
const WATCHED_MS = 4_000;
/** The longest an answer is held, within every client's tool timeout (Codex allows 60 s). */
const MOST_HOLD_MS = 40_000;
/** About how long a page takes to ask for what was just drawn, before its pen can start. */
const PICKUP_MS = 300;
/** How often a hold checks that the page is still asking. */
const CHECK_MS = 500;
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
  wake: Set<() => void>;
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
  private desk(board: string): Desk {
    let desk = this.desks.get(board);
    if (!desk) {
      desk = {
        polled: 0,
        penDone: 0,
        seq: 0,
        told: new Map(),
        barred: new Map(),
        wake: new Set(),
      };
      this.desks.set(board, desk);
      for (const [id, other] of this.desks) {
        if (this.desks.size <= MOST_BOARDS) break;
        if (!other.wake.size) this.desks.delete(id);
      }
    }
    return desk;
  }
  /** A person's page asked what changed on this board. */
  asked(board: string): void {
    this.desk(board).polled = Date.now();
  }
  /** A person drew or changed something, or (with none of it saved yet) has begun to. */
  hand(board: string): void {
    const desk = this.desk(board);
    desk.seq++;
    for (const wake of desk.wake) wake();
  }
  /**
   * Answers once the pen would have finished `ms` more of drawing, or at once if nobody is watching,
   * early if a person steps in or stops watching, and says if a person stepped in since this agent
   * was last told. `patient` is false for what must never wait, as a leased worker's call.
   */
  async hold(board: string, agent: string, ms: number, patient: boolean) {
    const desk = this.desk(board);
    const told = desk.told.get(agent) ?? desk.seq;
    const said = personInterrupts.getStore();
    const watched = () => !this.closed && Date.now() - desk.polled < WATCHED_MS;
    const stepped = () => desk.seq > told || !!said?.aborted;
    if (watched() && ms) {
      const now = Date.now();
      desk.penDone = Math.max(desk.penDone, now + PICKUP_MS) + ms;
      if (patient && !stepped())
        await new Promise<void>((resolve) => {
          const end = () => {
            clearTimeout(timer);
            clearInterval(check);
            desk.wake.delete(end);
            said?.removeEventListener('abort', end);
            resolve();
          };
          const timer = setTimeout(end, Math.min(desk.penDone - now, MOST_HOLD_MS));
          const check = setInterval(() => watched() || end(), CHECK_MS);
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
  /** `agent` read the board, as it was told to. */
  read(board: string, agent: string): void {
    this.desks.get(board)?.barred.delete(agent);
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
    sights.set(board, first && had !== undefined ? had : revision);
    if (sights.size > BOARDS_A_READER) sights.delete(sights.keys().next().value!);
    this.sights.delete(reader);
    this.sights.set(reader, sights);
    if (this.sights.size > MOST_READERS) this.sights.delete(this.sights.keys().next().value!);
  }
  /** Main is going down: every answer held comes back now. */
  close(): void {
    this.closed = true;
    for (const desk of this.desks.values()) for (const wake of desk.wake) wake();
  }
}
