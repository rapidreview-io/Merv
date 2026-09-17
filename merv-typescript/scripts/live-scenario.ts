import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { MachineRunner } from '@merv/runner';
import type { RunnerSnapshot } from '@merv/runner';

/** One id per harness process; session offers carry it so reruns never replay a stale offer. */
const RUN_ID = randomBytes(4).toString('hex');

/**
 * Drive one scenario brief through a real Merv server: create its records, let the
 * runner dispatch the offline stages, launch the execution stages under an explicit
 * lease with a network-enabled Codex, and assert the trajectory the brief expects.
 *
 * Usage:
 *   node --import tsx scripts/live-scenario.ts --brief <file> --out <dir> \
 *     [--base-url <url> --project <projectId> --token-env <ENV_NAME>] [--local] \
 *     [--only <name>[,<name>]] [--stop-after <state>] [--max-rounds <n>] \
 *     [--timeout-minutes <n>] \
 *     [--model <codex model>] [--effort <codex effort>] \
 *     [--sandboxes-url <MCP endpoint, e.g. https://sandboxes.example/mcp> --sandboxes-token-env <ENV_NAME>]
 *
 * The machine key is read only from the environment variable named by --token-env
 * (default MERV_SCENARIO_TOKEN). It is never accepted on the command line or from a
 * file, and never written to the run directory. --local stands up an in-process
 * server with a fresh project the way live-experiments.ts does and mints its own
 * credential into that same variable for the lifetime of the process.
 *
 * Brief format: the Markdown the scenario briefs are written in
 * (`Scenarios/briefs/0N-*.md`). Sections are `## [N.] NAME [— …]` with NAME one of
 * PROJECT, CLAIMS, TASKS, EXPERIMENTS, REFLECTION, FEED, LIMITS. Inside them:
 *
 *   PROJECT      **Name:** `project` — and an **Introduction** blockquote; the
 *                **Research cycle** bullets supply `name` and
 *                `consolidationWorkspace`.
 *   CLAIMS       `### C1` with `- \`statement\`: "…"`, `- \`scope\`: "…"` and
 *                `- \`confidence\`: \`medium\``.
 *   TASKS        `### Task \`name\`` with **Title:**, a **Goal:** blockquote and a
 *                **Numbered acceptance checks** list of quoted checks.
 *   EXPERIMENTS  `### Experiment \`name\`` with **Tests:**, **Depends on:**, an
 *                **Intent** blockquote and a **Details** blockquote.
 *   FEED         a numbered list; `[Role]` opens each item, the quoted string is
 *                the body.
 *   LIMITS       prose; the head of it is recorded in the run report.
 *
 * An **EXPECTED TRAJECTORY** table inside a record gives one row per review round
 * (`| round | stage | … \`verdict\` … |`). This harness derives the expected state
 * sequence from those rounds and ASSERTS both. Neither ever reaches an agent: no
 * verdict text is put in any prompt, and the first divergence stops the run with the
 * divergence stated. A record with no table is expected to pass every gate once.
 *
 * A **PLANTED DEFECT** block names the flaw one producing launch is asked to make, so
 * a scripted rejection is earned rather than typed. It reaches that launch's stdin and
 * nothing else — never `details`, never a task check, never a reviewer.
 *
 * Two kinds of stage are launched by this harness under an explicit lease rather than
 * by the runner: those that need network (an experiment's `running`, and a task whose
 * brief says so) and those carrying a planted defect, because the runner builds its
 * child's stdin from the frozen assignment and has no per-assignment prompt hook.
 * Project dispatch is paused while such a stage is pending, so the runner cannot take
 * that lease first; every other stage is carried by the runner's own dispatch.
 */

export interface ClaimBrief {
  key: string;
  statement: string;
  scope?: string;
  confidence?: 'low' | 'medium' | 'high';
}
export interface ReviewExpectation {
  verdict: 'pass' | 'needs_changes' | 'fail';
  returnTo?: string;
}
/** A flaw one producing launch is asked to make. Never shown to a reviewer. */
export interface DefectBrief {
  stage: 'design' | 'execution' | 'delivery';
  round: number;
  text: string;
}
export interface RecordBrief {
  kind: 'task' | 'experiment';
  name: string;
  title?: string;
  goal?: string;
  checks?: string[];
  intent?: string;
  details?: string;
  testedClaims?: string[];
  dependsOn?: string[];
  networkStages?: string[];
  defects?: DefectBrief[];
  trajectory: string[];
  reviewRounds?: ReviewExpectation[];
}
export interface FeedBrief {
  role: string;
  body: string;
  after?: string;
}
export interface Brief {
  project: {
    name: string;
    introduction: string;
    cycle?: { name: string; consolidationWorkspace?: 'none' | 'git'; dependsOn?: string[] };
  };
  claims: ClaimBrief[];
  records: RecordBrief[];
  feed: FeedBrief[];
  limits: string;
}

const sectionNames = [
  'PROJECT',
  'CLAIMS',
  'TASKS',
  'EXPERIMENTS',
  'REFLECTION',
  'FEED',
  'LIMITS',
] as const;
type SectionName = (typeof sectionNames)[number];

/** `## 3. TASKS`, `## 7. LIMITS — …`: the first bare word names the section. */
function sections(markdown: string): Map<SectionName, string> {
  const found = new Map<SectionName, string>();
  let current: SectionName | undefined;
  let body: string[] = [];
  const flush = () => {
    if (current)
      found.set(current, [...(found.get(current) ?? '').split('\n'), ...body].join('\n'));
    body = [];
  };
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(?:\d+\.\s*)?([A-Z]+)\b/.exec(line);
    const name = heading?.[1] as SectionName | undefined;
    if (line.startsWith('## ')) {
      flush();
      current = name && (sectionNames as readonly string[]).includes(name) ? name : undefined;
    } else if (current) body.push(line);
  }
  flush();
  return found;
}

/** Records are `### Task \`name\``, `### Experiment \`name\``, `### C1`. */
function subsections(body: string, heading: RegExp): { key: string; body: string }[] {
  const found: { key: string; body: string }[] = [];
  for (const line of body.split('\n')) {
    const match = heading.exec(line);
    if (match) found.push({ key: match[1], body: '' });
    else if (found.length) found[found.length - 1].body += line + '\n';
  }
  return found;
}

