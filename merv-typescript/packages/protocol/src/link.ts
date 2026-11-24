import { configuration, configurationRequest, modelChoice } from './configuration.js';
/**
 * What the Mac and runmerv.com say to each other over the one socket the Mac opens.
 * Thread metadata may be kept; chat travels only in reply to an open page and is dropped.
 * The Mac alone decides whether, and once, to act on commands.
 */
import { z } from 'zod';
import { artifactImageIds, binding, picture, unit, returned } from './unit.js';
export { artifactImageIds, COMMAND_IMAGE_BYTES } from './unit.js';
import { browserTool, browserAnswer } from './browser.js';
import { personaEdit, personaView } from './persona.js';
import { diffReference, sessionSource } from './diff.js';

export const PAIR_PATH = '/desk/pair';
export const LINK_PATH = '/desk/link';

const outcome = z.object({
  id: z.string().optional(),
  turn: z.number(),
  asker: z.string().optional(),
  kind: z.literal('plan').optional(),
  revision: z.number().optional(),
  text: z.string().max(100_000),
  files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })).max(40),
});

/** One finished worker or job, or a job that needs the person, as a main thread carries it for the
 *  board's voice: said once by its id, at the person's next pause. */
export const voiceNews = z.object({
  id: z.string().max(300),
  kind: z.enum(['worker', 'job']),
  provider: z.enum(['claude', 'codex']).optional(),
  /** A worker's own thread, so the board does not also tell its session's end on its own. */
  thread: z.string().max(200).optional(),
  title: z.string().max(200),
  state: z.enum(['finished', 'failed', 'stopped', 'needs', 'done']),
  /** A few words of how it ended: its first sentence, a review's verdict, why a job waits. */
  words: z.string().max(300).optional(),
  at: z.string(),
});
export type VoiceNews = z.infer<typeof voiceNews>;

const entryFile = z.object({ path: z.string().max(1000), added: z.number(), removed: z.number() });
const tag = z.object({ id: z.string().max(200), role: z.string().max(80), round: z.number() });

/** One entry of a main thread's transcript as its completion card shows it: a worker's ended turn (`agent`) or a job's
 *  end (`jobEnded`), the same body the desk writes as its `agent_done` event. The words are the turn's closing words as
 *  its completion keeps them (redacted); the files are named with their counts, their text stays in the completion. */
const doneCard = z.object({
  agent: z.string().max(200).optional(),
  jobEnded: z.string().max(200).optional(),
  title: z.string().max(400),
  provider: z.enum(['claude', 'codex']).optional(),
  branch: z.string().max(400).optional(),
  turn: z.number().optional(),
  through: z.number().optional(),
  outcome: z.enum(['finished', 'failed', 'stopped']).optional(),
  completion: z.string().max(300).optional(),
  said: z.string().max(6_001).optional(),
  cut: z.boolean().optional(),
  files: z.number().optional(),
  changes: z.array(entryFile).max(40).optional(),
  review: z
    .object({
      of: z.string().max(200),
      title: z.string().max(400),
      verdict: z.string().max(40),
      changed: z.boolean().optional(),
    })
    .optional(),
  job: tag.optional(),
  continues: z.string().max(300).optional(),
  paused: z.literal(true).optional(),
  /** A turn that ended stopped because someone asked: the person (in the app, on their phone) or Merv. A stop nobody
   *  asked for (the app or its desk quit, restarted or lost the session) has none, and is never news. */
  stoppedBy: z.enum(['person', 'merv', 'job']).optional(),
  // A job's end.
  recipe: z.string().max(80).optional(),
  state: z.enum(['done', 'stopped']).optional(),
  words: z.string().max(400).optional(),
  rounds: z.number().optional(),
  author: z
    .object({
      thread: z.string().max(200),
      provider: z.enum(['claude', 'codex']),
      completion: z.string().max(300).optional(),
    })
    .optional(),
});
export type DoneCard = z.infer<typeof doneCard>;

/** `scheduled`: a job set to start later was set, started by itself, or is blocked and waits on the person. */
export const streamTypes = [
  'step',
  'question',
  'answer',
  'done',
  'note',
  'stop',
  'said',
  'scheduled',
] as const;
export type StreamType = (typeof streamTypes)[number];

/** Where the whole of a stream event is kept. For a `done`: the main thread whose transcript holds the card (`thread`),
 *  that `agent_done` event (`entry`), the worker (`agent`) or job (`job`), and the kept completion (`completion`). */
const streamRef = z.object({
  thread: z.string().max(200).optional(),
  entry: z.number().int().optional(),
  agent: z.string().max(200).optional(),
  completion: z.string().max(300).optional(),
  turn: z.number().optional(),
  job: z.string().max(200).optional(),
  request: z.string().max(200).optional(),
  session: z.string().max(200).optional(),
  /** For a said, where the whole message is kept: Merv's conversation; the person's words by their own id (`command`), Merv's by its turn (`command`) and place (`message`). */
  conversation: z.string().max(200).optional(),
  command: z.string().max(200).optional(),
  message: z.number().int().min(0).optional(),
});

