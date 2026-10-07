import type { TaskDelivery } from '@merv/tasks/types';
import { currentTask, currentWork } from '../tests/fixtures/current-work.js';
import { currentExperiment } from '../tests/fixtures/current-experiment.js';
import { join } from 'node:path';
import type { Caller } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import type { AgentEvent } from '@merv/sessions/agent-stream';

/**
 * What the Running page draws, seeded in the demo server's own process: work in every state a
 * card can be in, two machines with agents on them, and the calls those agents make.
 * Current Git work uses real leased checkouts, commits and final captures. Machines report
 * themselves on the runner heartbeat route, producers and reviewers use scoped services, and each agent
 * calls the MCP endpoint with the credential it was registered with, so every call it makes
 * is admitted and observed the way a real one is.
 *
 * It runs after every other seed because the reflection wave it opens last pauses new tasks
 * and experiments. What it does NOT make is a GPU run: compute is granted only to a project a
 * signed-in person created, and this demo bootstraps its project.
 */

/** A tool call over HTTP with one bearer token, answering the result or throwing the error. */
type Tool = (name: string, input?: Record<string, unknown>) => Promise<any>;
interface App {
  ctx: any;
}
/** A machine as its runner reports itself; the hostname is what a lease's line says it runs on. */
export interface DemoMachine {
  runnerId: string;
  machine: { hostname: string; system: string; architecture: string };
  platforms: {
    name: string;
    harness: string;
    model?: string;
    effort?: string;
    enabled: boolean;
    parallelism: number;
  }[];
  capacity: number;
  capabilities?: string[];
}
/** One read an agent makes between beats: a tool and its input. */
type Read = [tool: string, input: Record<string, unknown>];
/** A lease the demo keeps alive, and the reads its agent makes in turn between beats. */
export interface DemoLease {
  sessionId: string;
  runnerId: string;
  reads?: Read[];
  /** The agent's own tool route; a lease without one only renews and so goes quiet. */
  call?: Tool;
  /** What its agent says and does on its live stream, sent by its runner a piece at a time. */
  says?: Said;
}
/** One step of what an agent says (`text`, sent word by word) or does (a tool and its answer). */
type Step = string | [tool: string, input: Record<string, unknown>, answer: string];
interface Said {
  control: { runnerId: string; hostRef: string };
  steps: Step[];
  /** Where its runner is: the step, the word within a text, the log bytes sent and the round. */
  at: number;
  word: number;
  bytes: number;
  round: number;
}

/** The desk machine the demo's agents were always registered on, and a lab machine beside it. */
const studio: DemoMachine = {
  runnerId: 'local-demo',
  machine: { hostname: 'mac-studio', system: 'darwin', architecture: 'arm64' },
  platforms: [
    {
      name: 'claude',
      harness: 'claude',
      model: 'opus-5.5',
      effort: 'high',
      enabled: true,
      parallelism: 4,
    },
  ],
  capacity: 4,
  capabilities: ['code.v2'],
};
const lab: DemoMachine = {
  runnerId: 'lab-gpu-01',
  machine: { hostname: 'lab-gpu-01', system: 'linux', architecture: 'x86_64' },
  platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 4 }],
  capacity: 4,
  capabilities: ['code.v2'],
};

/** What a person asked for, as a text brief that carries the goal and every check. */
const briefOf = (title: string, goal: string, checks: string[], notes: string[] = []) => ({
  title: `Brief: ${title.toLowerCase()}`,
  content: [
    '# Goal',
    goal,
    ...(notes.length ? ['', ...notes] : []),
    '',
    '# Done when',
    ...checks.map((check, index) => `${index + 1}. ${check}`),
  ].join('\n'),
  mediaType: 'text/markdown',
});

/**
 * A leased agent's tool route. Its lease credential opens only the stateless MCP endpoint, so
 * each call is one JSON-RPC request there, answered with the tool's result or its error.
 */
export function mcp(url: string, token: string): Tool {
  let id = 0;
  return async (name, input = {}) => {
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/call',
        params: { name, arguments: input },
      }),
    });
    const body = (await response.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
      error?: { message: string };
    };
    if (body.error) throw new Error(`${name}: ${body.error.message}`);
    const text = body.result?.content?.[0]?.text ?? 'null';
    if (body.result?.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };
}