/** Unwrap one Markdown blockquote: soft line breaks close up, blank `>` lines stay. */
function blockquote(body: string, after: RegExp): string | undefined {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => after.test(line));
  if (start < 0) return undefined;
  const quoted: string[] = [];
  let seen = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('>')) {
      seen = true;
      quoted.push(line.replace(/^>\s?/, ''));
    } else if (seen && line.trim() === '') break;
    else if (seen) break;
  }
  if (!quoted.length) return undefined;
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  for (const line of quoted) {
    if (line.trim() === '') {
      if (buffer.length) paragraphs.push(buffer.join(' '));
      buffer = [];
    } else buffer.push(line.trim());
  }
  if (buffer.length) paragraphs.push(buffer.join(' '));
  return paragraphs.join('\n\n').trim() || undefined;
}

/** The remainder of the line carrying a bold label, e.g. `**Title:** \`eval-harness\``. */
function inline(body: string, label: RegExp): string | undefined {
  for (const line of body.split('\n')) {
    const match = label.exec(line);
    if (match) return line.slice(match.index + match[0].length).trim() || undefined;
  }
  return undefined;
}

/** The lines a bold label owns: from that line to the next bold label of its own. */
function labelledRegion(body: string, label: RegExp): string | undefined {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => label.test(line));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\*\*[A-Z]/.test(line));
  return rest.slice(0, end < 0 ? rest.length : end).join('\n');
}

const ticked = (value: string | undefined): string[] =>
  [...(value ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
/** Every "…" string in order, including the ones the brief wraps across lines. */
const quotedStrings = (value: string): string[] =>
  [...value.matchAll(/"([^"]+)"/g)].map((match) => match[1].replace(/\s+/g, ' ').trim());
/** The first "…" string of each numbered item; a note after the list is not a check. */
const numberedQuoted = (value: string): string[] =>
  value
    .split(/\n(?=\s*\d+\. )/)
    .filter((item) => /^\s*\d+\. /.test(item))
    .map((item) => quotedStrings(item)[0])
    .filter((check): check is string => !!check);

/**
 * `**PLANTED DEFECT — producer stdin prompt only, round 1 plan author …**` blocks.
 * These never enter `details`, a task check or any reviewer's prompt: they are the
 * flaw the producer is asked to make, so the rejection the scenario expects is
 * earned rather than typed. The header line names the stage and the round.
 */
function plantedDefects(body: string): DefectBrief[] {
  const defects: DefectBrief[] = [];
  const lines = body.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!/\*\*PLANTED DEFECT/.test(line)) continue;
    const header = lines.slice(index, index + 4).join(' ');
    if (/PLANTED DEFECT:?\**\s*none/i.test(header)) continue;
    const text = blockquote(lines.slice(index).join('\n'), /PLANTED DEFECT/);
    if (!text) continue;
    const stage: DefectBrief['stage'] = /delivery/i.test(header)
      ? 'delivery'
      : /report author|attempt \d+|execut/i.test(header)
        ? 'execution'
        : 'design';
    const round = Number(/(?:round|attempt)\s+(\d+)/i.exec(header)?.[1] ?? 1);
    defects.push({ stage, round, text });
  }
  return defects;
}

/** The state whose producer carries a defect for this kind of record. */
export const defectState = (kind: 'task' | 'experiment', stage: DefectBrief['stage']): string =>
  kind === 'task' ? 'in_progress' : stage === 'execution' ? 'running' : 'planned';

/** The `**EXPECTED TRAJECTORY**` table: one row per review round the brief expects. */
function expectedRounds(body: string): { stage: string; round: ReviewExpectation }[] {
  const start = body.split('\n').findIndex((line) => /EXPECTED TRAJECTORY/.test(line));
  if (start < 0) return [];
  const rounds: { stage: string; round: ReviewExpectation }[] = [];
  for (const line of body.split('\n').slice(start + 1)) {
    if (!line.trim().startsWith('|')) {
      if (rounds.length) break;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3 || !/^\d+/.test(cells[0])) continue;
    const verdict = /`(pass|needs_changes|fail)`/.exec(cells[2])?.[1] as
      ReviewExpectation['verdict'] | undefined;
    if (!verdict) continue;
    const returnTo = /returnTo`?\s*:\s*["'`]?([a-z_]+)/.exec(cells[2])?.[1];
    rounds.push({
      stage: cells[1].toLowerCase(),
      round: { verdict, ...(returnTo ? { returnTo } : {}) },
    });
  }
  return rounds;
}

/**
 * The state sequence those rounds produce. With no table, the clean path: one
 * passing round per gate. Design rejections restart the attempt at `planned`;
 * an attempt rejection goes where the reviewer sent it.
 */
export function deriveTrajectory(
  kind: 'task' | 'experiment',
  rounds: { stage: string; round: ReviewExpectation }[],
): { trajectory: string[]; reviewRounds: ReviewExpectation[] } {
  const effective = rounds.length
    ? rounds
    : kind === 'task'
      ? [{ stage: 'task review', round: { verdict: 'pass' as const } }]
      : [
          { stage: 'design review', round: { verdict: 'pass' as const } },
          { stage: 'attempt review', round: { verdict: 'pass' as const } },
        ];
  const trajectory = [kind === 'task' ? 'in_progress' : 'planned'];
  // Task reviews have fixed routes and reject returnTo; only attempt reviews choose one.
  if (kind === 'task') for (const entry of effective) delete entry.round.returnTo;
  for (const { stage, round } of effective) {
    const design = /design/.test(stage);
    trajectory.push(kind === 'task' ? 'in_review' : design ? 'design_review' : 'experiment_review');
    if (round.verdict === 'fail') trajectory.push(kind === 'task' ? 'failed' : 'failed');
    else if (round.verdict === 'pass')
      trajectory.push(kind === 'task' ? 'done' : design ? 'running' : 'complete');
    else
      trajectory.push(
        kind === 'task' ? 'in_progress' : design ? 'planned' : (round.returnTo ?? 'running'),
      );
  }
  return { trajectory, reviewRounds: effective.map((entry) => entry.round) };
}