const streamBody = {
  /** The sender's own id for it, so a resend never doubles: the Mac's is `<device>:ev_<event seq>`. */
  local: z.string().min(1).max(300),
  at: z.string().max(40),
  project: z.string().max(200),
  device: z.string().max(200).optional(),
  from: z.object({
    kind: z.enum(['worker', 'reviewer', 'job', 'manager', 'person', 'merv']),
    id: z.string().max(200),
    title: z.string().max(400).optional(),
    provider: z.enum(['claude', 'codex']).optional(),
  }),
  type: z.enum(streamTypes),
  /** Short and redacted: quoted data, never instructions. */
  text: z.string().max(400),
  ref: streamRef.optional(),
  /** For a note: true means it changes what the work it is about means, so Merv says it aloud. */
  changesStory: z.boolean().nullable().optional(),
  /** For a done. */
  outcome: z.enum(['finished', 'failed', 'stopped']).nullable().optional(),
  /** Part of the thread, not news: a paused turn, or a job member's turn, which is told with its job. */
  quiet: z.literal(true).optional(),
  /** For a done: the card the main thread shows for it, whole. */
  card: doneCard.optional(),
  /** For a scheduled: what happened to it, and when it was set to start, where it was set for a time. */
  scheduled: z
    .object({
      state: z.enum(['waiting', 'started', 'blocked', 'cancelled']),
      at: z.string().max(40).optional(),
      after: z.array(z.string().max(200)).max(20).optional(),
      /** How late it started, in ms: the Mac was asleep or off at the time. */
      late: z.number().int().min(0).optional(),
      /** The awaited job that kept it from starting, and how that one ended. */
      blockedBy: z
        .object({ id: z.string().max(200), title: z.string().max(400), why: z.string().max(80) })
        .optional(),
    })
    .optional(),
  /** For a question: what the worker asked, raw and redacted. The person hears only Merv's version. */
  ask: z
    .object({
      kind: z.string().max(40),
      title: z.string().max(1000),
      detail: z.string().max(2000).optional(),
      options: z.array(z.string().max(200)).max(12).optional(),
      questions: z
        .array(
          z.object({
            id: z.string().max(200),
            question: z.string().max(1000),
            options: z.array(z.string().max(200)).max(12),
          }),
        )
        .max(6)
        .optional(),
    })
    .optional(),
};
/** A stream event as its sender hands it over: `about` names the event it belongs to by that one's local id. */
export const streamOut = z.object({
  ...streamBody,
  about: z.string().max(300).nullable().optional(),
});
export type StreamOut = z.infer<typeof streamOut>;
/** One event of the person's stream: one ordered log across every project and Mac. `seq` is the person's, given by hosted, and only goes up. */
export const streamEvent = z.object({
  ...streamBody,
  seq: z.number().int(),
  about: z.number().int().nullable().optional(),
});
export type StreamEvent = z.infer<typeof streamEvent>;

/** A project's live card: how it stands now, built by the desk from what its main thread is told. Titles and notes are quoted data. */
export const projectCard = z.object({
  /** The repository's folder name, as `main.name` is. */
  project: z.string().max(200),
  device: z.string().max(200),
  manager: z.object({ thread: z.string().max(200), status: z.string().max(40) }),
  /** Goes up on every real change, and only then. */
  rev: z.number().int(),
  updatedAt: z.string().max(40),
  /** Needs-you first, then working, newest first. */
  inFlight: z
    .array(
      z.object({
        id: z.string().max(200),
        kind: z.enum(['worker', 'reviewer', 'job']),
        provider: z.enum(['claude', 'codex']).optional(),
        title: z.string().max(200),
        state: z.enum(['needs you', 'working']),
        /** A worker's newest step, cut to 80 characters. */
        lastStep: z.string().max(80).optional(),
        since: z.string().max(40),
        /** A job: its state in words, and its rounds. */
        words: z.string().max(200).optional(),
        round: z.number().optional(),
        max: z.number().optional(),
      }),
    )
    .max(12),
  /** Open questions and permission asks; `local` is the stream event that holds each (hosted adds its `seq`). */
  waitingOnYou: z
    .array(
      z.object({
        id: z.string().max(200),
        from: z.string().max(200),
        title: z.string().max(200),
        local: z.string().max(300).optional(),
        seq: z.number().int().optional(),
      }),
    )
    .max(12),
  /** The last finishes, newest first, each with its `done` event. */
  /** `kind` says whether an agent or a job ended; a desk too old to say leaves it out. */
  recent: z
    .array(
      z.object({
        id: z.string().max(300),
        kind: z.enum(['agent', 'job']).optional(),
        thread: z.string().max(200).optional(),
        title: z.string().max(200),
        state: z.string().max(40),
        at: z.string().max(40),
        local: z.string().max(300).optional(),
        seq: z.number().int().optional(),
      }),
    )
    .max(6),
  managerNote: z.object({ text: z.string().max(200), at: z.string().max(40) }).optional(),
  /** Jobs set to start later, by themselves: at a time, or once other jobs pass. `blocked`: an awaited job did not pass,
   *  so it waits on the person, who starts it anyway or cancels it. `waits` is what it waits for, in words. */
  later: z
    .array(
      z.object({
        id: z.string().max(200),
        title: z.string().max(200),
        state: z.enum(['waiting', 'blocked']),
        waits: z.string().max(200),
        at: z.string().max(40).optional(),
        after: z.array(z.string().max(200)).max(20).optional(),
        since: z.string().max(40),
      }),
    )
    .max(12)
    .optional(),
  /** Set by hosted: the Mac has been away more than five minutes, so this is how it last stood. */
  stale: z.boolean().optional(),
});
export type ProjectCard = z.infer<typeof projectCard>;

