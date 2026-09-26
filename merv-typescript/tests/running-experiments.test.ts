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
} from '@merv/contracts';
import type { Experiment, ExperimentAttach } from '@merv/experiments/types';
import { experimentNode, type ExperimentStanding } from '@merv/experiments/running';
import type { SandboxCompute } from '@merv/sandboxes/types';
import { feasibilityStatement } from './feasibility-fixture.js';
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

  // A lease holds it: starting until its worker takes it up, then designing.
  const secret = await f.offer(idle);
  board = await quiet();
  assert.deepEqual(
    [node(board, work(idle.id))?.lines, node(board, work(idle.id))?.look],
    [[['Designing · starting']], 'solid'],
  );
  await f.app.ctx.sessions.authenticate(secret);
  board = await quiet(f.reader.token);
  assert.deepEqual(node(board, work(idle.id))?.lines, [['Designing']]);
  assert.equal(node(board, work(idle.id))?.rank, 1);

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
  // The tick never gets a word in: every call to the service is refused as unavailable.
  const refuse = async (): Promise<never> => {
    throw new MervError('sandbox_unavailable', 'Not in this test', 503);
  };
  const adapter: SandboxCompute = {
    since: '2000-01-01T00:00:00Z',
    offers: refuse,
    allowance: refuse,
    submit: refuse,
    get: refuse,
    cancel: refuse,
  };
  t.after(f.app.ctx.experiments.bindCompute(adapter));
  const experiment = await f.create('sweep-depth');
  const ended = await f.create('sweep-width');
  await f.app.ctx.experiments.transition(f.operator, {
    experimentId: ended.id,
    expectedRevision: ended.workflow.revision,
    transition: 'abandon',
    evidence: { reason: 'Superseded by sweep-depth.' },
    requestId: f.request(),
  });
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const seed = async (
    experimentId: string,
    key: string,
    state: string,
    created: string,
    fields: { cost?: object; result?: object; minutes: number; maxUsd: number },
  ) => {
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
          state === 'completed' ? at(20) : created,
        ),
    );
    return `compute:${digest([f.operator.projectId, experimentId, 1, key])}`;
  };
  const [long, twelve, two, half] = [at(90), at(12), at(2), at(30)];
  const baseline = await seed(experiment.id, 'baseline', 'completed', long, {
    cost: { amount: '1.20', currency: 'USD' },
    result: { result: { exit: 0, bytes: 12, head: '', tail: 'RUN_SECRET_4471' }, reason: null },
    minutes: 30,
    maxUsd: 2,
  });
  const running = await seed(experiment.id, 'sweep-k16', 'running', twelve, {
    cost: { amount: '2.10', currency: 'USD' },
    minutes: 60,
    maxUsd: 8,
  });
  const starting = await seed(experiment.id, 'sweep-k32', 'submitting', two, {
    minutes: 90,
    maxUsd: 4.5,
  });
  const releasing = await seed(ended.id, 'sweep-w8', 'cancelling', half, {
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
          ['Reserved ', { money: null, of: { amount: '4.5', currency: 'USD' } }],
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
  assert.deepEqual(runs.columns, ['Run', 'State', 'Time', 'Reserved']);
  assert.deepEqual(runs.aside, [{ count: 3 }]);
  assert.deepEqual(
    runs.rows.map((row) => [row.cells[0], row.cells[1], row.to]),
    [
      [['sweep-k16'], [{ state: 'running' }], { key: running }],
      [['sweep-k32'], [{ state: 'starting' }], { key: starting }],
      [['baseline'], [{ state: 'completed' }, ' · exit 0'], undefined],
    ],
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
  assert.deepEqual(face({ state: 'complete' }), [['Complete'], 'quiet', null]);
  assert.deepEqual(face({ state: 'failed', computing: true }), [
    ['Ended · releasing GPU'],
    'quiet',
    null,
  ]);
  assert.equal(experimentNode({ ...base, lease: { started: true } }).dot, undefined);
});
