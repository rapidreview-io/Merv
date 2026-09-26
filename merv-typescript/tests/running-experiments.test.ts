import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  digest,
  MervError,
  type Caller,
  type ReviewApplication,
  type RunningBoard,
  type RunningNode,
  type RunningPanel,
  type WorkflowDependency,
  type WorkflowHistoryEntry,
} from '@merv/contracts';
import { ExperimentCompute } from '@merv/experiments/compute';
import type { Experiment, ExperimentAttach } from '@merv/experiments/types';
import { enteredAgain, experimentNode, type ExperimentStanding } from '@merv/experiments/running';
import type { SandboxCompute } from '@merv/sandboxes/types';
import { citedEvidence, feasibilityStatement } from './feasibility-fixture.js';
import { createApp } from './fixtures/app.js';
import { reviewedFindings } from './fixtures/task-evidence.js';

const plan =
  '# Summary\nCompare two methods.\n# Objective & hypothesis\nA improves held-out accuracy.\n# Evaluation\nUse the same held-out examples, baseline, metric and denominator.\n';

/**
 * The default composition over HTTP, with one design round allowed so that a second design
 * review has used them all, an operator who owns the work, a reviewer and a reader.
 */
async function assembled(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-running-experiments-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { plugins } = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as { plugins: { id: string; config?: unknown }[] };
  const app = await createApp({
    directory: join(directory, 'data'),
    config: {
      plugins: plugins.map((entry) =>
        entry.id === 'api'
          ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
          : entry.id === 'ui'
            ? { ...entry, config: { assets: join(directory, 'nowhere') } }
            : entry.id === 'experiments'
              ? { ...entry, config: { limits: { designRounds: 1 } } }
              : entry,
      ) as never,
    },
  });
  t.after(() => app.stop());
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Running', actorName: 'Op' });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const issued = await app.ctx.scope.issueActor(operator, { name: role, role });
    return {
      caller: { projectId: operator.projectId, actorId: issued.actor.id } as Caller,
      token: issued.token,
    };
  };
  const reviewer = await issue('reviewer');
  const reader = await issue('reader');
  const tool = async (name: string, token: string, input: unknown = {}) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const board = async (token = boot.token) => {
    const answer = await tool('ui.running', token);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body.result as RunningBoard;
  };
  const panel = async (key: string, token = boot.token) => {
    const answer = await tool('ui.running_panel', token, { key });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body.result as RunningPanel;
  };
  let sequence = 0;
  const request = () => `request-${++sequence}`;
  const create = async (name: string, dependsOn: string[] = []) =>
    await app.ctx.experiments.create(operator, {
      name,
      intent: `Does ${name} change held-out accuracy?`,
      dependsOn,
      requestId: request(),
    });
  const get = async (experiment: Experiment) =>
    await app.ctx.experiments.get(operator, experiment.id);
  const attach = async (experiment: Experiment, role: ExperimentAttach['role'], path: string) => {
    const artifact = await app.ctx.artifacts.create(operator, {
      title: role,
      content: role === 'feasibility' ? feasibilityStatement() : plan,
      mediaType: role === 'feasibility' ? 'application/json' : 'text/markdown',
    });
    await app.ctx.experiments.attach(operator, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      attemptIndex: experiment.attempt.index,
      artifactId: artifact.id,
      role,
      path,
      requestId: request(),
    });
    return artifact;
  };
  const design = async (experiment: Experiment) => {
    await attach(experiment, 'feasibility', 'feasibility.json');
    await attach(experiment, 'plan', 'design/plan.md');
    return await app.ctx.experiments.transition(operator, {
      experimentId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      transition: 'submit_design',
      requestId: request(),
    });
  };
  const offer = async (experiment: Experiment) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    await app.ctx.sessions.offer(operator, {
      instanceId: experiment.id,
      expectedRevision: experiment.workflow.revision,
      runnerId: 'running-test',
      requestId: request(),
      secret,
    });
    return secret;
  };
  return {
    app,
    operator,
    token: boot.token,
    reviewer,
    reader,
    tool,
    board,
    panel,
    request,
    create,
    get,
    attach,
    design,
    offer,
  };
}

const work = (id: string) => `work:${id}`;
const node = (board: RunningBoard, key: string): RunningNode | undefined =>
  Object.values(board.lanes)
    .flatMap((lane) => lane.nodes)
    .find((item) => item.key === key);
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** ML compute that refuses every call as unavailable, so the tick never gets a word in. */
function unavailable(): SandboxCompute {
  const refuse = async (): Promise<never> => {
    throw new MervError('sandbox_unavailable', 'Not in this test', 503);
  };
  return {
    since: '2000-01-01T00:00:00Z',
    offers: refuse,
    allowance: refuse,
    submit: refuse,
    get: refuse,
    cancel: refuse,
  };
}