/** What the hosted side may keep about a thread. */
export const threadState = z.object({
  parity: z.literal(1).optional(),
  queueRevision: z.number().int().nonnegative().optional(),
  wake: z.boolean().optional(),
  branch: z.string().max(300).optional(),
  pinned: z.boolean().optional(),
  unit: binding.optional(),
  configuration: configuration.optional(),
  id: z.string(),
  provider: z.enum(['claude', 'codex']),
  project: z.string(),
  label: z.string(),
  title: z.string(),
  status: z.string(),
  turn: z.string().nullable(),
  generation: z.number(),
  at: z.string(),
  lastActivity: z.string().optional(),
  archived: z.boolean().optional(),
  scanOnly: z.boolean().optional(),
  capabilities: z
    .object({ read: z.boolean(), message: z.boolean(), stop: z.boolean(), answer: z.boolean() })
    .optional(),
  unavailable: z.string().optional(),
  /** Waiting on the person, on their Mac: an approval or a question. */
  waiting: z.boolean().optional(),
  waitingKind: z.literal('plan').optional(),
  /** How much it did, in numbers only. */
  counts: z.object({ turns: z.number(), tools: z.number(), edits: z.number() }).optional(),
  /** The board conversation that last asked this thread for work: its result goes to that board. */
  asker: z.string().optional(),
  /** A board turn's result, or a plan the person chose to bring back for more thinking. */
  outcome: outcome.optional(),
  /** Chosen results wait for their destination board to acknowledge delivery. */
  outcomes: z.array(outcome).optional(),
  /** The thread is its project's main thread: the one the person talks to for the whole repository, named by it. */
  main: z
    .object({ name: z.string().max(200), queuedReplies: z.literal(true).optional() })
    .optional(),
  /** Any other thread: the main thread of the repository it works in, or null when that repository has none. Sent by
   *  desks that know (absent from older ones), so Merv's sends can go through that manager and never to the worker. */
  home: z.string().max(200).nullable().optional(),
  /** This desk durably returns command answers, not just delivery receipts. */
  commandResponses: z.literal(true).optional(),
  /** On a main thread: its newest finished workers and jobs, and jobs that need the person. */
  news: z.array(voiceNews).max(12).optional(),
  /** A job's member (its writer or a reviewer): the job it works for. Such a session is the job's, never an agent of its own. */
  job: z.object({ job: z.string().max(200), role: z.string().max(40) }).optional(),
  /** On a main thread: its project's card, sent only when its `rev` changed. */
  card: projectCard.optional(),
});
export type ThreadState = z.infer<typeof threadState>;

/** How the person works with agents, as their Mac read it: no prompts, no paths, no code. */
export const person = z.object({
  projects: z.array(z.object({ name: z.string(), stack: z.array(z.string()) })),
  asks: z.array(z.object({ kind: z.string(), share: z.number() })),
  peakHours: z.array(z.number()),
  daysPerWeek: z.number(),
  style: z.object({ medianWords: z.number(), questions: z.number() }),
  agents: z.object({ claude: z.number(), codex: z.number() }),
});
export type Person = z.infer<typeof person>;

const commandStates = [
  'accepted',
  'dispatched',
  'executing',
  'completed',
  'failed',
  'refused',
  'outcome_unknown',
] as const;

export { sessionSource } from './diff.js';

/** A worker's turn in full, read from its Mac on request: its closing words, the files it changed with their hunks
 *  (capped as a kept completion is), and while it still works its latest steps. Redacted on the Mac; read only. */
export const REPORT_HUNKS = 256_000,
  REPORT_FILES = 200,
  REPORT_STEPS = 4;