/** A runner's own request, made with the key it was registered under. */
async function post(url: string, token: string, path: string, body: unknown): Promise<void> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
}

/**
 * Seed the Running page's work, machines and agents. `sweep` is the lease the demo already
 * holds on the weight-decay sweep, adopted so its agent keeps calling as the others do.
 */
export async function seedRunning(
  app: App,
  input: {
    url: string;
    directory: string;
    owner: Caller;
    /** The operator's own token: a runner authenticates with the key it was registered under. */
    token: string;
    producer: Tool;
    producerCaller: Caller;
    reviewer: Tool;
    offerTo: (
      record: { id: string; workflow: { revision: number } },
      requestId: string,
      runnerId?: string,
    ) => Promise<{ session: Session; token: string }>;
    sweep: DemoLease & { taskId: string };
  },
): Promise<{ machines: DemoMachine[]; leases: DemoLease[]; close(): Promise<void> }> {
  const { ctx } = app;
  const { url, owner, token, offerTo, sweep } = input;
  const p = input.producer;
  const r = input.reviewer;
  const work = currentWork(ctx, {
    directory: join(input.directory, 'running-workers'),
    source: owner,
  });
  const machines = [studio, lab];
  for (const machine of machines) await post(url, token, '/sessions/runners/heartbeat', machine);

  const leases: DemoLease[] = [sweep];
  /** An agent on a machine, taking one record, with the tool route its lease credential opens. */
  const agent = async (
    requestId: string,
    machine: DemoMachine,
    record: { id: string; workflow: { revision: number } },
  ) => {
    const joined = await offerTo(record, `${requestId}-assignment`, machine.runnerId);
    const { session } = joined;
    const held = await work.attach(session);
    const reads: Read[] = [['workflow.assignment', { instanceId: record.id }]];
    const lease: DemoLease & { threadId: string; reads: Read[]; call: Tool; held: typeof held } = {
      sessionId: session.id,
      threadId: session.threadId,
      runnerId: machine.runnerId,
      call: mcp(url, joined.token),
      reads,
      held,
    };
    leases.push(lease);
    return lease;
  };
  /** A task the producer asked for with a brief of its own, pinned at creation. */
  const task = async (
    title: string,
    goal: string,
    checks: string[],
    requestId: string,
    extra: Record<string, unknown> = {},
    notes: string[] = [],
  ) => {
    const brief = await p('artifact.create', briefOf(title, goal, checks, notes));
    return await currentTask(ctx, input.producerCaller, {
      title,
      goal,
      checks,
      briefId: brief.id,
      requestId,
      ...extra,
    });
  };
  /** A delivery that claims every check, submitted by the producer who did the work. */
  const deliver = async (created: any, title: string, lines: string[], requestId: string) => {
    const held = await work.lease(created, input.producerCaller);
    const content = lines.join('\n');
    const delivery = await work.run(
      held,
      'artifact.create',
      { title, content, mediaType: 'text/markdown' },
      (caller, input) => ctx.artifacts.create(caller, input),
    );
    const commandId = await work.commit(held, { 'demo-result.md': content });
    const submitted = await work.run(
      held,
      'task.submit_delivery',
      {
        taskId: created.id,
        commandId,
        artifactIds: [delivery.id],
        confirmations: created.checks.map((check: string, index: number) => ({
          checkNumber: index + 1,
          status: 'met',
          evidenceIds: [delivery.id],
          notes: `${delivery.title} records it: ${check.toLowerCase()}.`,
        })),
        expectedRevision: created.workflow.revision,
        requestId,
      },
      (caller, input) => ctx.tasks.submitDelivery(caller, input as unknown as TaskDelivery),
    );
    await work.release(held);
    return submitted;
  };

  // A task an agent on the lab machine is working on, and the record of how far it got.
  const clean = await task(
    'Clean the held-out split',
    'Remove the equations that leak between the training and held-out splits.',
    ['No held-out equation appears in training', 'Split sizes are recorded'],
    'demo-running-clean',
    {},
    ['Commuted pairs count as the same equation: a + b and b + a must land in one split.'],
  );
  const cleaner = await agent('demo-running-cleaner', lab, clean);
  cleaner.says = saying(cleaner.held.control, [
    'Reading the split manifests before I touch anything.',
    ['shell', { command: 'rg --files splits/' }, 'splits/train.jsonl\nsplits/held-out.jsonl'],
    'Commuted pairs: 412 held-out equations have their twin in training.',
    ['shell', { command: 'python scripts/dedupe_pairs.py --split held-out' }, 'moved 412'],
    'Held-out keeps 1,470 equations. Recording the split sizes next.',
    ['artifact.create', { title: 'Leak audit: held-out split' }, 'created'],
  ]);
  const audit = await cleaner.call('artifact.create', {
    title: 'Leak audit: held-out split',
    content: [
      '# Leak audit',
      '412 of 1,882 held-out equations had their commuted pair in training.',
      'They move to training; the held-out split keeps 1,470 equations.',
    ].join('\n'),
    mediaType: 'text/markdown',
  });
  cleaner.reads.push(
    ['task.get', { taskId: clean.id }],
    ['artifact.read', { artifactId: audit.id }],
  );

  // A task that waits on the sweep an agent is still running: a dashed card and its arrow.
  await task(
    'Draft the results section',
    'Write the results section from the weight-decay sweep.',
    ['Every setting reports its grokking step', 'Figure 2 is regenerated from the sweep'],
    'demo-running-draft',
    { dependsOn: [sweep.taskId] },
  );

  // A delivery an agent on the desk machine is reviewing, and one nobody has taken yet.
  const harness = await task(
    'Rebuild the evaluation harness',
    'Make the evaluation harness read the cleaned held-out split and report per-step accuracy.',
    ['The harness reads the cleaned split', 'Accuracy is reported every 100 steps'],
    'demo-running-harness',
  );
  const delivered = await deliver(
    harness,
    'Delivery: evaluation harness on the cleaned split',
    [
      '# Result',
      'eval.py now reads splits/held-out-clean.jsonl and logs accuracy every 100 steps.',
      '',
      '| step | held-out accuracy |',
      '|-----:|------------------:|',
      '| 100 | 0.01 |',
      '| 5000 | 0.12 |',
      '| 10000 | 0.97 |',
    ],
    'demo-running-harness-delivery',
  );
  const reviewing = await agent('demo-running-reviewer', studio, {
    id: harness.id,
    workflow: delivered.workflow,
  });
  reviewing.says = saying(reviewing.held.control, [
    'Reading the delivery and its accuracy table.',
    ['review.get', { reviewId: delivered.reviewId }, 'in_progress'],
    'Accuracy is logged every 100 steps, as the second check asks.',
    ['shell', { command: 'python eval.py --split held-out-clean --dry-run' }, 'reads 1470 rows'],
    'The harness reads the cleaned split. Both checks look met so far.',
  ]);
  const review = await reviewing.call('review.get', { reviewId: delivered.reviewId });
  if (review.status === 'requested')
    await reviewing.call('review.start', { reviewId: delivered.reviewId });
  for (const artifactId of review.artifactIds)
    await reviewing.call('artifact.read', { artifactId });
  reviewing.reads.push(
    ['review.get', { reviewId: delivered.reviewId }],
    ['task.get', { taskId: harness.id }],
  );
  const seeds = await task(
    'Pin the evaluation seeds',
    'Record the five seeds every evaluation run uses, so reruns compare like with like.',
    ['Five seeds are listed', 'Every run names its seed'],
    'demo-running-seeds',
  );
  await deliver(
    seeds,
    'Delivery: pinned evaluation seeds',
    ['# Seeds', 'Runs use seeds 7, 11, 23, 42 and 101; each run log names its seed.'],
    'demo-running-seeds-delivery',
  );

  // A task whose agent read the owner's note, answered it, then stopped to ask a question:
  // its thread waits, dormant, until a message to it answers (the Agents tab's box).
  const modulus = await task(
    'Choose the held-out modulus',
    'Pick the prime modulus the held-out runs use, so the comparison with p = 97 stands.',
    ['The modulus is named with its reason'],
    'demo-running-modulus',
  );
  const asker = await agent('demo-running-asker', lab, modulus);
  await ctx.sessions.messaging.message(owner, {
    threadId: asker.threadId,
    body: 'Keep the training split exactly as in the p = 97 runs.',
    requestId: 'demo-running-modulus-note',
  });
  const [note] = await asker.call('session.messages');
  await asker.call('session.message.ack', {
    messageId: note.id,
    reply: 'Understood: the training split stays as it is.',
    requestId: 'demo-running-modulus-ack',
  });
  await asker.call('session.ask_owner', {
    question:
      'p = 113 or p = 127 for the held-out runs? 113 keeps the vocabulary close to 97; 127 tests a larger gap.',
  });
  leases.splice(leases.indexOf(asker), 1);
  await work.release(asker.held).catch(() => undefined);

  // An experiment whose design passed review and which an agent on the lab machine runs.
  const name = 'decay-sensitivity-p113';
  const intent = 'Does the grokking step move with weight decay at p = 113 as it does at p = 97?';
  const experiment = await currentExperiment(ctx, input.producerCaller, {
    name,
    intent,
    details: 'The same one-layer transformer and harness as the p = 97 reproduction.',
    requestId: 'demo-running-experiment',
  });
  const plan = await p('artifact.create', {
    title: `Plan: ${name}`,
    content: [
      '# Summary',
      intent,
      '',
      '# Objective and hypothesis',
      'The grokking step falls as weight decay grows, at p = 113 as at p = 97.',
      '',
      '# Evaluation',
      'One run per decay in {0.3, 1.0, 3.0}, reporting the step at which validation crosses 95%.',
    ].join('\n'),
    mediaType: 'text/markdown',
  });
  const feasibility = await p('artifact.create', {
    title: `Feasibility: ${name}`,
    content: JSON.stringify({
      formatVersion: 1,
      resources: [
        {
          kind: 'data',
          name: 'modular addition p=113',
          unit: 'examples',
          required: 12769,
          available: 12769,
          basis: 'The harness generates the whole table.',
        },
        {
          kind: 'compute',
          name: 'single GPU',
          unit: 'hours',
          required: 3,
          available: 8,
          basis: 'lab-gpu-01 reports eight idle hours.',
        },
      ],
      dependencies: [{ name: 'evaluation harness', present: true, basis: 'In this project.' }],
      blockers: [],
    }),
    mediaType: 'application/json',
  });
  const revision = async () =>
    (await p('experiment.get_state', { experimentId: experiment.id })).workflow.revision;
  for (const [role, artifact, path] of [
    ['plan', plan, 'plan.md'],
    ['feasibility', feasibility, 'feasibility.json'],
  ] as const)
    await p('experiment.attach', {
      experimentId: experiment.id,
      artifactId: artifact.id,
      role,
      path,
      attemptIndex: experiment.attempt.index,
      expectedRevision: await revision(),
      requestId: `demo-running-attach-${role}`,
    });
  await p('experiment.transition', {
    experimentId: experiment.id,
    transition: 'submit_design',
    expectedRevision: await revision(),
    requestId: 'demo-running-design',
  });
  const design = ((await r('review.list')) as any[]).find(
    (item) => item.subjectId === experiment.id && item.status !== 'submitted',
  );
  if (!design) throw new Error('The demo found no design review for its experiment');
  const claim = await r('review.start', { reviewId: design.id });
  const pinned = await r('review.get', { reviewId: design.id });
  await r('review.submit', {
    reviewId: design.id,
    claimId: claim.claimId ?? pinned.claimId,
    verdict: 'pass',
    synopsis: 'The design can answer its question on the stated resources.',
    findings: pinned.criteria.map((_: string, index: number) => ({
      criterionNumber: index + 1,
      status: 'met',
      evidenceIds: [...pinned.artifactIds],
      notes: 'Checked against the pinned plan and feasibility statement.',
    })),
    notes: 'Approving the design.',
    expectedRevision: pinned.subjectRevision,
    requestId: 'demo-running-design-verdict',
  });
  const running = await p('experiment.get_state', { experimentId: experiment.id });
  const runner = await agent('demo-running-p113', lab, running);
  runner.says = saying(runner.held.control, [
    ['shell', { command: 'tail -n 3 runs/p113/decay-0.3/log.txt' }, 'step 4200 train 1.00'],
    'Step 4,200: train accuracy 1.00, held-out 0.03. Not grokked yet.',
    ['shell', { command: 'nvidia-smi --query-gpu=utilization.gpu --format=csv' }, '97 %'],
    'GPU at 97%. The next checkpoint lands in about six minutes.',
  ]);
  await runner.call('experiment.get_state', { experimentId: experiment.id });
  await runner.call('artifact.read', { artifactId: plan.id });
  const log = await runner.call('artifact.create', {
    title: 'Run log: p = 113, decay 0.3',
    content: 'Step 4,000 of 20,000: train 1.00, validation 0.04. Decay 1.0 and 3.0 are queued.',
  });
  runner.reads.push(
    ['experiment.get_state', { experimentId: experiment.id }],
    ['artifact.read', { artifactId: log.id }],
  );

  // An experiment whose design review sent it back: it is designed again, the returned
  // design beside the reviewer's verdict.
  const warmup = await currentExperiment(ctx, input.producerCaller, {
    name: 'lr-warmup-ablation',
    intent: 'Does a 500-step learning-rate warmup move the grokking step at p = 97?',
    details: 'The p = 97 reproduction with and without warmup, three seeds each.',
    requestId: 'demo-running-warmup',
  });
  const warmupPlan = await p('artifact.create', {
    title: 'Plan: lr-warmup-ablation',
    content: [
      '# Summary',
      'Does a 500-step linear warmup move the grokking step at p = 97?',
      '',
      '```mermaid',
      'flowchart LR',
      '  D[p = 97 table] --> A[No warmup]',
      '  D --> B[500-step warmup]',
      '  A --> M[Grokking step]',
      '  B --> M',
      '  M --> X{Later by 10%?}',
      '```',
      '',
      '# Objective and hypothesis',
      'Warmup delays memorisation and so moves the grokking step later by at least 10%.',
      '',
      '# Evaluation',
      '| Arm | Warmup | Seeds |',
      '|---|---|---|',
      '| Control | none | 7, 11, 23 |',
      '| Warmup | 500 steps, linear | 7, 11, 23 |',
      '',
      '**Measure:** the step where validation accuracy crosses 95%.',
      '**Success:** every warmup seed groks at least 10% later than its control.',
      '**Budget:** 2 GPU-hours on lab-gpu-01.',
      '',
      '- Seed spread may swamp a 10% shift.',
    ].join('\n'),
    mediaType: 'text/markdown',
  });
  const warmupFeasibility = await p('artifact.create', {
    title: 'Feasibility: lr-warmup-ablation',
    content: JSON.stringify({
      formatVersion: 1,
      resources: [
        {
          kind: 'data',
          name: 'modular addition p=97',
          unit: 'examples',
          required: 9409,
          available: 9409,
          basis: 'The harness generates the whole table.',
        },
        {
          kind: 'compute',
          name: 'single GPU',
          unit: 'hours',
          required: 2,
          available: 8,
          basis: 'lab-gpu-01 reports eight idle hours.',
        },
      ],
      dependencies: [{ name: 'evaluation harness', present: true, basis: 'In this project.' }],
      blockers: [],
    }),
    mediaType: 'application/json',
  });
  const warmupRevision = async () =>
    (await p('experiment.get_state', { experimentId: warmup.id })).workflow.revision;
  for (const [role, artifact, path] of [
    ['plan', warmupPlan, 'plan.md'],
    ['feasibility', warmupFeasibility, 'feasibility.json'],
  ] as const)
    await p('experiment.attach', {
      experimentId: warmup.id,
      artifactId: artifact.id,
      role,
      path,
      attemptIndex: warmup.attempt.index,
      expectedRevision: await warmupRevision(),
      requestId: `demo-running-warmup-attach-${role}`,
    });
  await p('experiment.transition', {
    experimentId: warmup.id,
    transition: 'submit_design',
    expectedRevision: await warmupRevision(),
    requestId: 'demo-running-warmup-design',
  });
  const returned = ((await r('review.list')) as any[]).find(
    (item) => item.subjectId === warmup.id && item.status !== 'submitted',
  );
  if (!returned) throw new Error('The demo found no design review for its warmup experiment');
  const returning = await r('review.start', { reviewId: returned.id });
  const asked = await r('review.get', { reviewId: returned.id });
  await r('review.submit', {
    reviewId: returned.id,
    claimId: returning.claimId ?? asked.claimId,
    verdict: 'needs_changes',
    returnTo: 'planned',
    synopsis:
      'Three seeds cannot separate a 10% shift from seed noise; the plan needs a power estimate or more seeds.',
    findings: asked.criteria.map((_: string, index: number) => ({
      criterionNumber: index + 1,
      status: index === 1 ? 'not_met' : 'met',
      evidenceIds: [...asked.artifactIds],
      notes:
        index === 1
          ? 'Seed-to-seed spread at p = 97 is about 15% of the grokking step, larger than the effect sought.'
          : 'Checked against the pinned plan and feasibility statement.',
    })),
    notes: 'Returning the design for a power estimate.',
    expectedRevision: asked.subjectRevision,
    requestId: 'demo-running-warmup-verdict',
  });

  // An experiment that ran and passed both reviews: its report stands alone.
  const decay = await currentExperiment(ctx, input.producerCaller, {
    name: 'decay-sweep-p97',
    intent: 'Does the grokking step fall as weight decay grows at p = 97?',
    details: 'Three decays on the p = 97 reproduction, one seed each.',
    requestId: 'demo-running-decay',
  });
  const decayRevision = async () =>
    (await p('experiment.get_state', { experimentId: decay.id })).workflow.revision;
  const decayPlan = await p('artifact.create', {
    title: 'Plan: decay-sweep-p97',
    content: [
      '# Summary',
      'Does the grokking step fall as weight decay grows at p = 97?',
      '',
      '```mermaid',
      'flowchart LR',
      '  D[p = 97 table] --> A[decay 0.3]',
      '  D --> B[decay 1.0]',
      '  D --> C[decay 3.0]',
      '  A & B & C --> M[Grokking step]',
      '  M --> X{Falls with decay?}',
      '```',
      '',
      '# Objective and hypothesis',
      'Stronger weight decay makes the network grok sooner.',
      '',
      '# Evaluation',
      '| Arm | Weight decay |',
      '|---|---|',
      '| Low | 0.3 |',
      '| Mid | 1.0 |',
      '| High | 3.0 |',
      '',
      '**Measure:** the step where validation accuracy crosses 95%.',
      '**Success:** the step falls monotonically with decay.',
      '**Budget:** 3 GPU-hours.',
    ].join('\n'),
    mediaType: 'text/markdown',
  });
  const decayFeasibility = await p('artifact.create', {
    title: 'Feasibility: decay-sweep-p97',
    content: JSON.stringify({
      formatVersion: 1,
      resources: [
        {
          kind: 'data',
          name: 'modular addition p=97',
          unit: 'examples',
          required: 9409,
          available: 9409,
          basis: 'The harness generates the whole table.',
        },
        {
          kind: 'compute',
          name: 'single GPU',
          unit: 'hours',
          required: 3,
          available: 8,
          basis: 'lab-gpu-01 reports eight idle hours.',
        },
      ],
      dependencies: [{ name: 'evaluation harness', present: true, basis: 'In this project.' }],
      blockers: [],
    }),
    mediaType: 'application/json',
  });
  for (const [role, artifact, path] of [
    ['plan', decayPlan, 'plan.md'],
    ['feasibility', decayFeasibility, 'feasibility.json'],
  ] as const)
    await p('experiment.attach', {
      experimentId: decay.id,
      artifactId: artifact.id,
      role,
      path,
      attemptIndex: decay.attempt.index,
      expectedRevision: await decayRevision(),
      requestId: `demo-running-decay-attach-${role}`,
    });
  await p('experiment.transition', {
    experimentId: decay.id,
    transition: 'submit_design',
    expectedRevision: await decayRevision(),
    requestId: 'demo-running-decay-design',
  });
  /** The reviewer passes the open review of `subject`, every criterion met. */
  const pass = async (subject: string, requestId: string) => {
    const open = ((await r('review.list')) as any[]).find(
      (item) => item.subjectId === subject && item.status !== 'submitted',
    );
    if (!open) throw new Error(`The demo found no open review of ${subject}`);
    const claimed = await r('review.start', { reviewId: open.id });
    const asked = await r('review.get', { reviewId: open.id });
    await r('review.submit', {
      reviewId: open.id,
      claimId: claimed.claimId ?? asked.claimId,
      verdict: 'pass',
      synopsis: 'The evidence answers the question as planned.',
      findings: asked.criteria.map((_: string, index: number) => ({
        criterionNumber: index + 1,
        status: 'met',
        evidenceIds: [...asked.artifactIds],
        notes: 'Checked against the pinned evidence.',
      })),
      notes: 'Passing.',
      expectedRevision: asked.subjectRevision,
      requestId,
    });
  };
  await pass(decay.id, 'demo-running-decay-design-verdict');
  const decayRun = await work.lease(
    await p('experiment.get_state', { experimentId: decay.id }),
    input.producerCaller,
  );
  const made = async (title: string, content: string, mediaType: string) =>
    await work.run(decayRun, 'artifact.create', { title, content, mediaType }, (caller, input) =>
      ctx.artifacts.create(caller, input),
    );
  const decayResult = await made(
    'Results: decay-sweep-p97',
    JSON.stringify({ grokking_step: { '0.3': 14200, '1.0': 9810, '3.0': 6050 } }),
    'application/json',
  );
  const decayReport = await made(
    'Report: decay-sweep-p97',
    [
      '# Summary',
      'Yes: the grokking step falls as weight decay grows, from 14,200 at 0.3 to 6,050 at 3.0.',
      'The fall is monotonic, so stronger decay makes the network grok sooner at p = 97.',
      '',
      '# Results',
      '| Arm | Weight decay | Grokking step | 95% interval |',
      '|---|---:|---:|---:|',
      '| Low | 0.3 | 14,200 | ± 900 |',
      '| Mid | 1.0 | 9,810 | ± 700 |',
      '| High | 3.0 | 6,050 | ± 500 |',
      '',
      '```mermaid',
      'flowchart LR',
      '  D[p = 97 table] --> A[decay 0.3: 14,200]',
      '  D --> B[decay 1.0: 9,810]',
      '  D --> C[decay 3.0: 6,050]',
      '  A & B & C --> X{Falls with decay? Yes}',
      '```',
      '',
      'Evidence: metrics_exhibit.json, results.json.',
      '',
      '# Deviations from plan',
      'None.',
      '',
      '# Conclusion',
      '- Stronger decay brings grokking forward.',
      '- One seed per arm: the intervals are run-to-run estimates.',
    ].join('\n'),
    'text/markdown',
  );
  for (const [role, artifact, path] of [
    ['result', decayResult, 'results.json'],
    ['report', decayReport, 'report.md'],
  ] as const)
    await work.run(
      decayRun,
      'experiment.attach',
      {
        artifactId: artifact.id,
        role,
        path,
        attemptIndex: decay.attempt.index,
        requestId: `demo-running-decay-attach-${role}`,
      },
      (caller, input) => ctx.experiments.attach(caller, input),
    );
  await work.run(
    decayRun,
    'experiment.transition',
    { transition: 'submit_results', requestId: 'demo-running-decay-results' },
    (caller, input) => ctx.experiments.transition(caller, input),
  );
  await work.release(decayRun);
  await pass(decay.id, 'demo-running-decay-results-verdict');

  // An experiment planned on the cleaned split: a dashed card that waits on the cleaning.
  await currentExperiment(ctx, input.producerCaller, {
    name: 'embedding-width-ablation',
    intent: 'Does halving the embedding width delay grokking on the cleaned split?',
    dependsOn: [clean.id],
    requestId: 'demo-running-ablation',
  });

  // Last, since an open wave pauses new work: a reflection with one lens taken by an agent.
  const wave = await ctx.reflections.create(owner, {
    title: 'Mid-point reflection: what the sweeps show',
    requestId: 'demo-running-reflection',
  });
  // Its first lens has reported; an agent is on the second.
  const [first, lens] = wave.lenses;
  const reporter = await agent('demo-running-lens-report', studio, first);
  const assigned = await reporter.call('reflection.lens', { lensId: first.id });
  const report = await reporter.call('artifact.create', {
    title: 'Evidence lens: what the sweeps show',
    content: [
      '# Summary',
      'Both sweeps agree: the grokking step falls as weight decay grows, at p = 97 and at p = 113.',
      '',
      '# Evidence',
      '- Decay 0.3 groks at step 14,200; decay 1.0 at 9,810; decay 3.0 at 6,050 (p = 97).',
      '- The p = 113 run at decay 0.3 has not grokked by step 4,000, as expected.',
      '',
      '# Gaps',
      'One seed per setting so far; the warmup ablation was returned for more seeds.',
    ].join('\n'),
    mediaType: 'text/markdown',
  });
  await reporter.call('reflection.submit_lens', {
    lensId: first.id,
    artifactId: report.id,
    expectedRevision: assigned.workflow?.revision ?? first.workflow.revision,
    requestId: 'demo-running-lens-report',
  });
  leases.splice(leases.indexOf(reporter), 1);
  await work.release(reporter.held);
  const reflecting = await agent('demo-running-lens', studio, lens);
  await reflecting.call('reflection.lens', { lensId: lens.id });
  await reflecting.call('project.records');
  reflecting.reads.push(['reflection.lens', { lensId: lens.id }], ['project.records', {}]);
  return { machines, leases, close: () => work.close() };
}

