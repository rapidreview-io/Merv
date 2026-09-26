import {
  filterAsync,
  keyId,
  keyKind,
  mapAsync,
  MervError,
  personMove,
  runningKey,
  runningKeyPattern,
  type Actor,
  type Caller,
  type CodeCommandRecord,
  type CodeUnit,
  type PersonMove,
  type RunningAttention,
  type RunningFact,
  type RunningMark,
  type RunningNode,
  type RunningNodeLink,
  type RunningPanelPart,
  type RunningPhrase,
  type RunningSection,
  type RunningSummary,
  type RunningTarget,
  type Scope,
  type Sql,
  type State,
  type Transaction,
  type WorkflowProvidedBlocker,
  type Workflows,
} from '@merv/contracts';
import type { CodeBaseService, CodeCheckStanding } from './bases.js';

/**
 * Code's part of the Running page, read inside the page's snapshot and never written from.
 * Code says three things there. Which work still owes a person a move: the blockers Code
 * already publishes, read back through Workflows and worded by the person moves the Code page
 * speaks, so a done task whose pull request waits for a merge stays on the board saying so.
 * Which machines its project checks hold, from the handle each check persists, and which one
 * a check could not give back, from the blocker it wrote when it let go. And the Code
 * section of any work that has a unit: its branch, where its work has got to, its acceptance
 * and its publication, led by the move a person owes it.
 */

const PROVIDER = 'code';
/** How much done work Code holds on the board. The rest is counted, and drawn on Code. */
export const HELD = 20;
/**
 * The codes of a publication. A publication wait is the one opinion Code keeps about work
 * that has ended (units.ts reconcileUnit), so these, and only these, hold done work.
 */
const PUBLICATION = new Set([
  'code_publication_pending',
  'code_publication_stale',
  'code_publication_disabled',
  'code_publication_closed',
  'code_publish_unverifiable',
  'code_publication_incident',
]);

/** One blocker and the move it asks of a person. */
export interface HeldMove {
  blocker: WorkflowProvidedBlocker;
  move: PersonMove;
}

/**
 * Per instance, the first of Code's blockers whose next move is an operator's or an
 * administrator's, in the order Workflows keeps them. A wait on the server is nobody's move,
 * however well a person may read why it waits, so it marks nothing.
 */
export function personMoves(blockers: readonly WorkflowProvidedBlocker[]): HeldMove[] {
  const first = new Map<string, HeldMove>();
  for (const blocker of blockers) {
    if (blocker.provider !== PROVIDER || first.has(blocker.instanceId)) continue;
    const move = personMove(blocker);
    if (move && move.whose !== 'nobody') first.set(blocker.instanceId, { blocker, move });
  }
  return [...first.values()];
}

/**
 * The one way to a move, offered only to whoever can make it. Every control of this
 * vocabulary answers a signed-in operator, and a link a reader would follow to a page that
 * draws no button for them promises an act (ruling 11): the move is said to everybody.
 */
const way = (move: PersonMove, operator: boolean) =>
  move.control && operator ? { route: move.control.to, text: move.control.label } : undefined;

/** The reader Code's publication controls answer: an operator signed in as a person. */
const signedIn = (caller: Caller, actor: Actor) =>
  actor.role === 'operator' && !!caller.human && !caller.session && !caller.key;

/**
 * The marks. Open work is drawn by its owner whatever Code says, so each of its moves is a
 * mark. Done work stays on the board only because of its mark, so the newest are held and the
 * rest are one line of the work lane, whose way leads to Code, where every one is drawn.
 */