export function parseBrief(markdown: string): Brief {
  const found = sections(markdown);
  const projectBody = found.get('PROJECT');
  assert.ok(projectBody, 'Brief needs a ## PROJECT section');
  const introduction = blockquote(projectBody, /\*\*Introduction\*\*/);
  assert.ok(introduction, 'PROJECT needs an **Introduction** blockquote');
  const name = ticked(inline(projectBody, /\*\*Name:?\*\*:?/))[0];
  assert.ok(name, 'PROJECT needs a **Name:** with the project name in backticks');
  const cycleBody = projectBody.slice(projectBody.search(/\*\*Research cycle/));
  const cycleName = /\*\*Research cycle/.test(projectBody)
    ? ticked(inline(cycleBody, /`name`:?/))[0]
    : undefined;

  const claims = subsections(found.get('CLAIMS') ?? '', /^###\s+(C\d+)\s*$/).map(
    ({ key, body }) => {
      const statement = quotedStrings(body.slice(body.search(/`statement`/)))[0];
      assert.ok(statement, `Claim ${key} needs a \`statement\`: "…"`);
      const scopeAt = body.search(/`scope`/);
      return {
        key,
        statement,
        ...(scopeAt >= 0 ? { scope: quotedStrings(body.slice(scopeAt))[0] } : {}),
        confidence: (ticked(inline(body, /`confidence`:?/))[0] ??
          'medium') as ClaimBrief['confidence'],
      };
    },
  );

  const record = (kind: 'task' | 'experiment'): RecordBrief[] =>
    subsections(
      found.get(kind === 'task' ? 'TASKS' : 'EXPERIMENTS') ?? '',
      kind === 'task' ? /^###\s+Task\s+`([^`]+)`/ : /^###\s+Experiment\s+`([^`]+)`/,
    ).map(({ key, body }) => {
      // "`eval-harness` — *not* on `lora-vs-prompt`": only what precedes the dash counts.
      const dependsOn = ticked((inline(body, /\*\*Depends on:?\*\*:?/) ?? '').split(/[—–]/)[0]);
      const testedClaims = [...(inline(body, /\*\*Tests:?\*\*:?/) ?? '').matchAll(/\bC\d+\b/g)].map(
        (match) => match[0],
      );
      const { trajectory, reviewRounds } = deriveTrajectory(kind, expectedRounds(body));
      const needsNetwork = /path B\/C|network on|needs \*\*network|\bnetwork\b/i.test(body);
      const common = {
        kind,
        name: key,
        dependsOn,
        testedClaims,
        trajectory,
        reviewRounds,
        networkStages: kind === 'experiment' ? ['running'] : needsNetwork ? ['in_progress'] : [],
        defects: plantedDefects(body),
      };
      if (kind === 'task') {
        const goal = blockquote(body, /\*\*Goal:?\*\*/);
        const region = labelledRegion(body, /\*\*Numbered acceptance checks/);
        assert.ok(goal, `Task ${key} needs a **Goal:** blockquote`);
        assert.ok(region, `Task ${key} needs a **Numbered acceptance checks** list`);
        const checks = numberedQuoted(region);
        assert.ok(checks.length, `Task ${key} lists no quoted acceptance checks`);
        return {
          ...common,
          title: ticked(inline(body, /\*\*Title:?\*\*:?/))[0] ?? key,
          goal,
          checks,
        } as RecordBrief;
      }
      const intent = blockquote(body, /\*\*Intent\b/);
      assert.ok(intent, `Experiment ${key} needs an **Intent** blockquote`);
      return { ...common, intent, details: blockquote(body, /\*\*Details\b/) ?? '' } as RecordBrief;
    });

  const records = [...record('task'), ...record('experiment')];
  assert.ok(records.length, 'Brief defines no tasks or experiments');
  const names = new Set(records.map((entry) => entry.name));
  assert.equal(names.size, records.length, 'Brief record names must be distinct');
  for (const entry of records)
    entry.dependsOn = (entry.dependsOn ?? []).filter((dependency) => names.has(dependency));

  const feed = (found.get('FEED') ?? '')
    .split(/^\d+\.\s+/m)
    .slice(1)
    .flatMap((item) => {
      const role = /\[([^\]]+)\]/.exec(item)?.[1];
      const body = quotedStrings(item)[0];
      return role && body ? [{ role, body }] : [];
    });

  return {
    project: {
      name,
      introduction,
      ...(cycleName
        ? {
            cycle: {
              name: cycleName,
              consolidationWorkspace: (ticked(inline(cycleBody, /`consolidationWorkspace`:?/))[0] ??
                'none') as 'none' | 'git',
              dependsOn: [...names],
            },
          }
        : {}),
    },
    claims,
    records,
    feed,
    limits: (found.get('LIMITS') ?? '').trim().slice(0, 4000),
  };
}
/** Topological order over `dependsOn`, preserving brief order among independents. */
export function creationOrder(records: RecordBrief[]): RecordBrief[] {
  const remaining = [...records];
  const done = new Set<string>();
  const ordered: RecordBrief[] = [];
  while (remaining.length) {
    const index = remaining.findIndex((entry) =>
      (entry.dependsOn ?? []).every((name) => done.has(name)),
    );
    assert.ok(index >= 0, 'Brief records contain a dependency cycle');
    const [next] = remaining.splice(index, 1);
    done.add(next.name);
    ordered.push(next);
  }
  return ordered;
}

export interface Divergence {
  record: string;
  kind: 'trajectory' | 'verdict';
  expected: string;
  observed: string;
  detail: string;
}

/**
 * Compare what the record actually did with what the brief expected. The observed
 * sequence must be a prefix of the expected one until it is complete; anything else
 * is a divergence the founder debugs from the report.
 */
export function matchTrajectory(
  name: string,
  expected: string[],
  observed: string[],
): Divergence | null {
  for (const [index, state] of observed.entries()) {
    if (index >= expected.length)
      return {
        record: name,
        kind: 'trajectory',
        expected: `no state after ${expected.at(-1)}`,
        observed: state,
        detail: `${name} continued past its expected terminal state: ${observed.join(' -> ')}`,
      };
    if (expected[index] !== state)
      return {
        record: name,
        kind: 'trajectory',
        expected: expected[index],
        observed: state,
        detail: `${name} reached ${state} at step ${index + 1} where the brief expects ${expected[index]}: ${observed.join(' -> ')}`,
      };
  }
  return null;
}

/** Verdicts are asserted after the fact; nothing here is ever sent to a reviewer. */
export function matchVerdicts(
  name: string,
  expected: ReviewExpectation[],
  observed: { verdict: string; returnTo?: string }[],
): Divergence | null {
  for (const [index, actual] of observed.entries()) {
    const round = expected[index];
    if (!round)
      return {
        record: name,
        kind: 'verdict',
        expected: 'no further review round',
        observed: actual.verdict,
        detail: `${name} ran review round ${index + 1}, which the brief does not expect`,
      };
    if (round.verdict !== actual.verdict)
      return {
        record: name,
        kind: 'verdict',
        expected: round.verdict,
        observed: actual.verdict,
        detail: `${name} review round ${index + 1} returned ${actual.verdict}; the brief expects ${round.verdict}. A reviewer that does not deliver a scripted verdict is a finding about the gate, not a harness failure.`,
      };
    if (round.returnTo && round.returnTo !== actual.returnTo)
      return {
        record: name,
        kind: 'verdict',
        expected: round.returnTo,
        observed: actual.returnTo ?? 'none',
        detail: `${name} review round ${index + 1} returned to ${actual.returnTo ?? 'none'}; the brief expects ${round.returnTo}`,
      };
  }
  return null;
}