export const agentReport = z.object({
  agent: z.string().max(200),
  completion: z.string().max(300).optional(),
  title: z.string().max(400).optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  /** How the turn stands: under way, or how it ended. */
  state: z.enum(['working', 'finished', 'failed', 'stopped']),
  turn: z.number().int().optional(),
  /** Its closing words; a long answer is cut here (`cut`) and read whole in the session. */
  said: z.string().max(6_001),
  cut: z.boolean(),
  /** False while the turn is under way: the files are what the folder holds so far. */
  settled: z.boolean().optional(),
  /** The folder was shared while the turn ran: the changes may include someone else's. */
  mixed: z.boolean().optional(),
  /** The turn's changes were not measured: an empty list is not "changed nothing". */
  unmeasured: z.boolean().optional(),
  /** It changed more than is listed here, or listed without text. */
  more: z.boolean().optional(),
  total: z.object({ files: z.number(), added: z.number(), removed: z.number() }).optional(),
  files: z
    .array(
      z.object({
        path: z.string().max(1000),
        status: z.enum(['added', 'modified', 'deleted']),
        added: z.number(),
        removed: z.number(),
        state: z.enum(['binary', 'too_large', 'unavailable', 'omitted']).optional(),
        hunks: z.array(z.object({ id: z.string().max(200), diff: z.string() })),
      }),
    )
    .max(REPORT_FILES),
  review: z
    .object({
      of: z.string().max(200),
      title: z.string().max(400),
      verdict: z.string().max(40),
      completion: z.string().max(300).optional(),
      changed: z.boolean().optional(),
    })
    .optional(),
  /** While it works: its latest steps, oldest first. */
  activity: z
    .array(
      z.object({
        kind: z.string().max(80),
        title: z.string().max(400),
        done: z.boolean(),
        failed: z.boolean().optional(),
        at: z.string().max(40),
      }),
    )
    .max(REPORT_STEPS)
    .optional(),
});
export type AgentReport = z.infer<typeof agentReport>;

/** A phone gets rendered words, never raw events or local attachment paths. */
export const chat = z.object({
  thread: z.string(),
  generation: z.number().int(),
  blocks: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(['user', 'assistant', 'tool', 'request']),
        text: z.string().max(8000),
        sourcePosition: z.string().optional(),
        sourceThread: z.string().optional(),
        /** Every chunk of a complete assistant message names the same full evidence range. */
        messageRange: z.object({ from: z.string(), through: z.string() }).optional(),
        by: z.string().optional(),
        source: sessionSource.optional(),
        requestId: z.string().max(200).optional(),
        /** A step's tool as the agent named it (Bash, Read, commandExecution), so a reader far from the Mac can say what it did. */
        tool: z.string().max(80).optional(),
      }),
    )
    .max(50),
  requests: z
    .array(
      z.object({
        id: z.string(),
        generation: z.number().int(),
        kind: z.enum(['command', 'file_change', 'tool', 'question', 'elicitation', 'plan']),
        title: z.string().max(8000),
        detail: z.string().max(8000).optional(),
        options: z.array(z.string()).optional(),
        questions: z
          .array(
            z.object({
              id: z.string(),
              question: z.string(),
              options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
              multiSelect: z.boolean().optional(),
              isSecret: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    )
    .max(20),
  macOnly: z.boolean(),
  clipped: z.boolean().optional(),
  nextCursor: z.string().optional(),
  startCursor: z.literal('start').optional(),
  /** Where the session was last rewound: when it moves, older pages read before it may hold undone lines. */
  branch: z.number().int().optional(),
});
export type Chat = z.infer<typeof chat>;

/** A voice hears its turn and any diff lines the person explicitly picked. */
export const voiceRead = z.object({
  pending: z.boolean().optional(),
  thread: z.string(),
  generation: z.number().int(),
  provider: z.enum(['claude', 'codex']),
  title: z.string().max(200),
  status: z.string(),
  /** Whether words may be sent to it: one held by a CLI in a terminal can only be watched. */
  drivable: z.boolean(),
  picked: diffReference.optional(),
  /** For one voice request: how far the turn it began has got. */
  turn: z
    .object({
      state: z.enum(['waiting', 'running', 'done', 'failed', 'stopped', 'unknown']),
      /** What it did, as titled steps, oldest first. */
      steps: z.array(z.object({ id: z.string(), text: z.string().max(200) })).max(20),
      /** The person's OK it waits for, in a few words. */
      asking: z.string().max(400).optional(),
      /** Its last words, once the turn is over. */
      answer: z.string().max(8000).optional(),
      /** The complete assistant message that supplied this receipt's answer. */
      source: sessionSource.optional(),
      /** Later input or another runtime turn made this receipt historical evidence. */
      superseded: z.boolean().optional(),
      /** This source passed complete, bounded native-turn freshness checks. Older Macs omit it. */
      sourceCurrent: z.literal(true).optional(),
      failed: z.boolean().optional(),
      /** The session itself asked, in this turn, to hand the person's voice back to Merv. */
      back: z.boolean().optional(),
    })
    .optional(),
});
export type VoiceRead = z.infer<typeof voiceRead>;

/** Phone decisions cannot grant full access or permission for a whole session. */
const phoneDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow') }).strict(),
  z.object({ kind: z.literal('deny') }).strict(),
  z
    .object({
      kind: z.literal('answer'),
      text: z.string().max(20_000).optional(),
      answers: z.record(z.array(z.string().max(20_000))).optional(),
    })
    .strict(),
]);
export const decisionInput = z
  .object({
    device: z.string(),
    thread: z.string(),
    request: z.string(),
    generation: z.number().int(),
    decision: phoneDecision,
  })
  .strict();
/** What the phone may do to a unit held on the Mac: read how it stands, pause it, send it (with the brief as edited), or cancel it. */
export const heldInput = z
  .object({
    device: z.string(),
    command: z.string(),
    act: z.enum(['read', 'hold', 'send', 'cancel']),
    brief: z.string().min(1).max(8000).optional(),
  })
  .strict();

/** What browsing taught Merv, as the Mac keeps it (Merv Nightly's interests index), for a page that shows it: the switch,
 *  where it reads, and its topics and sites. Never the people looked up, nor the digest agents are told. */
/** Words from the Mac's own index are clipped on the way, never a reason to refuse the whole answer. */
const clipped = (most: number) => z.string().transform((value) => value.slice(0, most));
const interestTopic = z.object({
  id: z.string().max(200),
  name: clipped(200),
  line: clipped(1000),
});
export const interestsStatus = z.object({
  on: z.boolean(),
  kept: z.boolean(),
  running: z.boolean().optional(),
  error: clipped(400).optional(),
  browsers: z
    .array(
      z.object({
        browser: clipped(80),
        profiles: z.number().int().nonnegative(),
        needsAccess: z.boolean().optional(),
      }),
    )
    .max(40),
  today: z.array(interestTopic).max(100).optional(),
  week: z.array(interestTopic).max(100).optional(),
  month: z.array(interestTopic).max(100).optional(),
  fresh: z.array(interestTopic).max(100).optional(),
  fading: z.array(interestTopic).max(100).optional(),
  time: z.array(clipped(300)).max(100).optional(),
  sites: z.array(clipped(300)).max(100).optional(),
});
export type InterestsStatus = z.infer<typeof interestsStatus>;
/** What the cloud may ask of it: read it, turn it on or off, delete it, or remove a topic or a site for good. */
export const interestsAsk = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }),
  z.object({ action: z.literal('set'), yes: z.boolean() }),
  z.object({ action: z.literal('forget') }),
  z.object({
    action: z.literal('remove'),
    topic: z.string().max(200).optional(),
    site: z.string().max(300).optional(),
  }),
]);
export type InterestsAsk = z.infer<typeof interestsAsk>;