export function holdsOf(
  open: readonly HeldMove[],
  done: readonly HeldMove[],
  operator: boolean,
): { marks: RunningMark[]; summary: RunningSummary | null } {
  const newest = [...done].sort(
    (a, b) => Date.parse(b.blocker.since) - Date.parse(a.blocker.since),
  );
  const held = newest.slice(0, HELD);
  const more = newest.length - held.length;
  return {
    marks: [...open, ...held].map(({ blocker, move }) => {
      const to = way(move, operator);
      return {
        key: runningKey('work', blocker.instanceId),
        says: [move.sentence],
        who: move.who,
        ...(to ? { to } : {}),
      };
    }),
    summary: more
      ? {
          lane: 'work',
          says: [],
          attention: {
            says: [{ count: more }, ' more waiting on a person'],
            to: { route: '/code', text: 'Open Code' },
          },
          actions: [],
        }
      : null,
  };
}

/** A command's first line, which is all a card has room for. */
const commandLine = (command: string) => {
  const line = command.trim().split(/\r?\n/)[0].trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

/**
 * How long a check may stand past its deadline before a person is asked to move. Code fails
 * such a base itself on its next drain (bases.ts drain), which comes every five seconds but
 * waits behind a merge in hand, and a merge is given two minutes; until then it is stopping.
 */
export const OVERDUE_GRACE_MS = 180_000;

/** The sandboxes a check's machines are, so their owner's nodes fold into the check's. */
function machinesOf(check: CodeCheckStanding): string[] {
  return [
    ...new Set(
      [check.sandboxId, check.unreclaimed?.sandboxId].flatMap((id) => {
        const key = id && runningKey('sandbox', id);
        return key && runningKeyPattern.test(key) ? [key] : [];
      }),
    ),
  ];
}

/** Work a check proves: selected where the board draws it, and read on Code where it does not. */
function unitTarget(unitId: string): RunningTarget {
  const key = runningKey('work', unitId);
  const route = `/code/unit/${encodeURIComponent(unitId)}`;
  return runningKeyPattern.test(key) ? { key, route } : { route };
}

interface CheckFace {
  line: RunningPhrase;
  look: RunningNode['look'];
  dot?: RunningNode['dot'];
  attention?: RunningAttention;
}

/** The states a check ends in; any other is where one stood when its base stopped under it. */
const ENDED = new Set(['passed', 'failed', 'skipped', 'unavailable']);

/** Where the check itself stands: its line, how it looks, its dot, and what it asks of anyone. */
function phaseFace(check: CodeCheckStanding, now: number): CheckFace {
  if (check.phase === null)
    return {
      line: ENDED.has(check.checkState)
        ? ['Ended · ', { state: check.checkState }]
        : ['Stopped · ', { state: check.base }],
      look: 'quiet',
    };
  if (check.phase === 'returning') {
    const refused = check.releaseAttempts;
    return {
      line: ['Giving machine back'],
      look: 'quiet',
      // Code asks again on every pass, and names the machine to an operator only once it
      // gives up; until then a refusal is nobody's move, so it is said in ink.
      ...(refused
        ? {
            attention: {
              says: [
                'Giving machine back · refused ',
                { count: refused },
                refused === 1 ? ' time, retrying' : ' times, retrying',
              ],
              quiet: true as const,
            },
          }
        : {}),
    };
  }
  // Only the deadline is kept: when the command began is nowhere recorded, so no clock is
  // drawn. Past it, Code fails the base on its own; only a check still here after the
  // grace is waiting on a person.
  const running = check.phase === 'running';
  const over = check.deadline ? now - Date.parse(check.deadline) : Number.NaN;
  return {
    line: running ? ['Running'] : ['Starting'],
    look: running ? 'solid' : 'dashed',
    dot: running ? 'live' : 'starting',
    ...(over >= OVERDUE_GRACE_MS
      ? {
          attention: {
            says: ['Past its deadline'],
            who: 'An operator retries or cancels the base on Code',
          },
        }
      : over >= 0
        ? { attention: { says: ['Past its deadline · stopping'], quiet: true as const } }
        : {}),
  };
}

/**
 * A check's line, how it looks, its dot, and what it needs of a person, from where it stands.
 * A machine Code let go of is still rented, and nothing but a person will give it back, so
 * that outranks whatever the check itself is doing.
 */
function checkFace(check: CodeCheckStanding, now: number): CheckFace {
  const face = phaseFace(check, now);
  return check.unreclaimed
    ? {
        ...face,
        attention: {
          says: ['Machine not given back'],
          who: 'An operator releases it from the sandboxes console',
        },
      }
    : face;
}

/** A check that holds a machine, as the hardware lane draws it. */
export function checkNode(
  check: CodeCheckStanding,
  command: string | null,
  units: readonly string[],
  now: number,
): RunningNode {
  const face = checkFace(check, now);
  const machines = machinesOf(check);
  const links = units
    .map((unitId) => runningKey('work', unitId))
    .filter((key) => runningKeyPattern.test(key))
    .slice(0, 64)
    .map((to): RunningNodeLink => ({ to, verb: 'checks' }));
  return {
    key: runningKey('check', check.key),
    lane: 'hardware',
    title: 'Code check',
    ...(command ? { name: commandLine(command) } : {}),
    lines: [face.line],
    look: face.look,
    ...(face.dot ? { dot: face.dot } : {}),
    ...(face.attention ? { attention: face.attention } : {}),
    units: { count: 1, busy: check.phase === 'running' },
    ...(links.length ? { links } : {}),
    ...(machines.length ? { aliases: machines } : {}),
  };
}

/**
 * Whether a base has a check to speak of. One that is not checking, whose check left no
 * verdict and no machine, never had one, or had one that stopped and gave its machine back.
 */
export const hasCheck = (check: CodeCheckStanding) =>
  check.phase !== null || !!check.unreclaimed || check.checkState !== 'none';

/**
 * A check's sidebar: when it runs out of time, what it runs, and the accepted work it proves
 * merges cleanly, which is the only honest "used by" a check machine has. The machine itself
 * is the absorbed sandbox's to describe. No controls: Code gives its machines back itself,
 * and a base's controls take a reason, on Code.
 */
export function checkPanel(
  check: CodeCheckStanding,
  command: string | null,
  members: readonly { unitId: string; name: string }[],
  now: number,
): RunningPanelPart {
  const face = checkFace(check, now);
  const machines = machinesOf(check);
  const sections: RunningSection[] = [];
  const facts: RunningFact[] = [];
  if (
    (check.phase === 'starting' || check.phase === 'running') &&
    check.deadline &&
    Date.parse(check.deadline) > now
  )
    facts.push({ label: 'Deadline', value: [{ until: check.deadline }] });
  // The title has room for the first line only; the whole command is machine text to copy.
  const whole = command?.trim();
  if (whole && whole !== commandLine(whole) && whole.length <= 400)
    facts.push({ label: 'Command', value: [{ mono: whole }] });
  if (facts.length)
    sections.push({ title: 'Check', place: 'activity', kind: 'facts', rows: facts });
  if (members.length)
    sections.push({
      title: 'Checking',
      place: 'relations',
      kind: 'links',
      rows: members.map(({ unitId, name }) => ({ to: unitTarget(unitId), name })),
    });
  return {
    header: {
      kind: 'Code check',
      title: command ? commandLine(command) : 'Code check',
      says: face.line,
      ...(face.attention ? { attention: face.attention } : {}),
    },
    sections,
    actions: [],
    route: `/code/merge/${check.key}`,
    live: check.phase !== null,
    ...(machines.length ? { aliases: machines } : {}),
  };
}

const counted = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * The Code section of one unit's work. The move a person owes it leads, in the words and with
 * the one control the Code page gives it; where no person owes one, the wait on the server is
 * said in ink. Then the branch, where the work has got to since its base, when it was
 * accepted and where its publication stands. A fact with nothing behind it is not a row.
 */
export function codeSection(
  unit: CodeUnit,
  blockers: readonly WorkflowProvidedBlocker[],
  receipt: CodeCommandRecord | null,
  operator: boolean,
): RunningSection {
  const moves = blockers.flatMap((blocker) => {
    const move = personMove(blocker);
    return move ? [{ blocker, move }] : [];
  });
  const lead = moves.find(({ move }) => move.whose !== 'nobody') ?? moves[0];
  const rows: RunningFact[] = [];
  if (lead) {
    const { blocker, move } = lead;
    const person = move.whose !== 'nobody';
    const to = person ? way(move, operator) : undefined;
    rows.push({
      label: person ? 'Needs' : 'Waiting',
      value: [
        move.sentence,
        ' · ',
        move.who,
        ...(blocker.since ? [' · ', { ago: blocker.since }] : []),
        ...(to ? [' · ', { link: { route: to.route }, text: to.text }] : []),
      ],
      ...(person ? { attention: true } : {}),
    });
  }
  // Sent whole, because it is what an operator fetches: the page prints the id inside it by
  // its head and its tail, as the Code page does, and copies all of it.
  rows.push({ label: 'Branch', value: [{ mono: unit.branch }] });
  const stats = receipt?.receipt?.stats;
  if (stats || unit.canonicalHead)
    rows.push({
      label: 'Working',
      value: [
        { state: unit.writerState },
        ...(stats && receipt
          ? [
              ` · ${counted(stats.commitCount, 'commit')} since base · +${stats.insertions} −${stats.deletions} in ${counted(stats.filesChanged, 'file')} · last commit `,
              { ago: receipt.command.createdAt },
            ]
          : []),
      ],
    });
  const accepted = unit.acceptance;
  if (accepted)
    rows.push({
      label: 'Accepted',
      value:
        accepted.storage === 'none'
          ? ['Without code · ', { ago: accepted.acceptedAt }]
          : [{ ago: accepted.acceptedAt }],
    });
  const publication = unit.publication;
  if (publication)
    rows.push({
      label: 'Publication',
      value: [
        { state: publication.state },
        ...(publication.pull
          ? [' · ', { link: { href: publication.pull.url }, text: `#${publication.pull.number}` }]
          : []),
      ],
    });
  if (unit.quarantine)
    rows.push({
      label: 'Quarantined',
      value: ['The code kept here cannot be used'],
      attention: true,
    });
  return {
    title: 'Code',
    place: 'code',
    kind: 'facts',
    rows,
    ...(rows.some((row) => row.attention) ? { attention: true } : {}),
  };
}

/** The units that accepted each of these commits, through the index Code keeps on them. */
async function acceptedUnits(
  sql: Sql,
  projectId: string,
  commits: readonly string[],
): Promise<Map<string, string[]>> {
  const wanted = [...new Set(commits)];
  const units = new Map<string, string[]>();
  if (!wanted.length) return units;
  for (const row of await sql.all<{ unit_id: string; accepted_commit: string }>(
    `SELECT unit_id,(acceptance_json::jsonb #>> '{code,commit}') AS accepted_commit FROM code_units WHERE project_id=? AND acceptance_json IS NOT NULL AND (acceptance_json::jsonb #>> '{code,commit}') IN (${wanted.map(() => '?').join(',')}) ORDER BY unit_id`,
    projectId,
    ...wanted,
  ))
    units.set(row.accepted_commit, [...(units.get(row.accepted_commit) ?? []), row.unit_id]);
  return units;
}
const unitsOf = (check: CodeCheckStanding, accepted: ReadonlyMap<string, string[]>) => [
  ...new Set(check.members.flatMap((commit) => accepted.get(commit) ?? [])),
];

/** A record another owner answers 404 for is simply not there to speak of. */
const absent = (error: unknown): null => {
  if (error instanceof MervError && error.status === 404) return null;
  throw error;
};

/** What the reader asks of the rest of Code. */
export interface CodeRunningSources {
  unit(caller: Caller, unitId: string, tx: Transaction): Promise<CodeUnit>;
  /** Absent where the server keeps no repositories, and so no bases. */
  bases(): CodeBaseService | undefined;
  receipt(sql: Sql, projectId: string, instanceId: string): Promise<CodeCommandRecord | null>;
}

/**
 * Each read is one transaction on the page's snapshot, into which every component read is
 * passed, so none of them opens a second one; none of them writes.
 */
export class CodeRunningReader {
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly workflows: Workflows,
    private readonly sources: CodeRunningSources,
  ) {}

  async holds(caller: Caller): Promise<{ marks: RunningMark[]; summary: RunningSummary | null }> {
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      const moves = personMoves(await this.workflows.blockers(caller, undefined, tx));
      // A publication is Code's opinion of accepted work, which has ended. Every other code
      // is about work still to do, which its owner draws anyway; a row that outlived its
      // work, such as a quarantine written onto a resolution task that had ended, holds
      // nothing on the board.
      const terminal = new Map(
        this.workflows
          .catalog()
          .map((definition) => [
            `${definition.name}@${definition.version}`,
            new Set(definition.terminal),
          ]),
      );
      const open = await filterAsync(
        moves.filter(({ blocker }) => !PUBLICATION.has(blocker.code)),
        async ({ blocker }) => {
          const work = await this.workflows.get(caller, blocker.instanceId, tx).catch(absent);
          return !!work && !terminal.get(`${work.workflow}@${work.version}`)?.has(work.state);
        },
      );
      return holdsOf(
        open,
        moves.filter(({ blocker }) => PUBLICATION.has(blocker.code)),
        signedIn(caller, actor),
      );
    });
  }

  async checks(caller: Caller): Promise<RunningNode[]> {
    const bases = this.sources.bases();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      // A server that keeps no repositories keeps no bases, nor the table they are kept in.
      if (!bases) return [];
      const checks = await bases.checking(tx, caller.projectId);
      if (!checks.length) return [];
      const command = await bases.checkCommand(tx, caller.projectId);
      const accepted = await acceptedUnits(
        tx,
        caller.projectId,
        checks.flatMap(({ members }) => members),
      );
      const now = Date.now();
      return checks.map((check) => checkNode(check, command, unitsOf(check, accepted), now));
    });
  }

  async panel(caller: Caller, key: string): Promise<RunningPanelPart | null> {
    const baseKey = keyId(key);
    if (keyKind(key) !== 'check' || !/^[0-9a-f]{64}$/.test(baseKey)) return null;
    const bases = this.sources.bases();
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      if (!bases) return null;
      const check = await bases.checkOf(tx, caller.projectId, baseKey);
      if (!check || !hasCheck(check)) return null;
      const command = await bases.checkCommand(tx, caller.projectId);
      const accepted = await acceptedUnits(tx, caller.projectId, check.members);
      const members = await mapAsync(unitsOf(check, accepted), async (unitId) => ({
        unitId,
        name:
          (await this.workflows.dependencyRelations(caller.projectId, unitId, tx))?.instance.name ??
          'Accepted work',
      }));
      return checkPanel(check, command, members, Date.now());
    });
  }

  async sections(caller: Caller, keys: readonly string[]): Promise<RunningSection[]> {
    const units = [...new Set(keys.filter((key) => keyKind(key) === 'work').map(keyId))];
    if (!units.length) return [];
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      const actor = await this.scope.require(caller, 'read', tx);
      const operator = signedIn(caller, actor);
      const sections: RunningSection[] = [];
      for (const unitId of units) {
        const unit = await this.sources.unit(caller, unitId, tx).catch(absent);
        if (!unit) continue;
        const blockers = (await this.workflows.blockers(caller, unitId, tx).catch(absent)) ?? [];
        sections.push(
          codeSection(
            unit,
            blockers.filter(({ provider }) => provider === PROVIDER),
            await this.sources.receipt(tx, caller.projectId, unitId),
            operator,
          ),
        );
      }
      return sections;
    });
  }
}