/** A GPU run's row as the tick would have left it, with a command that holds a secret. */
async function seedRun(
  f: Awaited<ReturnType<typeof assembled>>,
  experimentId: string,
  key: string,
  state: string,
  created: string,
  fields: { cost?: object; result?: object; minutes: number; maxUsd: number; updated?: string },
) {
  await f.app.ctx.state.transaction(
    async (tx) =>
      await tx.run(
        `INSERT INTO experiment_compute_runs
        (project_id,experiment_id,attempt_index,key,input_hash,input_json,run_id,state,cost,result,created_by,created_at,updated_at)
        VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?)`,
        f.operator.projectId,
        experimentId,
        key,
        `hash-${key}`,
        JSON.stringify({
          experimentId,
          attemptIndex: 1,
          key,
          provider: 'lambda',
          offerId: 'gpu',
          command: 'python train.py --token RUN_SECRET_4471',
          minutes: fields.minutes,
          maxUsd: fields.maxUsd,
        }),
        `wf_${key}`,
        state,
        fields.cost ? JSON.stringify(fields.cost) : null,
        fields.result ? JSON.stringify(fields.result) : null,
        f.operator.actorId,
        created,
        fields.updated ?? (state === 'completed' ? at(20) : created),
      ),
  );
  return `compute:${digest([f.operator.projectId, experimentId, 1, key])}`;
}