/**
 * Stages this harness must launch itself rather than leaving to the runner: the ones
 * that need network, and the ones carrying a planted defect. The runner builds its
 * child's stdin from the frozen assignment alone and has no per-assignment prompt
 * hook, so a defect has nowhere else to travel.
 */
export const harnessStages = (record: RecordBrief): Set<string> =>
  new Set([
    ...(record.networkStages ?? []),
    ...(record.defects ?? []).map((defect) => defectState(record.kind, defect.stage)),
  ]);

/**
 * States where dispatch must be paused so the runner cannot take a lease this harness
 * owns, mapped to whether the state is the harness stage itself. A predecessor state
 * only pauses once its own work is already leased, so the runner still carries that
 * offline stage; a harness stage that is also the record's first state pauses at once.
 */
export function pauseStates(record: RecordBrief): Map<string, 'harness' | 'predecessor'> {
  const owned = harnessStages(record);
  const states = new Map<string, 'harness' | 'predecessor'>();
  for (const [index, state] of record.trajectory.entries()) {
    if (!owned.has(state)) continue;
    states.set(state, 'harness');
    const previous = record.trajectory[index - 1];
    if (index > 0 && !owned.has(previous) && !states.has(previous))
      states.set(previous, 'predecessor');
  }
  return states;
}

// ---------------------------------------------------------------------------
// Everything below runs only when this file is executed directly.
// ---------------------------------------------------------------------------

