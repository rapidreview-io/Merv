import { createHash, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import { check, MervError, newId, type Caller } from '@merv/contracts';
import { redact, type Step } from './transcript.js';
import type { AttachedSession, AttachedStep, BoardAttached } from './models.js';

/** How long a code waits, how long an attachment lives unused, and failed codes allowed a minute. */
const [CODE_MS, IDLE_MS, MISSES] = [5 * 60_000, 24 * 3_600_000, 30];
/** The most steps a session keeps for pages, and sessions held at all. */
const [MOST_STEPS, MOST_SESSIONS] = [300, 1000];
/** No I, L, O, 0 or 1: a code is read off a screen and typed. */
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const hashed = (token: string) => createHash('sha256').update(token).digest('hex');

export const pairSchema = z.strictObject({
  code: z.string().trim().toUpperCase().length(6),
  name: z.string().trim().max(40),
});
export const eventSchema = z.strictObject({
  kind: z.enum(['person', 'say', 'call']),
  key: z.string().max(200).optional(),
  tool: z.string().max(200).optional(),
  text: z.string().max(2000),
  lane: z.string().max(100).optional(),
  failed: z.literal(true).optional(),
  done: z.literal(true).optional(),
  ended: z.literal(true).optional(),
  /** The session could read an answer now: tell it what a person's hand did. */
  ask: z.literal(true).optional(),
});
export const callSchema = z.strictObject({
  name: z.enum(['board.read', 'board.write']),
  input: z.record(z.unknown()),
});

interface Attachment extends AttachedSession {
  board: string;
  caller: Caller;
  token: string;
  used: number;
  steps: AttachedStep[];
}

/**
 * Claude Code sessions attached to boards: who they are and, for pages to show, what each is doing.
 * All in this process, as presence is, and on purpose: session content is relayed and never stored,
 * so a restart loses it and detaches every session until it pairs again. Only the person's own act
 * of pinning puts any of it on a board. A token acts for the person who asked for the code, on that
 * one board.
 */
export class BoardAttach {
  private codes = new Map<string, { board: string; caller: Caller; until: number }>();
  private live = new Map<string, Attachment>();
  private seq = 0;
  private misses = { count: 0, since: 0 };
  /** A code the person who may use this board types into their session. */
  code(board: string, caller: Caller): string {
    for (const [code, { until }] of this.codes) if (until < Date.now()) this.codes.delete(code);
    const code = Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join('');
    // Only who they are: their browser's login may lapse while the session runs, and Scope rechecks
    // the actor's membership on every call.
    const { actorId, projectId } = caller;
    this.codes.set(code, { board, caller: { actorId, projectId }, until: Date.now() + CODE_MS });
    return code;
  }
  pair(code: string, name: string): { token: string; attachment: Attachment } {
    if (Date.now() - this.misses.since > 60_000) this.misses = { count: 0, since: Date.now() };
    const held = this.misses.count < MISSES ? this.codes.get(code) : undefined;
    if (!held || held.until < Date.now()) {
      this.misses.count++;
      throw new MervError('board_code', 'That code is wrong or has expired', 403);
    }
    this.codes.delete(code);
    const token = `bt_${randomBytes(32).toString('base64url')}`;
    const attachment: Attachment = {
      id: newId('attach'),
      name,
      board: held.board,
      caller: held.caller,
      token: hashed(token),
      used: Date.now(),
      steps: [],
    };
    this.live.set(attachment.token, attachment);
    for (const [key, { used }] of this.live)
      if (this.live.size > MOST_SESSIONS || used < Date.now() - IDLE_MS) this.live.delete(key);
    return { token, attachment };
  }
  /** Who a bearer is, or a refusal that says what to do. */
  of(token: string): Attachment {
    const attachment = this.live.get(hashed(token));
    check(
      attachment && attachment.used > Date.now() - IDLE_MS,
      'board_detached',
      'This session is no longer attached: get a new code from the board',
      401,
    );
    attachment.used = Date.now();
    return attachment;
  }
  /** One thing the session did: a call's end lands on its start, in whichever order they came. */
  relay(attachment: Attachment, event: z.infer<typeof eventSchema>): void {
    if (event.ended) return void this.live.delete(attachment.token);
    const at = new Date().toISOString();
    const held = event.key && attachment.steps.find(({ key }) => key === event.key);
    if (held) {
      if (!event.done) return;
      held.until = at;
      held.seq = ++this.seq;
      if (event.failed) held.failed = true;
      return;
    }
    const step: Step = {
      id: (attachment.steps.at(-1)?.id ?? 0) + 1,
      line: 0,
      at,
      lane: event.lane ?? 'main',
      kind: event.kind,
      // Redacted by the plugin before it left the machine; again here, for any other client.
      text: redact(event.text),
      ...(event.tool && { tool: event.tool }),
      ...(event.done && { until: at }),
      ...(event.failed && { failed: true as const }),
    };
    attachment.steps.push({
      ...step,
      session: attachment.id,
      seq: ++this.seq,
      ...(event.key && { key: event.key }),
    });
    if (attachment.steps.length > MOST_STEPS) attachment.steps.shift();
  }
  /** What a page on `board` has not been told, since the `after` its last answer gave. */
  on(board: string, after: number): BoardAttached | undefined {
    const here = [...this.live.values()].filter((attachment) => attachment.board === board);
    if (!here.length && !after) return undefined;
    return {
      sessions: here.map(({ id, name }) => ({ id, name })),
      steps: here.flatMap(({ steps }) => steps.filter(({ seq }) => seq > after)),
      seq: this.seq,
    };
  }
  /** The person detaches a session of theirs: its next call is refused. */
  end(session: string, projectId: string): void {
    for (const [key, { id, caller }] of this.live)
      if (id === session && caller.projectId === projectId) this.live.delete(key);
  }
}

/** Which of an agent's actions an attached session has: never the project's other boards or files. */
const ALLOWED: Record<string, string[]> = {
  'board.read': ['get', 'look', 'outcome'],
  'board.write': ['draw', 'outcome'],
};
/** Its action's arguments, pinned to the board it is attached to. */
export function pinned(board: string, name: string, input: Record<string, unknown>) {
  const action = String(input.action);
  check(ALLOWED[name]?.includes(action), 'board_attached_action', `Not while attached: ${action}`);
  const args = { ...(input[action] as { ops?: { op?: string }[] } | undefined), board };
  const { ops } = args;
  check(
    !ops?.some(({ op }) => op === 'image'),
    'board_attached_action',
    "Images come from the project's files, which an attached session cannot read",
  );
  return { action, [action]: args };
}