test('an open experiment is a work card that says where it stands and what it waits on, read without evaluating a gate', async (t) => {
  const f = await assembled(t);
  const producer = f.operator;
  const prerequisite = await f.app.ctx.tasks.create(producer, {
    title: 'Clean held-out set',
    goal: 'Remove leaked examples.',
    checks: ['No example appears in both splits.'],
    requestId: f.request(),
  });
  const waiting = await f.create('ablate-depth', [prerequisite.id]);
  const idle = await f.create('probe-width');
  // Tasks draw their own cards; this stands in for them so the arrow has both ends.
  t.after(
    f.app.ctx.ui.contribute({
      owner: 'probe-tasks',
      kinds: ['probe'],
      lanes: ['work'],
      nodes: async () => ({
        nodes: [
          {
            key: work(prerequisite.id),
            lane: 'work',
            kind: 'Task',
            title: prerequisite.title,
            lines: [],
            look: 'solid',
          },
        ],
      }),
    }),
  );
  const reads = t.mock.method(f.app.ctx.artifacts, 'read');
  const evaluations = t.mock.method(f.app.ctx.workflows, 'evaluate');
  const graphs = t.mock.method(f.app.ctx.workflows, 'process');
  const counts = () =>
    [reads, evaluations, graphs].map((spy) => spy.mock.callCount()) as [number, number, number];
  // Other owners' parts are theirs to answer for; this one's cards read no artifact and
  // derive no gate, and the dot on a card is never its owner's.
  const quiet = async (token?: string) => {
    const before = counts();
    const cards = await f.app.ctx.experiments.running(f.operator);
    assert.deepEqual(
      counts().map((count, index) => count - before[index]!),
      [0, 0, 0],
      'the cards read no artifact and derive no gate',
    );
    assert.ok(cards.every((card) => card.dot === undefined || card.lane === 'hardware'));
    return await f.board(token);
  };
  // The spies see what Experiments calls: its record page's ladder reads through them.
  await f.app.ctx.experiments.process(f.operator, idle.id);
  assert.equal(graphs.mock.callCount(), 1);

  let board = await quiet();
  assert.deepEqual(board.lanes.work.failed, []);
  assert.deepEqual(node(board, work(waiting.id)), {
    key: work(waiting.id),
    lane: 'work',
    kind: 'Experiment',
    title: 'ablate-depth',
    lines: [['Waits on ', 'Clean held-out set']],
    look: 'dashed',
    links: [{ to: work(prerequisite.id), verb: 'waits on', waiting: true }],
    rank: 3,
    owner: 'experiments',
  });
  assert.deepEqual(board.edges, [
    { from: work(waiting.id), to: work(prerequisite.id), verb: 'waits on', waiting: true },
  ]);
  assert.deepEqual(node(board, work(idle.id))?.lines, [
    ['Waiting for an agent · ', { since: idle.workflow.updatedAt }],
  ]);
  assert.equal(node(board, work(idle.id))?.look, 'dashed');
  assert.deepEqual(board.lanes.hardware.nodes, [], 'no GPU runs while ML compute is unbound');

  // Work another plugin holds back is offered to no agent, so its card does not promise one.
  const publish = async (blockers: { key: string; code: string; next: string }[]) =>
    await f.app.ctx.state.transaction(
      async (tx) =>
        await f.app.ctx.workflows.replaceBlockers(
          {
            projectId: f.operator.projectId,
            instanceId: idle.id,
            provider: 'code',
            blockers: blockers.map((item) => ({
              ...item,
              message: 'Main is pending.',
              status: 409,
            })),
          },
          tx,
        ),
    );
  await publish([{ key: 'base', code: 'code_base_pending', next: 'Code imports main.' }]);
  board = await quiet();
  assert.deepEqual(
    [node(board, work(idle.id))?.lines, node(board, work(idle.id))?.look],
    [[['Waiting']], 'dashed'],
  );
  assert.deepEqual((await f.panel(work(idle.id))).header.says, [
    'Waiting',
    ' · ',
    { since: idle.workflow.updatedAt },
  ]);
  await publish([]);

  // A lease holds it: starting until its worker takes it up, then designing.
  const secret = await f.offer(idle);
  board = await quiet();
  assert.deepEqual(
    [node(board, work(idle.id))?.lines, node(board, work(idle.id))?.look],
    [[['Designing · starting']], 'solid'],
  );
  const agent = await f.app.ctx.sessions.authenticate(secret);
  board = await quiet(f.reader.token);
  assert.deepEqual(node(board, work(idle.id))?.lines, [['Designing']]);
  assert.equal(node(board, work(idle.id))?.rank, 1);

  // Once its lease ends without a move, it has waited since the lease ended.
  await f.app.ctx.sessions.halt(f.operator, { sessionId: agent.session!.id });
  const [lease] = await f.app.ctx.state.transaction(
    async (tx) =>
      await tx.all<{ released_at: string }>(
        'SELECT released_at FROM experiment_leases WHERE experiment_id=?',
        idle.id,
      ),
  );
  assert.ok(lease!.released_at > idle.workflow.updatedAt);
  board = await quiet();
  assert.deepEqual(node(board, work(idle.id))?.lines, [
    ['Waiting for an agent · ', { since: lease!.released_at }],
  ]);

  // A prerequisite that failed stops it, and only a person moves it on.
  await f.app.ctx.tasks.markFailed(producer, {
    taskId: prerequisite.id,
    expectedRevision: prerequisite.workflow.revision,
    reason: 'The held-out set cannot be recovered.',
    requestId: f.request(),
  });
  board = await quiet();
  assert.deepEqual(node(board, work(waiting.id))?.attention, {
    says: ['Stopped: ', 'Clean held-out set', ' failed'],
    who: 'The owner ends the experiment, or its cycle replans it.',
  });
  assert.equal(board.lanes.work.needsYou, 1);
  const sidebar = await f.panel(work(waiting.id));
  // No agent is offered it now, so its head names only where it stands beside the red.
  assert.deepEqual(sidebar.header.says, [
    'Designing',
    ' · ',
    { since: waiting.workflow.updatedAt },
  ]);
  const waitsOn = sidebar.sections.find((section) => section.title === 'Waits on');
  assert.equal(sidebar.sections[0], waitsOn, 'the reason it needs a person leads its sidebar');
  assert.deepEqual(waitsOn, {
    title: 'Waits on',
    place: 'relations',
    kind: 'links',
    attention: true,
    owner: 'experiments',
    rows: [
      {
        to: { key: work(prerequisite.id), route: `/tasks/${prerequisite.id}` },
        kind: 'Task',
        name: 'Clean held-out set',
        says: [{ state: 'failed' }],
        attention: true,
      },
    ],
  });
  assert.deepEqual(sidebar.header.attention, node(board, work(waiting.id))?.attention);

  // An ended experiment leaves the board; a key another owner holds keeps it, quiet.
  await f.app.ctx.experiments.transition(f.operator, {
    experimentId: waiting.id,
    expectedRevision: (await f.get(waiting)).workflow.revision,
    transition: 'abandon',
    evidence: { reason: 'Its prerequisite failed.' },
    requestId: f.request(),
  });
  assert.equal(node(await quiet(), work(waiting.id)), undefined);
  const held = await f.app.ctx.experiments.running(f.operator, new Set([work(waiting.id)]));
  assert.deepEqual(
    held.find((item) => item.key === work(waiting.id)),
    {
      key: work(waiting.id),
      lane: 'work',
      kind: 'Experiment',
      title: 'ablate-depth',
      lines: [['Abandoned']],
      look: 'quiet',
      rank: 4,
    },
  );
  assert.equal(await f.app.ctx.experiments.runningPanel(f.operator, work(prerequisite.id)), null);
  assert.equal(await f.app.ctx.experiments.runningPanel(f.operator, 'session:unknown'), null);
});

