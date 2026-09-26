import type { Caller } from '@merv/contracts';

/**
 * What the Running page draws, seeded in the demo server's own process: work in every state a
 * card can be in, two machines with agents on them, and the calls those agents make. Nothing
 * is written around a service. Machines report themselves on the runner heartbeat route, the
 * producer and the reviewer act through the tool API with their own tokens, and each agent
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
};
const lab: DemoMachine = {
  runnerId: 'lab-gpu-01',
  machine: { hostname: 'lab-gpu-01', system: 'linux', architecture: 'x86_64' },
  platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 4 }],
  capacity: 4,
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
    owner: Caller;
    /** The operator's own token: a runner authenticates with the key it was registered under. */
    token: string;
    producer: Tool;
    reviewer: Tool;
    joinAgent: (
      name: string,
      requestId: string,
      runnerId?: string,
    ) => Promise<{ agent: { id: string }; token: string }>;
    sweep: DemoLease & { taskId: string };
  },
): Promise<{ machines: DemoMachine[]; leases: DemoLease[] }> {
  const { ctx } = app;
  const { url, owner, token, joinAgent, sweep } = input;
  const p = input.producer;
  const r = input.reviewer;
  const machines = [studio, lab];
  for (const machine of machines) await post(url, token, '/sessions/runners/heartbeat', machine);

  const leases: DemoLease[] = [sweep];
  /** An agent on a machine, taking one record, with the tool route its lease credential opens. */
  const agent = async (
    name: string,
    requestId: string,
    machine: DemoMachine,
    record: { id: string; workflow: { revision: number } },
  ) => {
    const joined = await joinAgent(name, requestId, machine.runnerId);
    const session = await ctx.sessions.assignAgent(joined.token, {
      instanceId: record.id,
      expectedRevision: record.workflow.revision,
      requestId: `${requestId}-assignment`,
    });
    const reads: Read[] = [['workflow.assignment', { instanceId: record.id }]];
    const lease = {
      sessionId: session.id,
      runnerId: machine.runnerId,
      call: mcp(url, joined.token),
      reads,
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
    return await p('task.create', { title, goal, checks, briefId: brief.id, requestId, ...extra });
  };
  /** A delivery that claims every check, submitted by the producer who did the work. */
  const deliver = async (created: any, title: string, lines: string[], requestId: string) => {
    const delivery = await p('artifact.create', {
      title,
      content: lines.join('\n'),
      mediaType: 'text/markdown',
    });
    return await p('task.submit_delivery', {
      taskId: created.id,
      artifactIds: [delivery.id],
      confirmations: created.checks.map((check: string, index: number) => ({
        checkNumber: index + 1,
        status: 'met',
        evidenceIds: [delivery.id],
        notes: `${delivery.title} records it: ${check.toLowerCase()}.`,
      })),
      expectedRevision: created.workflow.revision,
      requestId,
    });
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
  const cleaner = await agent('Demo · data cleaner', 'demo-running-cleaner', lab, clean);
  const cleaning = await cleaner.call('task.get', { taskId: clean.id });
  await cleaner.call('task.context', {
    taskId: clean.id,
    purpose: 'work',
    expectedRevision: cleaning.workflow.revision,
    requestId: 'demo-running-clean-context',
  });
  const audit = await cleaner.call('artifact.create', {
    title: 'Leak audit: held-out split',
    content: [
      '# Leak audit',
      '412 of 1,882 held-out equations had their commuted pair in training.',
      'They move to training; the held-out split keeps 1,470 equations.',
    ].join('\n'),
    mediaType: 'text/markdown',
  });
  await cleaner.call('task.checkpoint', {
    taskId: clean.id,
    purpose: 'work',
    expectedRevision: (await cleaner.call('task.get', { taskId: clean.id })).workflow.revision,
    notes: 'Commuted pairs found and moved; the split sizes are next.',
    artifactIds: [audit.id],
    requestId: 'demo-running-clean-checkpoint',
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
  const reviewing = await agent('Demo · harness reviewer', 'demo-running-reviewer', studio, {
    id: harness.id,
    workflow: delivered.workflow,
  });
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

  // An experiment whose design passed review and which an agent on the lab machine runs.
  const name = 'decay-sensitivity-p113';
  const intent = 'Does the grokking step move with weight decay at p = 113 as it does at p = 97?';
  const experiment = await p('experiment.create', {
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
  const runner = await agent('Demo · p113 runner', 'demo-running-p113', lab, running);
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

  // An experiment planned on the cleaned split: a dashed card that waits on the cleaning.
  await p('experiment.create', {
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
  const [lens] = wave.lenses;
  const reflecting = await agent('Demo · methods lens', 'demo-running-lens', studio, lens);
  await reflecting.call('reflection.lens', { lensId: lens.id });
  await reflecting.call('project.records');
  reflecting.reads.push(['reflection.lens', { lensId: lens.id }], ['project.records', {}]);
  return { machines, leases };
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