/** What a job's page from afar can ask of its Mac: a job set to start later cancelled or started now; one under way
 *  continued or stopped; an ended one's work merged, put up as a pull request, or discarded. */
export const jobActs = [
  'cancel',
  'start',
  'continue',
  'stop',
  'merge',
  'pull-request',
  'discard',
] as const;
/** The job page a Mac sends: Merv.app's own read of it (desk-ui job-model JobPage), redacted and within these caps. */
export const JOB_PAGE_BYTES = 1_500_000;
export const jobPageContract = 1;
export const jobPageWire = z
  .object({
    id: z.string().max(200),
    main: z.string().max(200),
    state: z.enum(['running', 'needs', 'done', 'stopped']),
    now: z.string(),
  })
  .passthrough()
  .refine((page) => JSON.stringify(page).length <= JOB_PAGE_BYTES * 1.1, 'job page too large');
export type JobPageWire = z.infer<typeof jobPageWire>;

/** Everyday controls use one live, bounded request; never a queued command or a local URL. */
const parityOptions = z
  .object({
    model: z.string().max(200).optional(),
    effort: z.string().max(40).optional(),
    speed: z.string().max(40).optional(),
    mode: z.enum(['act', 'plan']).optional(),
    access: z.enum(['ask', 'edit', 'full']).optional(),
  })
  .strict();
export const attachmentGuide =
  'Pass the person’s attached images by ID with attachments instead of describing them.';
export const PARITY_FILE_BYTES = 8 * 1024 * 1024;
const parityFile = z
  .object({
    name: z.string().min(1).max(120),
    mediaType: z.string().max(200),
    data: z
      .string()
      .min(4)
      .max(4 * Math.ceil(PARITY_FILE_BYTES / 3)),
  })
  .strict();
export const parityMessage = parityOptions
  .extend({
    id: z.string().min(1).max(100),
    text: z.string().max(20_000),
    attachments: z.array(parityFile).max(8).optional(),
  })
  .strict();
export const parityAsk = z.discriminatedUnion('action', [
  z.object({ action: z.literal('state') }).strict(),
  z
    .object({
      action: z.literal('search'),
      current: z.boolean().optional(),
      query: z.string().max(500),
      after: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('agent'),
      provider: z.enum(['claude', 'codex']),
      defaults: parityOptions.omit({ mode: true }).optional(),
    })
    .strict(),
  z.object({ action: z.literal('usage'), provider: z.enum(['claude', 'codex']) }).strict(),
  z
    .object({ action: z.literal('models'), provider: z.enum(['claude', 'codex']).optional() })
    .strict(),
  z.object({ action: z.literal('files'), query: z.string().max(500) }).strict(),
  z.object({ action: z.literal('commands'), query: z.string().max(500) }).strict(),
  z.object({ action: z.literal('message'), message: parityMessage }).strict(),
  z
    .object({
      action: z.literal('queue'),
      afterTurn: z.number().int().min(0).optional(),
      before: z.string().max(100),
      operation: z.enum(['add', 'remove', 'up', 'down', 'send', 'edit']),
      text: z.string().max(20_000).optional(),
      id: z.string().max(100).optional(),
      message: parityMessage.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('title'),
      title: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[^\x00-\x1f\x7f]+$/),
    })
    .strict(),
  z.object({ action: z.literal('pin'), yes: z.boolean() }).strict(),
  z.object({ action: z.literal('archive'), yes: z.boolean() }).strict(),
  z.object({ action: z.literal('branches') }).strict(),
  z.object({ action: z.literal('changes') }).strict(),
  z.object({ action: z.literal('tool'), item: z.string().min(1).max(300) }).strict(),
]);
export type ParityAsk = z.infer<typeof parityAsk>;