test('a review state says who holds the review, and rounds used up need a person', async (t) => {
  const f = await assembled(t);
  let experiment = await f.design(await f.create('ablate-retrieval'));
  const review = await f.app.ctx.reviews.get(f.operator, experiment.reviewId!);
  let board = await f.board();
  assert.deepEqual(
    [node(board, work(experiment.id))?.lines, node(board, work(experiment.id))?.look],
    [[['Design review · unclaimed · ', { since: review.createdAt }]], 'dashed'],
  );

  const started = await f.app.ctx.reviews.start(f.reviewer.caller, review.id);
  board = await f.board(f.reader.token);
  assert.deepEqual(node(board, work(experiment.id))?.lines, [
    ['Design review · ', { actor: f.reviewer.caller.actorId, prefix: 'with ', unnamed: 'claimed' }],
  ]);
  assert.equal(node(board, work(experiment.id))?.attention, undefined);

  experiment = await f.app.ctx.experiments.submitReview(f.reviewer.caller, {
    ...reviewedFindings(started),
    reviewId: started.id,
    claimId: started.claimId!,
    verdict: 'needs_changes',
    notes: 'The baseline is not described.',
    expectedRevision: experiment.workflow.revision,
    requestId: f.request(),
  } as ReviewApplication);
  assert.equal(experiment.workflow.state, 'planned');
  experiment = await f.design(experiment);
  board = await f.board();
  assert.deepEqual(node(board, work(experiment.id))?.attention, {
    says: ['Out of review rounds'],
    who: 'An independent reviewer reviews it by hand, or an operator allows another round.',
  });
  assert.equal(board.lanes.work.needsYou, 1);
  const sidebar = await f.panel(work(experiment.id));
  assert.deepEqual(sidebar.header.attention, node(board, work(experiment.id))?.attention);
  assert.deepEqual(sidebar.header.says, [
    'Design review · unclaimed · ',
    { since: (await f.app.ctx.reviews.get(f.operator, experiment.reviewId!)).createdAt },
  ]);

  // The design came back once and now passes: its first run is not a second one, though
  // the attempt it runs was opened by the return.
  const second = await f.app.ctx.reviews.start(f.reviewer.caller, experiment.reviewId!);
  const current = await f.get(experiment);
  const reviewed = reviewedFindings(second) as { findings?: { criterionNumber: number }[] };
  experiment = await f.app.ctx.experiments.submitReview(f.reviewer.caller, {
    ...reviewed,
    findings: reviewed.findings?.map((finding) => ({
      ...finding,
      evidenceIds: citedEvidence(current, second, finding.criterionNumber),
    })),
    reviewId: second.id,
    claimId: second.claimId!,
    verdict: 'pass',
    notes: 'The baseline is now described.',
    expectedRevision: current.workflow.revision,
    requestId: f.request(),
  } as ReviewApplication);
  assert.deepEqual([experiment.workflow.state, experiment.attempt.previousIndex], ['running', 1]);
  const runner = await f.app.ctx.sessions.authenticate(await f.offer(experiment));
  assert.deepEqual(node(await f.board(), work(experiment.id))?.lines, [['Running']]);

  // Retried after an interruption, it runs again.
  await f.app.ctx.sessions.halt(f.operator, { sessionId: runner.session!.id });
  experiment = await f.app.ctx.experiments.transition(f.operator, {
    experimentId: experiment.id,
    expectedRevision: experiment.workflow.revision,
    transition: 'retry_running',
    evidence: { reason: 'The machine was lost.' },
    requestId: f.request(),
  });
  await f.app.ctx.sessions.authenticate(await f.offer(experiment));
  assert.deepEqual(node(await f.board(), work(experiment.id))?.lines, [['Running again']]);
});

