import { z } from 'zod';
import type { AgentStreamSession } from './agent-stream.js';
import type { Json } from './data.js';
import { runningKeyPattern, sameOriginPath } from './running.js';
import { visible } from './text.js';
import type { ProcessGraph } from './workflow-guidance.js';

/**
 * The Running vocabulary as the board reads it (see running.ts): each part an owner sends is
 * parsed by these schemas, and its types are theirs. A part that breaks the contract is left
 * out; a row that breaks it is left out and the rest of its section stands. The browser
 * imports running.ts alone, so this module, and zod, stay on the server.
 */

/** Drops what a parse left undefined, so a part carries only what its owner said. */
const lean = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
/**
 * What does not parse is left out rather than refusing what holds it: undefined in its place,
 * typed as the schema's own input, so an owner still writes the type it means.
 */
const lenient = <T extends z.ZodTypeAny>(schema: T) =>
  schema.catch(undefined as never) as unknown as z.ZodType<z.output<T>, z.ZodTypeDef, z.input<T>>;
/** At most `max` items, and of them each that parses, the rest left out. */
const kept = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .array(lenient(item))
    .max(max)
    .transform((items) => items.filter((value) => value !== undefined));

const words = (max: number) => z.string().max(max).refine(visible);
const instant = z
  .string()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)));
const count = (max = Number.MAX_SAFE_INTEGER) => z.number().int().min(0).max(max);
/** A flag is said only when it is true. */
const flag = z
  .boolean()
  .optional()
  .transform((value) => value || undefined);
const key = z.string().regex(runningKeyPattern);
const path = z.string().refine(sameOriginPath);
const https = z
  .string()
  .max(2000)
  .regex(/^https:\/\/\S+$/)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  });
/** The shell ends every link with its own arrow, so an owner's trailing one is dropped. */
const linkText = (max: number) =>
  words(max)
    .transform((text) => text.replace(/\s*[→↗]\s*$/u, ''))
    .refine(visible);