export const up = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('parity_result'),
    id: z.string(),
    value: z.unknown().optional(),
    error: z.string().max(300).optional(),
  }),
  z.object({
    t: z.literal('configuration'),
    id: z.string(),
    configuration: configuration.optional(),
    models: z.array(modelChoice).optional(),
    error: z.string().optional(),
  }),
  z.object({ t: z.literal('return'), result: returned }),
  z.object({ t: z.literal('browser_result'), id: z.string(), answer: browserAnswer }),
  z.object({
    t: z.literal('chat'),
    id: z.string(),
    chat: chat.optional(),
    error: z.string().optional(),
  }),
  z.object({
    t: z.literal('voice'),
    id: z.string(),
    read: voiceRead.optional(),
    error: z.string().optional(),
  }),
  z.object({ t: z.literal('decision_result'), id: z.string(), error: z.string().optional() }),
  /** How a held unit stands after the phone touched it: when it sends itself, or null while it waits. */
  z.object({
    t: z.literal('held_result'),
    id: z.string(),
    sendAt: z.number().nullable().optional(),
    brief: z.string().max(8000).optional(),
    error: z.string().optional(),
  }),
  z.object({
    t: z.literal('hello'),
    deviceId: z.string(),
    seq: z.number(),
    /** `memory`: sessions started in this folder are told a pinned board frame. */
    /** main: the folder the person chose for new sessions that name none. */
    projects: z.array(
      z.object({
        project: z.string(),
        label: z.string(),
        pi: z.boolean(),
        memory: z.boolean().optional(),
        main: z.boolean().optional(),
      }),
    ),
    threads: z.array(threadState),
    person: person.optional(),
    /** The job page this Mac answers `job_read` with (see jobPageContract). Absent on older apps, which have none. */
    jobs: z.number().int().optional(),
    /** The browser contract this Mac's app speaks (see browserContract). Absent on older apps. */
    browser: z.number().int().optional(),
    /** The agents this Mac can run, as found on the person's PATH. */
    providers: z.array(z.enum(['claude', 'codex'])).optional(),
    /** Installed agents waiting on the person, so the board can point them to sign in. */
    unready: z.array(z.enum(['claude', 'codex'])).optional(),
    /** The last folder picked here, by its shared id rather than its path. */
    opened: z.string().optional(),
    /** How commands the cloud may still think open actually ended, after a restart or a gap. */
    settled: z
      .array(
        z.object({
          id: z.string(),
          state: z.enum(commandStates),
          reason: z.string().optional(),
          thread: z.string().optional(),
        }),
      )
      .optional(),
  }),
  z.object({ t: z.literal('persona_sync'), persona: personaView }),
  z.object({
    t: z.literal('persona_result'),
    id: z.string(),
    persona: personaView.optional(),
    error: z.string().optional(),
  }),
  z.object({
    t: z.literal('interests_result'),
    id: z.string(),
    status: interestsStatus.optional(),
    error: z.string().max(200).optional(),
  }),
  z.object({ t: z.literal('revalidate'), ids: z.array(z.string()) }),
  z.object({ t: z.literal('thread'), seq: z.number(), thread: threadState }),
  z.object({
    t: z.literal('command_state'),
    configuration: z.array(configuration).min(1).max(3).optional(),
    run: z.number().int().min(0).max(2).optional(),
    seq: z.number(),
    id: z.string(),
    state: z.enum(commandStates),
    result: z.object({ text: z.string().max(100_000) }).optional(),
    reason: z.string().optional(),
    thread: z.string().optional(),
  }),
  z.object({ t: z.literal('memory_result'), id: z.string(), error: z.string().optional() }),
  /** A worker's turn in full, as `report_read` asked. */
  z.object({
    t: z.literal('report'),
    id: z.string(),
    report: agentReport.optional(),
    error: z.string().max(200).optional(),
  }),
  /** A job's own page, as `job_read` asked: the same read Merv.app's job page has, capped and redacted (desk-server farPage). */
  z.object({
    t: z.literal('job_page'),
    id: z.string(),
    page: jobPageWire.optional(),
    error: z.string().max(200).optional(),
  }),
  /** Stream events in the order they happened; each is acknowledged by its local id once kept. */
  z.object({ t: z.literal('stream'), events: z.array(streamOut).min(1).max(50) }),
]);
export type Up = z.infer<typeof up>;