test('a planned experiment’s sidebar draws its ladder without running a check, so no artifact is read', async (t) => {
  const f = await assembled(t);
  const experiment = await f.create('weight-decay');
  const feasibility = await f.attach(experiment, 'feasibility', 'feasibility.json');
  const written = await f.attach(experiment, 'plan', 'design/plan.md');
  const reads = t.mock.method(f.app.ctx.artifacts, 'read');
  const graphs = t.mock.method(f.app.ctx.workflows, 'process');
  // The record page's own read runs the submission's checks, which read the plan's bytes.
  await f.app.ctx.experiments.process(f.operator, experiment.id);
  assert.ok(reads.mock.callCount() > 0);

  reads.mock.resetCalls();
  graphs.mock.resetCalls();
  const sidebar = await f.panel(work(experiment.id));
  assert.equal(reads.mock.callCount(), 0, 'the sidebar reads no artifact');
  assert.deepEqual(
    graphs.mock.calls.map((call) => call.arguments.slice(1)),
    [[experiment.id, { checks: false }]],
  );
  const current = await f.get(experiment);
  assert.deepEqual(sidebar.header, {
    kind: 'Experiment',
    title: 'weight-decay',
    says: ['Waiting for an agent · ', { since: current.workflow.updatedAt }],
  });
  assert.deepEqual(
    sidebar.sections.map((section) => [section.title, section.place, section.kind]),
    [
      ['Stage', 'progress', 'ladder'],
      ['Question', 'content', 'text'],
      ['Evidence', 'content', 'links'],
      ['Details', 'details', 'facts'],
    ],
  );
  const [stage, question, evidence, details] = sidebar.sections;
  assert.ok(stage.kind === 'ladder');
  assert.deepEqual(
    [stage.graph.state, stage.graph.currentGate, stage.graph.nodes.find((n) => n.current)?.state],
    ['planned', 'planned', 'planned'],
  );
  assert.ok(stage.graph.edges.every((edge) => edge.status === null && !edge.blockers.length));
  assert.deepEqual(question, {
    title: 'Question',
    place: 'content',
    kind: 'text',
    text: 'Does weight-decay change held-out accuracy?',
    clamp: 4,
    owner: 'experiments',
  });
  assert.ok(evidence.kind === 'links');
  assert.deepEqual(
    evidence.rows.map((row) => [row.kind, row.name, row.to]),
    [
      ['Plan', 'plan.md', { route: `/artifacts/${written.id}` }],
      ['Feasibility', 'feasibility.json', { route: `/artifacts/${feasibility.id}` }],
    ],
  );
  assert.deepEqual(details, {
    title: 'Details',
    place: 'details',
    kind: 'facts',
    owner: 'experiments',
    rows: [{ label: 'Owner', value: [{ actor: f.operator.actorId }] }],
  });
  assert.deepEqual(
    [sidebar.route, sidebar.live, sidebar.actions],
    [`/experiments/${experiment.id}`, false, []],
  );
});