/** A runner's script for its agent's stream, from its first word. */
const saying = (control: { runnerId: string; hostRef: string }, steps: Step[]): Said => ({
  control,
  steps,
  at: 0,
  word: 0,
  bytes: 0,
  round: 0,
});

/**
 * Each scripted agent's next piece, as its runner sends what it read of the agent's log: a few
 * words of what it says, or a tool call and its answer, then the next step, round and round.
 */
export function talking(url: string, token: string, leases: DemoLease[]): () => Promise<void> {
  return async () => {
    for (const lease of leases) {
      const said = lease.says;
      if (!said) continue;
      const step = said.steps[said.at]!;
      const id = `${lease.sessionId}-${said.round}-${said.at}`;
      let events: AgentEvent[];
      if (typeof step === 'string') {
        const words = step.split(' ');
        const piece = words.slice(said.word, said.word + 2);
        said.word += piece.length;
        const done = said.word >= words.length;
        events = [
          {
            kind: 'text',
            id,
            delta: `${said.word > piece.length ? ' ' : ''}${piece.join(' ')}`,
            ...(done && { done: true }),
          },
        ];
        if (!done) {
          await send(lease, events);
          continue;
        }
      } else
        events = [
          { kind: 'tool_call', id, name: step[0], input: JSON.stringify(step[1]) },
          { kind: 'tool_result', id, output: step[2] },
        ];
      said.word = 0;
      said.at = (said.at + 1) % said.steps.length;
      if (!said.at) said.round++;
      await send(lease, events);
    }
  };
  async function send(lease: DemoLease, events: AgentEvent[]) {
    const said = lease.says!;
    const from = said.bytes;
    said.bytes += 100;
    await post(url, token, `/sessions/${lease.sessionId}/stream`, {
      runnerId: said.control.runnerId,
      hostRef: said.control.hostRef,
      from,
      to: said.bytes,
      events,
    }).catch(() => (lease.says = undefined));
  }
}

/**
 * One beat of everything the demo keeps alive: each machine reports itself, each lease is
 * renewed, and one agent in turn makes its next read, so a card says when it last called
 * rather than going quiet. A lease the page halted stays halted: it is dropped at its first
 * refused renewal.
 */
export function beating(
  url: string,
  token: string,
  machines: DemoMachine[],
  leases: DemoLease[],
): () => Promise<void> {
  let turn = 0;
  const made = new Map<DemoLease, number>();
  return async () => {
    for (const machine of machines)
      await post(url, token, '/sessions/runners/heartbeat', machine).catch(() => undefined);
    for (const lease of [...leases])
      await post(url, token, `/sessions/${lease.sessionId}/heartbeat`, {
        runnerId: lease.runnerId,
      }).catch(() => leases.splice(leases.indexOf(lease), 1));
    const calling = leases.filter((lease) => lease.call && lease.reads?.length);
    if (!calling.length) return;
    const lease = calling[turn++ % calling.length]!;
    const count = made.get(lease) ?? 0;
    made.set(lease, count + 1);
    const [tool, input] = lease.reads![count % lease.reads!.length]!;
    await lease.call!(tool, input).catch(() => undefined);
  };
}