export const runningMoney = z.object({
  amount: z.string().regex(/^-?\d{1,15}(\.\d{1,12})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const runningLane = z.enum(['work', 'sessions', 'hardware']);
/**
 * Where a link goes. A key opens that thing's sidebar, whether or not it is on the board: its
 * owners are asked first, and the route it carries is followed only when no owner answers for
 * the key. A route is a page of this app. An href is https and opens outside the app. The
 * shell draws the arrow that ends a link, so no owner writes one.
 */
const targets = z.union([
  z.object({ href: https }).strict(),
  z.object({ key, route: path.optional() }).strict().transform(lean),
  z.object({ route: path }).strict(),
]);
export const runningTarget = z.preprocess(
  // A target is what it names first, an href, then a key, then a route, and that must hold.
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { href, key, route } = value as Record<string, unknown>;
    return 'href' in value ? { href } : 'key' in value ? { key, route } : { route };
  },
  targets,
) as unknown as z.ZodType<z.output<typeof targets>, z.ZodTypeDef, z.input<typeof targets>>;

/**
 * One fact, in the types a remote row's columns already use (views/remote.tsx): words, a
 * state, a time ago, a running clock, a countdown, a count, money and a link. The shell
 * writes the words for each and ticks every clock on the server's time, so an owner sends
 * instants and never '3 min ago'.
 */
export const runningValue = z.union([
  /** Words, as written. */
  z.string().max(1000),
  /**
   * Machine text such as a branch or a tool name, sent whole. The shell prints an id or a
   * digest inside it by its head and its tail, and keeps all of it for the hover title and,
   * in a facts row, for the copy control.
   */
  z.object({ mono: words(400) }),
  /** A state word; `in_review` reads 'in review'. Drawn in ink; red only on a row that needs a person. */
  z.object({ state: words(64) }),
  /** How long ago ('6 min ago'), with the moment in its title. */
  z.object({ ago: instant }),
  /** How long since, ticking ('22m'). With `of` seconds it reads against a cap ('12m of 60m'). */
  z.object({ since: instant, of: z.number().finite().min(0).optional() }).transform(lean),
  /** Time left ('34m left'). With `of` seconds granted it reads '34m left · of 4h'. */
  z.object({ until: instant, of: z.number().finite().min(0).optional() }).transform(lean),
  /** A count. With `of` it reads out of a whole ('2 of 4'). */
  z.object({ count: count(), of: count().optional() }).transform(lean),
  /** Spent so far, against a cap and per hour ('$2.10 of $8 · $2.49/h'). A rate of zero reads 'free'. */
  z
    .object({
      money: runningMoney.nullable(),
      of: runningMoney.nullable().optional(),
      rate: runningMoney.nullable().optional(),
    })
    .transform(lean),
  /**
   * A person or an agent. The shell names it with the one actor-name rule (actor.list, which
   * only an operator may read). `prefix` goes before a name ('with '). `unnamed` stands in
   * when the reader cannot see one ('claimed'). With neither, an unnamed actor renders
   * nothing. The id is only for the lookup and is never printed.
   */
  z
    .object({
      actor: words(200),
      prefix: z.string().max(40).optional(),
      unnamed: words(60).optional(),
    })
    .transform(({ actor, prefix, unnamed }) =>
      lean({ actor, prefix: prefix || undefined, unnamed }),
    ),
  /** Words that go somewhere. A link that goes nowhere this page may send a reader still says its words. */
  z
    .object({ link: lenient(runningTarget), text: linkText(200) })
    .transform(({ link, text }) => (link ? { link, text } : text)),
]);
/** Words and facts read in order, at most sixteen. The owner writes its own separators (' · '). */
export const runningPhrase = z.array(runningValue).max(16);

/** What needs a person, and who ends the wait. This is the only red on the page. */
export const runningAttention = z
  .object({
    says: runningPhrase.min(1),
    /** 'A signed-in operator', 'The producer'. Printed under the sentence in the sidebar. */
    who: words(120).optional(),
    /**
     * The one way to the move, drawn as a link under the sentence in the sidebar's head:
     * `{ route: '/code', text: 'Merge reviewed proposal' }` reads 'Merge reviewed proposal →'.
     * A way that goes nowhere is left off; the person's need still stands.
     */
    to: lenient(z.intersection(runningTarget, z.object({ text: linkText(40) })).optional()),
    /**
     * Not a person's move, only what the drawing owner cannot see: the words replace the
     * node's first line in ink, without the red, and are not counted as needing anyone
     * ('Ready · launch failed 2 times, retrying'). Any red attention outranks a quiet one.
     */
    quiet: lenient(z.literal(true).optional()),
  })
  .transform(lean);
/**
 * Attention an owner raises on a key it does not draw: Code's pull request waiting for a
 * merge, or Sessions' held dispatch. A mark also keeps its key on the board, because the
 * drawing owner is asked for that node even where its own rule would drop it. That is how
 * a done task whose code still needs a person stays. A node's own attention outranks every
 * mark.
 */
export const runningMark = z.intersection(z.object({ key }), runningAttention);

/** How one node relates to another. Each fact is declared once, by the node that holds it. */
export const runningVerb = z.enum([
  /** work → work: a prerequisite. `waiting` while it is unsettled. */
  'waits on',
  /** session → work, as producer, reviewer or reader. */
  'works on',
  'reviews',
  'reads',
  /** fleet → work: why the machine was rented, not necessarily what it runs. */
  'rented for',
  /** compute → work. */
  'runs for',
  /** check → work: accepted work the check machine is proving. */
  'checks',
]);
export const runningNodeLink = z
  .object({
    to: key,
    verb: runningVerb,
    /** Drawn dashed: the relation has not happened yet (an unsettled prerequisite, a machine starting). */
    waiting: flag,
  })
  .transform(lean);

/**
 * One card. A work card shows its kind, title and one line. A session shows its role, what
 * it is doing and where it runs. A machine shows what it is, what it is doing and what it
 * costs.
 */
export const runningNode = z
  .object({
    key,
    lane: runningLane,
    /** The small word above the title in the work lane ('Task', 'Experiment', 'Reflection'). */
    kind: words(40).optional(),
    title: words(200),
    /** Accessible name and hover title, where the title is not the thing's name (a sandbox titled '8× H100' is named 'aurora-sweep'). */
    name: words(200).optional(),
    /** At most two lines under the title. Attention replaces the first. */
    lines: z.array(runningPhrase).max(2),
    /** solid: in hand. dashed: waiting on a prerequisite, a worker or a machine. quiet: ending. */
    look: z.enum(['solid', 'dashed', 'quiet']),
    /**
     * Green only where something moves. `moving` breathes: a call is in flight right now.
     * `live` is still: a lease holds it. `starting` is a hollow grey ring. Absent: no dot.
     * A work node's dot is the board's to draw, from the sessions working on it or reviewing
     * it, so an owner of work leaves it unset.
     */
    dot: z.enum(['moving', 'live', 'starting']).optional(),
    attention: runningAttention.optional(),
    /** Hardware only: one cell per accelerator (at most 8 drawn), filled while a job runs. */
    units: z.object({ count: count(64), busy: z.boolean() }).optional(),
    links: z
      .array(runningNodeLink)
      .max(64)
      .optional()
      .transform((links) => (links?.length ? links : undefined)),
    /**
     * Keys of other owners' nodes that this node absorbs. A session bound to a Fleet machine
     * absorbs `fleet:<allocationId>`, a Code check absorbs its `sandbox:<id>`, and a reflection
     * wave absorbs its lenses' `work:<lensId>`. The absorbed node leaves its lane, links to it
     * land here, and its owner's sections follow this node's in the sidebar, without their
     * controls. What an absorbed node absorbs comes along with it. On the board's answer this
     * is every key the node absorbed, so the shell can open this node for any of them.
     */
    aliases: z
      .array(key)
      .max(16)
      .optional()
      .transform((aliases) => (aliases?.length ? [...new Set(aliases)] : undefined)),
    /** Order within one owner's nodes, lowest first. Attention sorts ahead of any rank. */
    rank: z.number().finite().optional(),
  })
  .transform(lean);

/**
 * A control. The owner sends the whole tool input and decides whether this caller may use it.
 * A control that is not allowed is not sent, nor one whose input is not a small JSON object.
 */
export const runningAction = z
  .object({
    /** Words from the verb table: 'Halt lease', 'Pause dispatch', 'Start dispatch', 'Extend lease', 'Release machine'. */
    label: words(40),
    verb: z.enum(['start', 'pause', 'halt', 'extend', 'release']),
    tool: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
    /** Sent as is. Never merged with a key: `session.halt` without `sessionId` halts every lease. */
    input: z.record(z.custom<Json>()).transform((input, context) => {
      try {
        const encoded = JSON.stringify(input);
        if (new TextEncoder().encode(encoded).length <= 4096)
          return JSON.parse(encoded) as Record<string, Json>;
      } catch {
        // Not JSON: refused below.
      }
      context.addIssue({ code: 'custom', message: 'Action input must be a small JSON object' });
      return z.NEVER;
    }),
    /** The owner's own rule for this caller. */
    allowed: z.boolean(),
    /** Wears the accent. Only a start may; never a pause, a halt or a release. */
    primary: lenient(z.boolean().optional()),
    /** A guarded control names its consequence before acting. */
    guard: z.object({ title: words(80), consequence: words(400) }).optional(),
    /**
     * What the answer must hold for the act to count as done. Below `min` the guard stays
     * open with `nothing` under it, and nothing is refreshed as if it had worked: a lease that
     * closed between the read and the click halts nothing
     * (`{ field: 'halted', min: 1, nothing: 'Nothing was halted.' }`).
     */
    expect: z
      .object({
        field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
        min: z.number().finite(),
        nothing: words(120),
      })
      .optional(),
  })
  .refine((action) => action.allowed)
  .transform((action) =>
    lean({ ...action, primary: action.primary && action.verb === 'start' ? true : undefined }),
  );

/** A lane's own line, beside its heading. For Sessions: dispatch and machines. */
export const runningSummary = z
  .object({
    lane: runningLane,
    says: runningPhrase,
    attention: runningAttention.optional(),
    actions: kept(runningAction, 4),
  })
  .transform(lean);

/**
 * Where a section stands in a sidebar, so sections from several owners read in one order:
 * where the thing is in its workflow, what is happening to it now, its review, what it
 * waits on and holds up, its code, what it is, its machine, and who. Within a place the
 * node's owner comes first, then the owners of what it absorbed, then other owners. A
 * section that says why the node needs a person comes before all of them.
 */
export const runningPlace = z.enum([
  'progress',
  'activity',
  'review',
  'relations',
  'code',
  'content',
  'machine',
  'details',
]);
/** One row of label and value. */
export const runningFact = z
  .object({ label: words(60), value: runningPhrase, attention: flag })
  .transform(lean);
/** One table row. With `to`, the row is the way to that thing; a way that goes nowhere is left off. */
export const runningRow = z
  .object({
    cells: z.array(runningPhrase),
    to: lenient(runningTarget.optional()),
    attention: flag,
  })
  .transform(lean);
/** One jump row: kind word, name, and how it stands. */
export const runningLinkRow = z
  .object({
    to: runningTarget,
    kind: words(40).optional(),
    name: words(200),
    says: runningPhrase.optional(),
    attention: flag,
  })
  .transform(lean);
/** A Merv call, or a quiet marker between calls. The shell pins running calls first, collapses repeats and marks silences. */
export const runningStreamItem = z.union([
  z.object({ mark: runningPhrase.min(1), at: instant }),
  z.object({
    call: words(200),
    state: z.enum(['running', 'succeeded', 'failed', 'interrupted']),
    at: instant,
    ms: z.number().finite().nullable(),
  }),
]);
/** One session of the live view: its words, its times and the route that reads its stream. */
const agentSession: z.ZodType<AgentStreamSession, z.ZodTypeDef, AgentStreamSession> = z
  .object({
    sessionId: words(200),
    state: words(200),
    role: words(40),
    live: z.boolean(),
    startedAt: instant,
    endedAt: instant.optional(),
    continues: words(200).optional(),
    events: words(300).refine(sameOriginPath),
  })
  .transform(lean);
/** The workflow drawn with the record's place in it (UI_DESIGN: workflows are drawn). */
const processGraph = z.custom<ProcessGraph>(
  (graph) =>
    !!graph &&
    typeof graph === 'object' &&
    Array.isArray((graph as ProcessGraph).nodes) &&
    (graph as ProcessGraph).nodes.length > 0 &&
    Array.isArray((graph as ProcessGraph).edges) &&
    typeof (graph as ProcessGraph).state === 'string',
);

const frame = {
  title: words(60),
  place: runningPlace,
  /** Beside the heading: a count, or a count and a total ('50 of 347', '3 · $6.30'). */
  aside: runningPhrase.optional().transform((aside) => (aside?.length ? aside : undefined)),
  /** The section says why the node needs a person, so its heading takes the refusal colour. */
  attention: flag,
  /** Starts as a closed fold under its title, e.g. a brief the page has already summarised. */
  folded: flag,
};
/**
 * One sidebar section. A section that says nothing is left out, and a row that breaks the
 * contract is left out while the rest of its section stands.
 */
export const runningSection = z
  .discriminatedUnion('kind', [
    z.object({
      ...frame,
      kind: z.literal('text'),
      text: z.string().max(16_000).refine(visible),
      markdown: flag,
      clamp: count(40).min(1).optional(),
      truncated: flag,
    }),
    z.object({ ...frame, kind: z.literal('facts'), rows: kept(runningFact, 24) }),
    z.object({
      ...frame,
      kind: z.literal('table'),
      columns: z.array(words(40)).min(1).max(6),
      rows: kept(runningRow, 50),
    }),
    z.object({ ...frame, kind: z.literal('links'), rows: kept(runningLinkRow, 50) }),
    z.object({ ...frame, kind: z.literal('ladder'), graph: processGraph }),
    z.object({
      ...frame,
      kind: z.literal('stream'),
      items: kept(runningStreamItem, 60),
      total: count(),
    }),
    /** The unit's agent sessions, newest first, each read live (operators only). */
    z.object({ ...frame, kind: z.literal('agent'), sessions: kept(agentSession, 20) }),
  ])
  .transform((section, context) => {
    const shown =
      section.kind === 'table'
        ? {
            ...section,
            rows: section.rows.filter((row) => row.cells.length === section.columns.length),
          }
        : section;
    const said =
      shown.kind === 'text' || shown.kind === 'ladder'
        ? true
        : shown.kind === 'stream'
          ? shown.items.length > 0 || shown.total > 0
          : shown.kind === 'agent'
            ? shown.sessions.length > 0
            : shown.rows.length > 0;
    if (said) return lean(shown);
    context.addIssue({ code: 'custom', message: 'The section says nothing' });
    return z.NEVER;
  });

/** The sidebar's head. The status line uses the node's words. */
export const runningHeader = z
  .object({
    kind: words(40),
    title: words(200),
    says: runningPhrase,
    attention: runningAttention.optional(),
  })
  .transform(lean);