test('a live GPU run is a hardware card that runs for its experiment, never red and never showing its command', async (t) => {
  const f = await assembled(t);
  t.after(f.app.ctx.experiments.bindCompute(unavailable()));
  const experiment = await f.create('sweep-depth');
  const ended = await f.create('sweep-width');
  await f.app.ctx.experiments.transition(f.operator, {
    experimentId: ended.id,
    expectedRevision: ended.workflow.revision,
    transition: 'abandon',
    evidence: { reason: 'Superseded by sweep-depth.' },
    requestId: f.request(),
  });
  const [long, twelve, two, half] = [at(90), at(12), at(2), at(30)];
  const baseline = await seedRun(f, experiment.id, 'baseline', 'completed', long, {
    cost: { amount: '1.20', currency: 'USD' },
    result: { result: { exit: 0, bytes: 12, head: '', tail: 'RUN_SECRET_4471' }, reason: null },
    minutes: 30,
    maxUsd: 2,
  });
  const running = await seedRun(f, experiment.id, 'sweep-k16', 'running', twelve, {
    cost: { amount: '2.10', currency: 'USD' },
    minutes: 60,
    maxUsd: 8,
  });
  const starting = await seedRun(f, experiment.id, 'sweep-k32', 'submitting', two, {
    minutes: 90,
    maxUsd: 4.5,
  });
  const releasing = await seedRun(f, ended.id, 'sweep-w8', 'cancelling', half, {
    cost: { amount: '0.40', currency: 'USD' },
    minutes: 30,
    maxUsd: 2,
  });

  for (const token of [f.token, f.reader.token]) {
    const board = await f.board(token);
    assert.deepEqual(board.lanes.hardware.failed, []);
    assert.deepEqual(
      board.lanes.hardware.nodes.map((item) => item.key),
      [releasing, running, starting],
    );
    const [release, run, start] = board.lanes.hardware.nodes;
    assert.deepEqual(run, {
      key: running,
      lane: 'hardware',
      title: 'GPU run',
      name: 'sweep-k16',
      lines: [
        ['Running ', { since: twelve }],
        [
          'Reserved ',
          { money: { amount: '2.10', currency: 'USD' }, of: { amount: '8', currency: 'USD' } },
        ],
      ],
      look: 'solid',
      dot: 'live',
      links: [{ to: work(experiment.id), verb: 'runs for' }],
      owner: 'experiments',
    });
    assert.deepEqual(
      [start.lines, start.look, start.dot],
      [
        [
          ['Starting · ', { since: two }],
          // Nothing is reserved before the service says so; the cap alone is known.
          ['Cost cap ', { money: { amount: '4.5', currency: 'USD' } }],
        ],
        'dashed',
        'starting',
      ],
    );
    assert.deepEqual(
      [release.lines[0], release.look, release.dot],
      [['Releasing'], 'quiet', undefined],
    );
    assert.equal(node(board, baseline), undefined, 'a finished run leaves the board');
    assert.equal(board.lanes.hardware.needsYou, 0);
    assert.ok(board.lanes.hardware.nodes.every((item) => !item.attention));
    assert.ok(
      board.edges.some(
        (edge) =>
          edge.from === running && edge.to === work(experiment.id) && edge.verb === 'runs for',
      ),
    );
    // An ended experiment stays while its GPU is given back, so the run is never drawn alone.
    assert.deepEqual(
      [node(board, work(ended.id))?.lines, node(board, work(ended.id))?.look],
      [[['Ended · releasing GPU']], 'quiet'],
    );
    assert.ok(!JSON.stringify(board).includes('RUN_SECRET_4471'));
  }

  const sidebar = await f.panel(work(experiment.id));
  const runs = sidebar.sections.find((section) => section.title === 'GPU runs');
  assert.ok(runs?.kind === 'table');
  assert.deepEqual(runs.columns, ['Run', 'State', 'Time', 'Cost']);
  assert.deepEqual(runs.aside, [{ count: 3 }]);
  assert.deepEqual(
    runs.rows.map((row) => [row.cells[0], row.cells[1], row.to]),
    [
      [['sweep-k16'], [{ state: 'running' }], { key: running }],
      [['sweep-k32'], [{ state: 'starting' }], { key: starting }],
      [['baseline'], [{ state: 'completed' }, ' · exit 0'], undefined],
    ],
  );
  // A row says what its card says of the money.
  const [runCard, startCard] = [node(await f.board(), running)!, node(await f.board(), starting)!];
  assert.deepEqual(
    runs.rows.slice(0, 2).map((row) => row.cells[3]),
    [runCard.lines[1], startCard.lines[1]],
  );
  assert.ok('ago' in (runs.rows[2].cells[2][0] as object));
  assert.equal(sidebar.live, true);

  const own = await f.panel(running, f.reader.token);
  assert.deepEqual(own.header, {
    kind: 'GPU run',
    title: 'sweep-k16',
    says: ['Running ', { since: twelve }],
  });
  assert.deepEqual(own.sections, [
    {
      title: 'Run',
      place: 'activity',
      kind: 'facts',
      owner: 'experiments',
      rows: [
        {
          label: 'Experiment',
          value: [
            {
              link: { key: work(experiment.id), route: `/experiments/${experiment.id}` },
              text: 'sweep-depth',
            },
          ],
        },
        { label: 'State', value: [{ state: 'running' }] },
        { label: 'Requested', value: [{ ago: twelve }] },
        { label: 'Time cap', value: ['1h'] },
        {
          label: 'Reserved',
          value: [
            { money: { amount: '2.10', currency: 'USD' }, of: { amount: '8', currency: 'USD' } },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual([own.actions, own.live, own.route], [[], true, `/experiments/${experiment.id}`]);
  const asked = await f.panel(starting);
  assert.deepEqual(asked.sections[0]?.kind === 'facts' && asked.sections[0].rows.at(-1), {
    label: 'Cost cap',
    value: [{ money: { amount: '4.5', currency: 'USD' } }],
  });
  // A finished run's sidebar still answers, so an open one outlives its card.
  const finished = await f.panel(baseline);
  assert.deepEqual(finished.header.says, [{ state: 'completed' }, ' · exit 0']);
  assert.equal(finished.live, false);
  assert.ok(!JSON.stringify([sidebar, own, finished]).includes('RUN_SECRET_4471'));
  assert.ok(!JSON.stringify([sidebar, own, finished]).includes('python train.py'));
  const missing = await f.tool('ui.running_panel', f.token, { key: `compute:${'0'.repeat(64)}` });
  assert.equal(missing.status, 404);
});

test('the words of a card follow where the experiment stands, first match wins', () => {
  const task = (name: string, state: string, settled = false, failed = false) =>
    ({
      id: name,
      workflow: 'task',
      version: 2,
      name,
      state,
      settled,
      failed,
    }) as WorkflowDependency;
  const base: ExperimentStanding = {
    id: 'exp',
    name: 'ablate-depth',
    state: 'planned',
    updatedAt: '2026-09-25T10:00:00.000Z',
    idleSince: '2026-09-25T10:05:00.000Z',
    again: false,
    blocked: false,
    lease: null,
    dependencies: [],
    review: null,
    exhausted: false,
    computing: false,
  };
  const face = (change: Partial<ExperimentStanding>) => {
    const drawn = experimentNode({ ...base, ...change });
    return [drawn.lines[0], drawn.look, drawn.attention?.says ?? null];
  };
  assert.deepEqual(face({}), [
    ['Waiting for an agent · ', { since: '2026-09-25T10:05:00.000Z' }],
    'dashed',
    null,
  ]);
  assert.deepEqual(
    face({
      dependencies: [
        task('Clean held-out set', 'in_progress'),
        task('Build index', 'in_review'),
        task('Tokenise', 'in_progress'),
        task('Done already', 'done', true),
      ],
    }),
    [['Waits on ', 'Clean held-out set', ' and 2 more'], 'dashed', null],
  );
  assert.deepEqual(face({ state: 'running', again: true, lease: { started: true } }), [
    ['Running again'],
    'solid',
    null,
  ]);
  assert.deepEqual(face({ state: 'running', lease: { started: false } }), [
    ['Running · starting'],
    'solid',
    null,
  ]);
  assert.deepEqual(face({ state: 'experiment_review', lease: { started: true } }), [
    ['Results review · with an agent'],
    'solid',
    null,
  ]);
  const review = { status: 'requested', createdAt: '2026-09-25T10:01:00.000Z' };
  assert.deepEqual(
    face({
      state: 'experiment_review',
      review: { ...review, waiting: 'Every eligible reviewer contributed.' } as never,
    }),
    [
      ['Results review · unclaimed · ', { since: review.createdAt }],
      'dashed',
      ['No independent reviewer'],
    ],
  );
  assert.equal(
    experimentNode({ ...base, state: 'experiment_review', review: { waiting: 'x' } as never })
      .attention?.who,
    'An operator provides one.',
  );
  // A failed prerequisite outranks the rounds, which outrank a missing reviewer.
  assert.deepEqual(
    face({
      state: 'design_review',
      exhausted: true,
      review: { waiting: 'x' } as never,
      dependencies: [task('Clean held-out set', 'failed', false, true)],
    })[2],
    ['Stopped: ', 'Clean held-out set', ' failed'],
  );
  // A failed prerequisite is why nothing comes for it, so no line says an agent will.
  assert.deepEqual(
    face({ again: true, dependencies: [task('Clean held-out set', 'failed', false, true)] }),
    [['Designing again'], 'solid', ['Stopped: ', 'Clean held-out set', ' failed']],
  );
  // Another plugin's blocker keeps agents away; a lease already on it still says so.
  assert.deepEqual(face({ blocked: true }), [['Waiting'], 'dashed', null]);
  assert.deepEqual(face({ blocked: true, lease: { started: true } }), [
    ['Designing'],
    'solid',
    null,
  ]);
  assert.deepEqual(face({ state: 'complete' }), [['Complete'], 'quiet', null]);
  assert.deepEqual(face({ state: 'failed', computing: true }), [
    ['Ended · releasing GPU'],
    'quiet',
    null,
  ]);
  assert.equal(experimentNode({ ...base, lease: { started: true } }).dot, undefined);
});

test('an experiment is in a state again only when it has entered it before', () => {
  let revision = 0;
  const step = (action: string, fromState: string | null, toState: string) =>
    ({ revision: ++revision, action, fromState, toState }) as WorkflowHistoryEntry;
  const created = [step('start', null, 'planned'), step('add_dependencies', 'planned', 'planned')];
  const returned = [
    ...created,
    step('submit_design', 'planned', 'design_review'),
    step('revise_design', 'design_review', 'planned'),
  ];
  const approved = [
    ...returned,
    step('submit_design', 'planned', 'design_review'),
    step('approve_design', 'design_review', 'running'),
  ];
  assert.equal(enteredAgain(created, 'planned'), false, 'the engine’s own rows are no return');
  assert.equal(enteredAgain(returned, 'planned'), true);
  assert.equal(
    enteredAgain(approved, 'running'),
    false,
    'a returned design runs for the first time',
  );
  assert.equal(
    enteredAgain([...approved, step('retry_running', 'running', 'running')], 'running'),
    true,
  );
  assert.equal(
    enteredAgain(
      [
        ...approved,
        step('submit_results', 'running', 'experiment_review'),
        step('revise_execution', 'experiment_review', 'running'),
      ],
      'running',
    ),
    true,
  );
});

test('a GPU run past the time its service must have ended it claims no liveness while the tick cannot hear', async (t) => {
  const f = await assembled(t);
  t.after(f.app.ctx.experiments.bindCompute(unavailable()));
  const experiment = await f.create('sweep-heads');
  const ended = await f.create('sweep-layers');
  await f.app.ctx.experiments.transition(f.operator, {
    experimentId: ended.id,
    expectedRevision: ended.workflow.revision,
    transition: 'abandon',
    evidence: { reason: 'Superseded by sweep-heads.' },
    requestId: f.request(),
  });
  // An hour's run asked for three hours ago, and nothing written since.
  const asked = at(180);
  const stale = await seedRun(f, experiment.id, 'sweep-h8', 'running', asked, {
    cost: { amount: '2.10', currency: 'USD' },
    minutes: 60,
    maxUsd: 8,
  });
  // As long ago, but the tick wrote what the service said a minute ago: submitted late, alive.
  const late = await seedRun(f, experiment.id, 'sweep-h16', 'running', asked, {
    cost: { amount: '0.90', currency: 'USD' },
    minutes: 60,
    maxUsd: 8,
    updated: at(1),
  });
  // The ended experiment's run could not be cancelled, but its time ran out long ago.
  const unreleased = await seedRun(f, ended.id, 'sweep-l4', 'cancelling', at(120), {
    minutes: 30,
    maxUsd: 2,
    updated: at(100),
  });

  const board = await f.board();
  assert.deepEqual(
    [stale, late, unreleased].map((key) => {
      const card = node(board, key)!;
      return [card.look, card.dot ?? null, card.attention ?? null];
    }),
    [
      ['quiet', null, { says: ['Past its time cap · not heard from'], quiet: true }],
      ['solid', 'live', null],
      ['quiet', null, { says: ['Past its time cap · not heard from'], quiet: true }],
    ],
  );
  assert.equal(board.lanes.hardware.needsYou, 0, 'a quiet line needs nobody');
  // Its GPU went back with the service's own cap, so the ended experiment only says how it ended.
  assert.deepEqual(
    [node(board, work(ended.id))?.lines, node(board, work(ended.id))?.look],
    [[['Abandoned']], 'quiet'],
  );

  const own = await f.panel(stale);
  assert.deepEqual(
    [own.header.says, own.header.attention, own.live],
    [
      ['Running ', { since: asked }],
      { says: ['Past its time cap · not heard from'], quiet: true },
      false,
    ],
  );
  const sidebar = await f.panel(work(experiment.id));
  const runs = sidebar.sections.find((section) => section.title === 'GPU runs');
  assert.ok(runs?.kind === 'table');
  assert.deepEqual(
    runs.rows.map((row) => [row.cells[0], row.cells[1]]),
    [
      [['sweep-h16'], [{ state: 'running' }]],
      [['sweep-h8'], [{ state: 'running' }, ' · not heard from']],
    ],
  );
  assert.equal(sidebar.live, true, 'the run the tick hears from is live');
});

test('a live run’s sidebar is found among the runs in flight, without reading every run the project had', async () => {
  const compute = new ExperimentCompute(
    {} as never,
    {} as never,
    { since: '2000-01-01T00:00:00Z' } as SandboxCompute,
    () => undefined,
  );
  compute.close();
  const row = (key: string, state: string) => ({
    project_id: 'project',
    experiment_id: 'experiment',
    attempt_index: 1,
    key,
    input_hash: `hash-${key}`,
    input_json: JSON.stringify({ minutes: 60, maxUsd: 2, command: 'secret' }),
    run_id: null,
    state,
    cost: null,
    result: null,
    created_by: 'actor',
    created_at: at(5),
    updated_at: at(5),
  });
  const statements: string[] = [];
  const tx = {
    all: async (sql: string) => {
      statements.push(sql);
      return /state IN/.test(sql)
        ? [row('live', 'running')]
        : [row('live', 'running'), row('done', 'completed')];
    },
    get: async (sql: string) => {
      statements.push(sql);
      return row('done', 'completed');
    },
  } as never;
  const named = (key: string) => digest(['project', 'experiment', 1, key]);
  assert.equal((await compute.find('project', named('live'), tx))?.key, 'live');
  assert.equal(statements.length, 1, 'one read of the runs in flight');
  statements.length = 0;
  assert.equal((await compute.find('project', named('done'), tx))?.key, 'done');
  assert.equal(statements.length, 3, 'a finished run is looked for among all');
  statements.length = 0;
  assert.equal(await compute.find('project', named('missing'), tx), null);
});