export const issuer = z.object({
  kind: z.enum(['person', 'pi']),
  userId: z.string(),
  conversationId: z.string().optional(),
});

export const followupWhen = z.union([
  z
    .object({
      at: z
        .number()
        .finite()
        .positive()
        .describe('Unix seconds; resolve relative times in the person’s timezone.'),
    })
    .strict(),
  z.object({ on: z.literal('done') }).strict(),
  z.object({ on: z.literal('pr'), rounds: z.number().int().min(1).max(3).optional() }).strict(),
]);
export type FollowupWhen = z.infer<typeof followupWhen>;

const commandMessage = z.object({
  t: z.literal('command'),
  id: z.string(),
  issuer,
  target: z.object({
    project: z.string().optional(),
    thread: z.string().optional(),
    generation: z.number().optional(),
    turn: z.string().optional(),
  }),
  kind: z.enum(['start', 'message', 'interrupt', 'unit', 'keep', 'job', 'switch']),
  body: z.object({
    /** A job set to start later, acted on from the web: cancel it, or start it now. Sent to the project's main thread. */
    /** A job under way or ended, acted on from its page: continue or stop it, or merge, open a pull request for or
     *  discard its writer's work. */
    job: z.object({ id: z.string().min(1).max(200), action: z.enum(jobActs) }).optional(),
    /** Durable person message to a project manager; reuses the web composer's payload. */
    reply: parityMessage.optional(),
    stop: z.boolean().optional(),
    pointing: z.string().max(1_300).optional(),
    configuration: configuration.optional(),
    /** Admission already happened on hosted; sleep does not expire this command. */
    durable: z.literal(true).optional(),
    /** Keep this message's final answer under the command id until acknowledged. */
    respond: z.literal(true).optional(),
    when: followupWhen.optional(),
    provider: z.enum(['claude', 'codex']).optional(),
    text: z.string().optional(),
    unit: unit.optional(),
    run: binding.shape.run.optional(),
    keep: binding
      .pick({ unit: true, run: true })
      .extend({ return: returned.shape.id.optional() })
      .optional(),
    images: z.array(picture).max(2).optional(),
    attachments: artifactImageIds.optional(),
    /** Said to it by voice: the turn it begins is marked, so its answer can be told apart. */
    voice: z.boolean().optional(),
    source: sessionSource.optional(),
    requestId: z.string().max(200).optional(),
  }),
  issuedAt: z.string(),
  expiresAt: z.string(),
});
function validUnit(value: z.infer<typeof commandMessage>, ctx: z.RefinementCtx) {
  if (
    value.body.attachments &&
    (value.body.reply || !['message', 'start', 'unit'].includes(value.kind))
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Image IDs go with a start, message or unit',
      path: ['body', 'attachments'],
    });
  if (
    value.body.respond &&
    (value.kind !== 'message' ||
      value.issuer.kind !== 'pi' ||
      !value.target.thread ||
      value.body.unit ||
      value.body.when ||
      !value.body.durable)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A command answer belongs to a durable Merv message',
      path: ['body', 'respond'],
    });
  if (
    value.body.reply &&
    (value.kind !== 'message' ||
      value.issuer.kind !== 'person' ||
      !value.target.thread ||
      value.body.unit ||
      value.body.when)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A durable reply belongs to a person messaging a manager',
      path: ['body', 'reply'],
    });
  if (
    value.kind === 'switch' &&
    (!value.target.thread ||
      !value.body.provider ||
      value.body.text ||
      value.body.unit ||
      value.body.images ||
      value.body.source)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Switch needs a manager thread and provider',
      path: ['body'],
    });
  if (value.body.stop !== undefined && value.kind !== 'switch')
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stop belongs to a provider switch',
      path: ['body', 'stop'],
    });
  if (value.body.pointing && (value.kind !== 'message' || value.issuer.kind !== 'person'))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Board pointing accompanies a person message',
      path: ['body', 'pointing'],
    });
  if (value.body.when && (value.kind !== 'message' || !value.target.thread || value.body.unit))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Follow-up needs an existing session message',
      path: ['body', 'when'],
    });
  if (
    value.kind === 'unit' &&
    (!value.body.unit ||
      value.target.thread ||
      value.target.project !== value.body.unit.place.project)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A unit command needs its frozen work and project',
      path: ['body', 'unit'],
    });
  if (value.kind === 'keep' && (!value.body.keep || !value.target.thread))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Keep needs a unit run and its thread',
      path: ['body', 'keep'],
    });
  if (value.body.keep && value.kind !== 'keep')
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only keep carries a winner',
      path: ['body', 'keep'],
    });
  if (
    value.kind === 'message' &&
    value.body.unit &&
    (!value.target.thread || value.body.run === undefined || !value.body.unit.parent)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A revision needs its run, thread and parent return',
      path: ['body', 'unit'],
    });
  if (value.kind === 'unit' && value.body.unit?.frame && value.body.unit.root)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A unit cannot have both a frame and a root region',
      path: ['body', 'unit'],
    });
  if (
    value.kind === 'start' &&
    value.body.unit &&
    (value.body.run === undefined ||
      !value.body.unit.dispatch[value.body.run] ||
      value.target.thread ||
      value.target.project !== value.body.unit.place.project)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A fresh run needs its frozen work, run and project',
      path: ['body', 'unit'],
    });
  if ((value.kind === 'job') !== !!value.body.job || (value.kind === 'job' && !value.target.thread))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A job command names the job and its main thread',
      path: ['body', 'job'],
    });
  if (!['unit', 'message', 'start'].includes(value.kind) && value.body.unit)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only unit, start and message commands carry frozen work',
      path: ['body', 'unit'],
    });
}
export const command = commandMessage.superRefine(validUnit);
export type Command = z.infer<typeof command>;