interface Options {
  brief: string;
  out: string;
  baseUrl?: string;
  project?: string;
  tokenEnv: string;
  local: boolean;
  only?: string[];
  stopAfter?: string;
  maxRounds?: number;
  timeoutMinutes: number;
  model?: string;
  effort?: string;
  sandboxesUrl?: string;
  sandboxesTokenEnv?: string;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    assert.ok(arg.startsWith('--'), `Unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (name === 'local') flags.add(name);
    else {
      const value = argv[++index];
      assert.ok(value !== undefined && !value.startsWith('--'), `--${name} needs a value`);
      values.set(name, value);
    }
  }
  const brief = values.get('brief');
  const out = values.get('out');
  assert.ok(
    brief && out,
    'Usage: live-scenario.ts --brief <file> --out <dir> [--local | --base-url … --project … --token-env …]',
  );
  assert.ok(
    !values.has('token') && !values.has('key'),
    'A machine key is read from the environment only; there is no --token flag',
  );
  const local = flags.has('local');
  if (!local)
    assert.ok(
      values.get('base-url') && values.get('project'),
      '--base-url and --project are required without --local',
    );
  return {
    brief: resolve(brief),
    out: resolve(out),
    baseUrl: values.get('base-url'),
    project: values.get('project'),
    tokenEnv: values.get('token-env') ?? 'MERV_SCENARIO_TOKEN',
    local,
    only: values
      .get('only')
      ?.split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    stopAfter: values.get('stop-after'),
    ...(values.has('max-rounds') ? { maxRounds: Number(values.get('max-rounds')) } : {}),
    timeoutMinutes: Number(values.get('timeout-minutes') ?? 60),
    model: values.get('model'),
    effort: values.get('effort'),
    sandboxesUrl: values.get('sandboxes-url'),
    sandboxesTokenEnv: values.get('sandboxes-token-env'),
  };
}

interface Observed {
  brief: RecordBrief;
  id: string;
  states: string[];
  timings: { state: string; at: string; heldMs?: number }[];
  reviews: {
    reviewId: string;
    subjectRevision: number;
    verdict: string;
    returnTo?: string;
    synopsis: string | null;
    findings: unknown[];
    reviewerId: string | null;
    producerId: string;
  }[];
  launchedStages: string[];
  finished: boolean;
}

async function main(options: Options) {
  mkdirSync(options.out, { recursive: true, mode: 0o700 });
  const briefSource = readFileSync(options.brief, 'utf8');
  const brief = parseBrief(briefSource);
  const selected = options.only
    ? brief.records.filter((record) => options.only!.includes(record.name))
    : brief.records;
  assert.ok(selected.length, 'No brief records selected');
  for (const record of selected)
    for (const dependency of record.dependsOn ?? [])
      assert.ok(
        selected.some((entry) => entry.name === dependency),
        `--only omits ${dependency}, which ${record.name} depends on`,
      );

  const secrets: string[] = [];
  const redact = (value: string) =>
    secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  let app: { ctx: any; stop: () => Promise<void> } | undefined;
  let runner: MachineRunner | undefined;
  let baseUrl = options.baseUrl!;
  let projectId = options.project!;
  const previousToken = process.env[options.tokenEnv];
  const started = Date.now();
  const log = (entry: Record<string, unknown>) => console.log(redact(JSON.stringify(entry)));
  let divergence: Divergence | null = null;
  let failure: string | undefined;
  let harnessLaunches = 0;
  const observed = new Map<string, Observed>();
  const feedPosts: { role: string; postId: string; after?: string }[] = [];
  let cycleId: string | null = null;
  const claimIds = new Map<string, string>();

  try {
    if (options.local) {
      const { createApp } = await import('../src/app.js');
      app = await createApp({ directory: join(options.out, 'server'), api: true, port: 0 });
      const boot = await app!.ctx.scope.bootstrap({
        projectName: brief.project.name,
        actorName: 'Scenario operator',
      });
      secrets.push(boot.token);
      process.env[options.tokenEnv] = boot.token;
      baseUrl = app!.ctx.api.url!;
      projectId = boot.project.id;
      log({ local: true, baseUrl, projectId });
    }
    const token = process.env[options.tokenEnv];
    assert.ok(
      token,
      `No credential in ${options.tokenEnv}. Export the project-scoped machine key into that variable; this harness never reads a key from a flag or a file.`,
    );
    if (!options.local) secrets.push(token);

    // Every write carries a request id and replays identically, so a request that
    // never reached the server (a reset connection, a DNS blip) is retried a few times.
    const send = async (path: string, init: RequestInit, attempt = 1): Promise<Response> => {
      const again = async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** (attempt - 1)));
        return await send(path, init, attempt + 1);
      };
      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, init);
      } catch (error) {
        if (attempt >= 4 || !(error instanceof TypeError)) throw error;
        return await again();
      }
      // A 5xx (a database timeout under load, a gateway hiccup) is retried the same way.
      return response.status >= 500 && attempt < 4 ? await again() : response;
    };
    const request = async (path: string, body: unknown, method = 'POST'): Promise<any> => {
      const response = await send(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-merv-project-id': projectId,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      });
      const value = await response.json().catch(() => ({}));
      assert.equal(
        response.status,
        200,
        `${method} ${path} failed with ${response.status}: ${redact(JSON.stringify(value)).slice(0, 600)}`,
      );
      return value;
    };
    const call = async (tool: string, input: any): Promise<any> => {
      try {
        return (await request(`/tools/${tool}`, input)).result;
      } catch (error) {
        // A record an earlier run created from a brief edited since: reuse it by name.
        if (!(error instanceof Error) || !error.message.includes('request_conflict')) throw error;
        const existing: Record<string, () => Promise<any>> = {
          'task.create': async () => {
            const found = (await call('task.list', {})).find((t: any) => t.title === input.title);
            return found && (await call('task.get', { taskId: found.id }));
          },
          'experiment.create': async () => {
            const found = (await call('experiment.list', {})).find(
              (e: any) => e.name === input.name,
            );
            return (
              found && {
                ...found,
                ...(await call('experiment.get_state', { experimentId: found.id })),
              }
            );
          },
          'claim.create': async () =>
            (await call('claim.list', {})).find((c: any) => c.statement === input.statement),
        };
        const found = existing[tool] ? await existing[tool]() : undefined;
        assert.ok(found, `${tool} replayed with different input and no existing record matched`);
        log({ tool, reused: found.id });
        return found;
      }
    };
    const control = async (path: string, body: unknown, method = 'POST') =>
      await request(path, body, method);

    // ---- Setup: introduction, claims, records, cycle. All over /tools/*. ----
    const project = await call('project.get', {});
    if (project.summary !== brief.project.introduction)
      await call('project.context.update', {
        summary: brief.project.introduction,
        expectedSummary: project.summary ?? '',
        requestId: `scenario:${brief.project.name}:introduction`,
      });
    for (const claim of brief.claims) {
      const created = await call('claim.create', {
        statement: claim.statement,
        ...(claim.scope ? { scope: claim.scope } : {}),
        ...(claim.confidence ? { confidence: claim.confidence } : {}),
        requestId: `scenario:claim:${claim.key}`,
      });
      claimIds.set(claim.key, created.id);
      log({ claim: claim.key, id: created.id });
    }
    for (const record of creationOrder(selected)) {
      const dependsOn = (record.dependsOn ?? []).map((name) => observed.get(name)!.id);
      const created =
        record.kind === 'task'
          ? await call('task.create', {
              title: record.title,
              goal: record.goal,
              checks: record.checks,
              ...(dependsOn.length ? { dependsOn } : {}),
              requestId: `scenario:task:${record.name}`,
            })
          : await call('experiment.create', {
              name: record.name,
              intent: record.intent,
              details: record.details ?? '',
              testedClaimIds: (record.testedClaims ?? [])
                .map((key) => claimIds.get(key))
                .filter((id): id is string => !!id),
              ...(dependsOn.length ? { dependsOn } : {}),
              requestId: `scenario:experiment:${record.name}`,
            });
      observed.set(record.name, {
        brief: record,
        id: created.id,
        states: [created.workflow.state],
        timings: [{ state: created.workflow.state, at: new Date().toISOString() }],
        reviews: [],
        launchedStages: [],
        finished: false,
      });
      log({ [record.kind]: record.name, id: created.id, state: created.workflow.state });
    }
    if (brief.project.cycle && !options.only) {
      const cycle = await call('research.create', {
        name: brief.project.cycle.name,
        dependsOn: (brief.project.cycle.dependsOn ?? [])
          .map((name) => observed.get(name)?.id)
          .filter((id): id is string => !!id),
        consolidationWorkspace: brief.project.cycle.consolidationWorkspace ?? 'none',
        requestId: `scenario:cycle:${brief.project.cycle.name.replace(/[^A-Za-z0-9_.:-]+/g, '-')}`,
      });
      cycleId = cycle.id;
      log({ cycle: cycle.id });
    }

    // ---- The runner carries every offline stage. ----
    runner = new MachineRunner({
      directory: join(options.out, 'machine'),
      baseUrl,
      projectId,
      credentialEnv: options.tokenEnv,
      capacity: 2,
      pollIntervalMs: 3000,
      profiles: [
        {
          name: 'scenario-codex',
          harness: 'codex',
          executable: process.env.MERV_CODEX_BIN ?? 'codex',
          enabled: true,
          parallelism: 2,
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
        },
      ],
    });
    await runner.start();

    const read = async (entry: Observed) =>
      entry.brief.kind === 'task'
        ? await call('task.get', { taskId: entry.id })
        : await call('experiment.get_state', { experimentId: entry.id });
    const pauses = new Map(selected.map((record) => [record.name, pauseStates(record)]));
    const recordRevision = new Map<string, number>();
    const terminalState = (entry: Observed) => options.stopAfter ?? entry.brief.trajectory.at(-1)!;
    const TERMINAL = new Set(['done', 'complete', 'failed', 'abandoned', 'cancelled']);
    let divergenceLogged = false;
    let dispatch: boolean | undefined;
    const setDispatch = async (enabled: boolean) => {
      if (dispatch === enabled) return;
      await control('/sessions/dispatch', { enabled }, 'PUT');
      dispatch = enabled;
      log({ dispatch: enabled });
    };

    const deadline = started + options.timeoutMinutes * 60_000;
    let lastLine = '';
    for (;;) {
      for (const entry of observed.values()) {
        if (entry.finished) continue;
        const current = await read(entry);
        const state = current.workflow.state;
        recordRevision.set(entry.brief.name, current.workflow.revision);
        if (entry.states.at(-1) !== state) {
          const now = Date.now();
          const previous = entry.timings.at(-1)!;
          previous.heldMs = now - Date.parse(previous.at);
          entry.states.push(state);
          entry.timings.push({ state, at: new Date(now).toISOString() });
          log({ record: entry.brief.name, state, revision: current.workflow.revision });
          divergence ??= matchTrajectory(entry.brief.name, entry.brief.trajectory, entry.states);
        }
        // --max-rounds stops a record after that many verdicts: "design round only".
        if (
          state === terminalState(entry) ||
          TERMINAL.has(state) ||
          (options.maxRounds !== undefined && entry.reviews.length >= options.maxRounds)
        )
          entry.finished = true;
      }

      // Collect every submitted verdict for these records and check it. This runs even
      // on a diverging tick: a returned record's synopsis and findings are the whole
      // diagnosis, and the verdict lands in the same transaction as the state change.
      const reviews: any[] = await call('review.list', {});
      for (const entry of observed.values()) {
        const mine = reviews
          .filter((review) => review.subjectId === entry.id && review.verdict)
          .sort((a, b) => a.subjectRevision - b.subjectRevision);
        if (mine.length === entry.reviews.length) continue;
        for (const review of mine.slice(entry.reviews.length)) {
          const full = await call('review.get', { reviewId: review.id });
          entry.reviews.push({
            reviewId: full.id,
            subjectRevision: full.subjectRevision,
            verdict: full.verdict,
            ...(full.returnTo ? { returnTo: full.returnTo } : {}),
            synopsis: full.synopsis,
            findings: full.findings,
            reviewerId: full.reviewerId,
            producerId: full.producerId,
          });
          log({
            record: entry.brief.name,
            review: full.id,
            round: entry.reviews.length,
            verdict: full.verdict,
            returnTo: full.returnTo ?? null,
          });
        }
        if (entry.brief.reviewRounds)
          divergence ??= matchVerdicts(entry.brief.name, entry.brief.reviewRounds, entry.reviews);
      }
      // A divergence is a finding, not a stop: the run keeps driving every record to a
      // terminal state (or --max-rounds), and the report carries the first divergence.
      if (divergence && !divergenceLogged) {
        log({ divergence: divergence.detail });
        divergenceLogged = true;
      }

      // Pause dispatch before a live record can step into a network stage. A predecessor
      // state only pauses once its own offline work is already leased, so the runner
      // still carries that stage and only the execution lease is reserved for us.
      const status = await control('/sessions/status', undefined, 'GET');
      const leased = new Set(
        (status.sessions ?? [])
          .filter((session: any) => ['offered', 'active'].includes(session.status))
          .map((session: any) => `${session.instanceId}:${session.expectedRevision}`),
      );
      const blocking = [...observed.values()].filter((entry) => {
        if (entry.finished) return false;
        const kind = pauses.get(entry.brief.name)!.get(entry.states.at(-1)!);
        if (!kind) return false;
        if (kind === 'harness') return true;
        const record = recordRevision.get(entry.brief.name);
        return record === undefined || leased.has(`${entry.id}:${record}`);
      });
      await setDispatch(blocking.length === 0);

      for (const entry of blocking) {
        const state = entry.states.at(-1)!;
        if (pauses.get(entry.brief.name)!.get(state) !== 'harness') continue;
        // The producing round: how many times the record has entered this state, read
        // from the server's process graph so a restarted harness never repeats round 1
        // (and its planted defect) on what is really round 2.
        const graph = await call('workflow.process', { instanceId: entry.id });
        const node = graph.nodes?.find((n: any) => n.state === state);
        const round = node
          ? node.entries + (node.initial ? 1 : 0)
          : entry.states.filter((seen) => seen === state).length;
        const stage = `${state}@${round}`;
        if (entry.launchedStages.includes(stage)) continue;
        entry.launchedStages.push(stage);
        harnessLaunches++;
        await launchHarnessStage(entry, state, round);
      }

      if ([...observed.values()].every((entry) => entry.finished)) break;
      const snapshot = runner.snapshot();
      const line = JSON.stringify({
        runner: snapshot.state,
        error: snapshot.lastError,
        launches: snapshot.launches.map(({ id, status }) => ({ id, status })),
      });
      if (line !== lastLine) {
        log(JSON.parse(line));
        lastLine = line;
      }
      assert.ok(Date.now() < deadline, `Scenario run exceeded ${options.timeoutMinutes} minutes`);
      await delay(2000);
    }
    await setDispatch(false);

    // ---- Feed: the brief's entries, posted by the source credential. ----
    if (!divergence)
      for (const [index, post] of brief.feed.entries()) {
        if (post.after && !observed.get(post.after.split(':')[0])?.finished) continue;
        const created = await call('feed.post', {
          body: `[${post.role}] ${post.body}`,
          requestId: `scenario:feed:${index}`,
        });
        feedPosts.push({
          role: post.role,
          postId: created.id,
          ...(post.after ? { after: post.after } : {}),
        });
      }

    async function launchHarnessStage(entry: Observed, state: string, round: number) {
      const current = await read(entry);
      const revision = current.workflow.revision;
      const network = (entry.brief.networkStages ?? []).includes(state);
      const defect = (entry.brief.defects ?? []).find(
        (candidate) =>
          defectState(entry.brief.kind, candidate.stage) === state && candidate.round === round,
      )?.text;
      // The dispatch pause normally keeps this assignment free. If the runner won the
      // race anyway, close its lease before taking our own: this stage needs network,
      // a planted defect in its stdin, or both, and the runner can supply neither.
      const status = await control('/sessions/status', undefined, 'GET');
      for (const session of status.sessions ?? [])
        if (
          session.instanceId === entry.id &&
          session.expectedRevision === revision &&
          ['offered', 'active'].includes(session.status) &&
          session.runnerRef !== 'live-scenario'
        ) {
          await control(`/sessions/${encodeURIComponent(session.id)}/halt`, {
            reason: 'this stage is launched by the scenario harness',
          });
          log({ record: entry.brief.name, state, haltedRunnerLease: session.id });
        }
      const secret = `ms_${randomBytes(32).toString('base64url')}`;
      secrets.push(secret);
      // The offer carries a fresh secret, so a rerun after a failed launch must not
      // replay an earlier run's request id: each harness process has its own run id.
      const requestId = `scenario:${entry.brief.name}:${state}:${revision}:${RUN_ID}`;
      const { session } = await control('/sessions/offer', {
        instanceId: entry.id,
        expectedRevision: revision,
        runnerId: 'live-scenario',
        requestId,
        secret,
      });
      assert.ok(session, `No lease offered for ${entry.brief.name} at ${state}`);
      // The defect text itself never reaches the report or the log: only that one was used.
      log({ record: entry.brief.name, state, round, lease: session.id, network, defect: !!defect });
      const workspace = join(options.out, 'workspaces', `${entry.brief.name}-${state}-${round}`);
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const exitCode = await spawnCodex(
        entry,
        `${state}-${round}`,
        session,
        secret,
        workspace,
        network,
        defect,
      );
      log({ record: entry.brief.name, state, round, exitCode });
      assert.equal(exitCode, 0, `Harness-launched Codex for ${entry.brief.name}/${state} failed`);
    }

    async function spawnCodex(
      entry: Observed,
      stage: string,
      session: any,
      secret: string,
      workspace: string,
      network: boolean,
      defect: string | undefined,
    ): Promise<number> {
      const tools = [...new Set<string>(session.execution.policy.tools.map((t: any) => t.name))];
      const quote = (value: string) => JSON.stringify(value);
      const childEnv: NodeJS.ProcessEnv = { MERV_AGENT_SESSION_TOKEN: secret };
      const shellEnvironment: Record<string, string> = {};
      for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL'])
        if (process.env[key] !== undefined) shellEnvironment[key] = process.env[key]!;
      for (const [key, value] of Object.entries(shellEnvironment)) childEnv[key] = value;
      if (process.env.CODEX_HOME !== undefined) childEnv.CODEX_HOME = process.env.CODEX_HOME;
      if (network && options.sandboxesTokenEnv) {
        const grant = process.env[options.sandboxesTokenEnv];
        assert.ok(grant, `No sandboxes grant in ${options.sandboxesTokenEnv}`);
        childEnv[options.sandboxesTokenEnv] = grant;
        if (!secrets.includes(grant)) secrets.push(grant);
      }
      const args = [
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        session.execution.policy.readOnly ? 'read-only' : 'workspace-write',
        '--json',
        '--color',
        'never',
        '-C',
        workspace,
        '-c',
        'approval_policy="never"',
        // The same isolation the runner's Codex profile applies: no account
        // integrations, hooks, sub-agents or host skills widen this lease.
        ...[
          'apps',
          'plugins',
          'hooks',
          'remote_plugin',
          'multi_agent',
          'multi_agent_v2',
          'shell_snapshot',
          'tool_suggest',
          'skill_search',
          'skill_mcp_dependency_install',
          'browser_use',
          'browser_use_external',
          'computer_use',
          'image_generation',
          'in_app_local_automation',
        ].flatMap((feature) => ['-c', `features.${feature}=false`]),
        '-c',
        'features.skip_host_skill_discovery=true',
        '-c',
        'features.shell_tool=true',
        '-c',
        'web_search="disabled"',
        '-c',
        'project_doc_max_bytes=0',
        '-c',
        'allow_login_shell=false',
        // MCP authentication reads the host process environment. The bearer is
        // deliberately absent from the environment model-generated shell commands see.
        '-c',
        'shell_environment_policy.inherit="none"',
        '-c',
        'shell_environment_policy.ignore_default_excludes=false',
        '-c',
        `shell_environment_policy.set={${Object.entries(shellEnvironment)
          .map(([key, value]) => `${quote(key)}=${quote(value)}`)
          .join(',')}}`,
        '-c',
        'sandbox_workspace_write.writable_roots=[]',
        // The execution stage is the one place a worker needs the network: datasets,
        // hosted models and a rented machine all live outside this process.
        '-c',
        `sandbox_workspace_write.network_access=${network}`,
        '-c',
        `mcp_servers.merv.url=${quote(`${baseUrl}/mcp`)}`,
        '-c',
        // One handshake timed out at 30 s while another lease was uploading evidence.
        'mcp_servers.merv.startup_timeout_sec=120',
        '-c',
        'mcp_servers.merv.bearer_token_env_var="MERV_AGENT_SESSION_TOKEN"',
        '-c',
        'mcp_servers.merv.required=true',
        '-c',
        `mcp_servers.merv.enabled_tools=${JSON.stringify(tools)}`,
        '-c',
        `mcp_servers.merv.tools={${tools.map((name) => `${quote(name)}={approval_mode="approve"}`).join(',')}}`,
        // Merv exposes only sandbox.extend and sandbox.release, so compute is driven
        // beside it. A network stage may reach the sandboxes service's own MCP; its
        // grant travels as an environment variable name, never as an argument.
        ...(network && options.sandboxesUrl && options.sandboxesTokenEnv
          ? [
              '-c',
              `mcp_servers.sandboxes.url=${quote(options.sandboxesUrl)}`,
              '-c',
              `mcp_servers.sandboxes.bearer_token_env_var=${quote(options.sandboxesTokenEnv)}`,
              '-c',
              'mcp_servers.sandboxes.required=true',
              // The lease runs with approval_policy never, and Codex prompts for MCP tools
              // by default; the namespace's spend cap is the guard, so its tools are approved.
              '-c',
              'mcp_servers.sandboxes.default_tools_approval_mode="approve"',
              '-c',
              'mcp_servers.sandboxes.startup_timeout_sec=120',
            ]
          : []),
        ...(options.model ? ['--model', options.model] : []),
        ...(options.effort ? ['-c', `model_reasoning_effort=${quote(options.effort)}`] : []),
        '-',
      ];
      const child = spawn(process.env.MERV_CODEX_BIN ?? 'codex', args, {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stem = join(options.out, 'launches', `${entry.brief.name}-${stage}`);
      mkdirSync(join(options.out, 'launches'), { recursive: true, mode: 0o700 });
      const chunks: string[] = [];
      const errors: string[] = [];
      // A child that dies before reading its prompt must surface as an exit code,
      // not as an unhandled EPIPE that takes the whole run down.
      child.stdin.on('error', (error) => errors.push(`stdin: ${error.message}\n`));
      child.stdout.on('data', (chunk) => chunks.push(chunk.toString()));
      child.stderr.on('data', (chunk) => errors.push(chunk.toString()));
      child.stdin.end(
        [
          'You are the worker for one Merv workflow step. The assignment below is frozen for this lease.',
          'Use the Merv MCP tools to inspect the assigned work, perform it, and follow its handoff instruction.',
          network
            ? 'This stage has network access: acquire the data and compute the assignment names, outside Merv, and bring the evidence back as artifacts.'
            : 'This stage has no network. Do the work the assignment describes with what it gives you.',
          'Tool arguments are constrained by the server. Stop when the handoff completes.',
          defect ? `Additional instructions for this launch only:\n${defect}` : '',
          'Frozen assignment:',
          JSON.stringify(session.assignment),
          '',
        ].join('\n'),
      );
      const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMinutes * 60_000);
      try {
        return await new Promise<number>((done, fail) => {
          child.once('error', fail);
          child.once('close', (code) => done(code ?? -1));
        });
      } finally {
        clearTimeout(timer);
        writeFileSync(`${stem}.jsonl`, redact(chunks.join('')), { mode: 0o600 });
        writeFileSync(`${stem}.stderr.log`, redact(errors.join('')), { mode: 0o600 });
      }
    }
  } catch (error) {
    // A thrown error is part of the record too: the report must never claim a pass.
    failure = redact(String((error as Error)?.stack ?? error));
    log({ failed: (error as Error)?.message ?? String(error) });
  } finally {
    const snapshot: RunnerSnapshot | undefined = runner?.snapshot();
    try {
      if (runner) await runner.stop();
    } catch (error) {
      log({ cleanup: 'runner', error: String((error as Error).message) });
    }
    try {
      await app?.stop();
    } catch (error) {
      log({ cleanup: 'server', error: String((error as Error).message) });
    }
    if (previousToken === undefined) delete process.env[options.tokenEnv];
    else process.env[options.tokenEnv] = previousToken;

    const runnerLaunches = snapshot?.launches.length ?? 0;
    const report = {
      passed: !divergence && !failure,
      divergence,
      ...(failure ? { failure } : {}),
      brief: {
        path: options.brief,
        sha256: createHash('sha256').update(briefSource).digest('hex'),
      },
      project: { id: projectId, name: brief.project.name, cycleId },
      baseUrl: options.local ? 'local in-process server' : baseUrl,
      selected: selected.map((record) => record.name),
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      claims: [...claimIds].map(([key, id]) => ({ key, id })),
      records: [...observed.values()].map((entry) => ({
        kind: entry.brief.kind,
        name: entry.brief.name,
        id: entry.id,
        expectedTrajectory: entry.brief.trajectory,
        observedTrajectory: entry.states,
        timings: entry.timings,
        reviews: entry.reviews,
        harnessLaunchedStages: entry.launchedStages,
        finished: entry.finished,
      })),
      feedPosts,
      feedRoleSubstituted: feedPosts.length > 0,
      codexExecutions: {
        runnerDispatched: runnerLaunches,
        harnessLaunched: harnessLaunches,
        total: runnerLaunches + harnessLaunches,
      },
      runner: snapshot,
      limits: [
        'Trajectories and verdicts are asserted after the fact; no verdict text reaches any worker.',
        'A stage carrying a planted defect is launched by this harness, not the runner: the runner builds its child stdin from the frozen assignment and has no per-assignment prompt hook.',
        'The production feed has no voices: each brief post is written by the source credential with its named role as a body prefix.',
        'Reflection, consolidation and post-wave claim updates are outside this harness slice.',
        brief.limits,
      ].filter(Boolean),
    };
    const encoded = JSON.stringify(report, null, 2);
    assert.ok(
      secrets.every((secret) => !encoded.includes(secret)) &&
        !/m[sk]_[A-Za-z0-9_-]{32,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(encoded),
      'Refusing to write a report containing a credential',
    );
    writeFileSync(join(options.out, 'report.json'), encoded + '\n', { mode: 0o600 });
    writeFileSync(join(options.out, 'report.md'), markdownReport(report), { mode: 0o600 });
    console.log(
      JSON.stringify({
        passed: report.passed,
        divergence: divergence?.detail ?? null,
        failure: failure ? failure.split('\n')[0] : null,
        codexExecutions: report.codexExecutions.total,
        report: join(options.out, 'report.json'),
      }),
    );
    if (!report.passed) process.exitCode = 1;
  }
}

function markdownReport(report: any): string {
  const lines = [
    `# Scenario run — ${report.project.name}`,
    '',
    `- Result: **${report.passed ? 'trajectory held' : report.divergence ? 'DIVERGED' : 'FAILED'}**`,
    `- Brief: \`${report.brief.path}\` (sha256 \`${report.brief.sha256.slice(0, 16)}…\`)`,
    `- Project: \`${report.project.id}\`${report.project.cycleId ? `, cycle \`${report.project.cycleId}\`` : ''}`,
    `- Server: ${report.baseUrl}`,
    `- Ran ${report.startedAt} → ${report.finishedAt} (${Math.round(report.durationMs / 1000)} s)`,
    `- Codex executions: ${report.codexExecutions.total} (${report.codexExecutions.runnerDispatched} runner-dispatched, ${report.codexExecutions.harnessLaunched} harness-leased)`,
    '',
  ];
  if (report.failure)
    lines.push(
      '## Failure',
      '',
      '```',
      report.failure.split('\n').slice(0, 12).join('\n'),
      '```',
      '',
    );
  if (report.divergence)
    lines.push(
      '## Divergence',
      '',
      `**${report.divergence.kind}** on \`${report.divergence.record}\`: expected \`${report.divergence.expected}\`, observed \`${report.divergence.observed}\`.`,
      '',
      report.divergence.detail,
      '',
    );
  if (report.claims.length)
    lines.push(
      '## Claims',
      '',
      ...report.claims.map((claim: any) => `- ${claim.key} → \`${claim.id}\``),
      '',
    );
  for (const record of report.records) {
    lines.push(
      `## ${record.kind} \`${record.name}\` — \`${record.id}\``,
      '',
      `Expected: ${record.expectedTrajectory.join(' → ')}`,
      `Observed: ${record.observedTrajectory.join(' → ')}`,
      '',
      '| state | entered | held |',
      '| --- | --- | --- |',
      ...record.timings.map(
        (timing: any) =>
          `| ${timing.state} | ${timing.at} | ${timing.heldMs ? `${Math.round(timing.heldMs / 1000)} s` : '—'} |`,
      ),
      '',
    );
    if (record.reviews.length) {
      lines.push('### Review rounds', '');
      for (const [index, review] of record.reviews.entries()) {
        lines.push(
          `**Round ${index + 1}** (revision ${review.subjectRevision}) — verdict \`${review.verdict}\`${review.returnTo ? `, returnTo \`${review.returnTo}\`` : ''}`,
          '',
          review.synopsis ? `> ${review.synopsis}` : '> (no synopsis)',
          '',
          ...review.findings.map(
            (finding: any) =>
              `- criterion ${finding.criterionNumber}: \`${finding.status}\` — ${String(
                finding.notes ?? '',
              )
                .replace(/\s+/g, ' ')
                .slice(0, 400)}`,
          ),
          '',
        );
      }
    }
  }
  if (report.feedPosts.length)
    lines.push(
      '## Feed',
      '',
      ...report.feedPosts.map((post: any) => `- ${post.role} → \`${post.postId}\``),
      '',
    );
  lines.push('## Limits', '', ...report.limits.flatMap((limit: string) => [limit, '']));
  return lines.join('\n');
}

// Exports above are importable by tests; the run only starts on direct invocation.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main(parseArgs(process.argv.slice(2)));