/** A board frame frozen for a folder: what every session started there is told and shown first. */
const memoryFrame = z.object({
  board: z.string(),
  frame: z.string(),
  title: z.string().max(200),
  text: z.string().max(2400),
  // The same picture a command carries.
  picture,
});
export type MemoryFrame = z.infer<typeof memoryFrame>;

export const down = z
  .discriminatedUnion('t', [
    z.object({
      t: z.literal('parity'),
      id: z.string(),
      userId: z.string(),
      thread: z.string(),
      expiresAt: z.string().datetime(),
      ask: parityAsk,
    }),
    configurationRequest.extend({
      t: z.literal('configuration_read'),
      id: z.string(),
      userId: z.string(),
      expiresAt: z.string(),
    }),
    z.object({ t: z.literal('return_ack'), id: z.string() }),
    z.object({ t: z.literal('browser_cancel'), id: z.string() }),
    z.object({ t: z.literal('command_ack'), id: z.string() }),
    z.object({ t: z.literal('outcome_ack'), thread: z.string(), id: z.string() }),
    /** Stream events kept, or kept already, by their local ids. */
    z.object({ t: z.literal('stream_ack'), locals: z.array(z.string().max(300)).max(50) }),
    z.object({
      t: z.literal('browser'),
      id: z.string(),
      userId: z.string(),
      expiresAt: z.string().datetime(),
      tool: browserTool,
      input: z.record(z.unknown()),
    }),
    /** Without a cursor, the newest page. `after` reads on from a position; `before` reads the page
     *  just before one, for a phone scrolling up: its blocks oldest first, `clipped` while more lie behind. */
    z.object({
      t: z.literal('chat_read'),
      id: z.string(),
      userId: z.string(),
      thread: z.string(),
      return: z.string().optional(),
      after: z.string().max(300).optional(),
      before: z.string().max(300).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    /** A completion's full result by its key, or, with only `agent`, that session's newest turn with its latest steps. Read only. */
    z.object({
      t: z.literal('report_read'),
      id: z.string(),
      userId: z.string(),
      completion: z.string().max(300).optional(),
      agent: z.string().max(200).optional(),
    }),
    /** A job's own page, by the job and the main thread it belongs to. Read only. */
    z.object({
      t: z.literal('job_read'),
      id: z.string(),
      userId: z.string(),
      job: z.string().min(1).max(200),
      main: z.string().min(1).max(200),
    }),
    /** With `command`, the turn that voice request began. */
    z.object({
      t: z.literal('voice_read'),
      id: z.string(),
      userId: z.string(),
      thread: z.string(),
      command: z.string().optional(),
    }),
    decisionInput.omit({ device: true }).extend({
      t: z.literal('decision'),
      id: z.string(),
      userId: z.string(),
      expiresAt: z.string(),
    }),
    heldInput
      .omit({ device: true })
      .extend({ t: z.literal('held'), id: z.string(), userId: z.string(), expiresAt: z.string() }),
    /** `open`: commands the cloud still thinks unfinished, for the Mac to settle. */
    z.object({ t: z.literal('welcome'), userId: z.string(), open: z.array(z.string()).optional() }),
    z.object({
      t: z.literal('revalidated'),
      valid: z.array(z.string()),
      invalid: z.array(z.string()),
    }),
    commandMessage,
    z.object({
      t: z.literal('persona'),
      id: z.string(),
      userId: z.string(),
      expiresAt: z.string().datetime(),
      persona: personaView.optional(),
      edit: personaEdit.optional(),
      action: z.enum(['rebuild', 'learn']).optional(),
      yes: z.boolean().optional(),
    }),
    z.object({
      t: z.literal('interests'),
      id: z.string(),
      userId: z.string(),
      expiresAt: z.string().datetime(),
      ask: interestsAsk,
    }),
    z.object({ t: z.literal('revoked') }),
    /** Without `frame`, the folder forgets its memory. */
    z.object({
      t: z.literal('memory'),
      id: z.string(),
      userId: z.string(),
      expiresAt: z.string().datetime(),
      project: z.string(),
      frame: memoryFrame.optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.t === 'command') validUnit(value, ctx);
  });
export type Down = z.infer<typeof down>;
