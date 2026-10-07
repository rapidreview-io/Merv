import { waitForManagedCode } from './fixtures/managed-code.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  type Caller,
  type ReviewApplication,
  type RunningBoard,
  type RunningNode,
  type RunningPanel,
} from '@merv/contracts';
import type { WorkflowDependency, WorkflowHistoryEntry } from '@merv/workflows/models';
import type { Experiment, ExperimentAttach } from '@merv/experiments/types';
import {
  enteredAgain,
  experimentNode,
  experimentPanel,
  type ExperimentStanding,
} from '@merv/experiments/running';
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
            : entry,
      ) as never,
    },
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Running',
    actorName: 'Op',
  });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, operator);
  await app.ctx.sessions.dispatch.heartbeatRunner(operator, {
    runnerId: 'running-test',
    machine: { hostname: 'test', system: 'linux', architecture: 'x64' },
    platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 1 }],
    capacity: 4,
    capabilities: ['code.v2'],
  });
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const issued = await app.ctx.scope.credentials.issueActor(operator, { name: role, role });
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
  const reads = t.mock.method(f.app.ctx.artifacts, 'bytes');
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
    assert.ok(cards.every((card) => card.dot === undefined));
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
    started: waiting.createdAt,
    owner: 'experiments',
  });
  assert.deepEqual(board.edges, [
    { from: work(waiting.id), to: work(prerequisite.id), verb: 'waits on', waiting: true },
  ]);
  assert.deepEqual(node(board, work(idle.id))?.lines, [
    ['Waiting for an agent · ', { since: idle.workflow.updatedAt }],
  ]);
  assert.equal(node(board, work(idle.id))?.look, 'dashed');

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
  await f.app.ctx.sessions.dispatch.halt(f.operator, { sessionId: agent.session!.id });
  const [lease] = await f.app.ctx.state.transaction(
    async (tx) =>
      await tx.all<{ released_at: string }>(
        'SELECT released_at FROM wf_leases WHERE instance_id=?',
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
      started: waiting.createdAt,
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
  // Every other round the default allows is used too.
  for (let round = 1; round < 4; round++) {
    const again = await f.app.ctx.reviews.start(f.reviewer.caller, experiment.reviewId!);
    experiment = await f.app.ctx.experiments.submitReview(f.reviewer.caller, {
      ...reviewedFindings(again),
      reviewId: again.id,
      claimId: again.claimId!,
      verdict: 'needs_changes',
      notes: 'The baseline is not described.',
      expectedRevision: experiment.workflow.revision,
      requestId: f.request(),
    } as ReviewApplication);
    experiment = await f.design(experiment);
  }
  board = await f.board();
  // Workflows' mark says it, with the admin's control, in the words every owner's work shares.
  const capped = {
    says: ['Every round of ', { mono: 'design_rounds' }, ' is used · ', { count: 4 }],
    who: 'A project admin allows another round, or a person takes the next step by hand or ends it',
  };
  const { action, ...own } = node(board, work(experiment.id))!.attention!;
  assert.deepEqual(own, capped);
  assert.deepEqual(
    [action?.tool, action?.input],
    ['workflow.extend_limit', { instanceId: experiment.id, limit: 'design_rounds', additional: 1 }],
  );
  assert.equal(board.lanes.work.needsYou, 1);
  const sidebar = await f.panel(work(experiment.id));
  // The sidebar draws the board's mark, which the experiment's own head no longer repeats.
  assert.equal(sidebar.header.attention, undefined);
  assert.deepEqual(sidebar.header.says, [
    'Design review · unclaimed · ',
    { since: (await f.app.ctx.reviews.get(f.operator, experiment.reviewId!)).createdAt },
  ]);

  // The design came back four times and now passes: its first run is not a second one, though
  // the attempt it runs was opened by the last return.
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
  assert.deepEqual([experiment.workflow.state, experiment.attempt.previousIndex], ['running', 4]);
  const runner = await f.app.ctx.sessions.authenticate(await f.offer(experiment));
  assert.deepEqual(node(await f.board(), work(experiment.id))?.lines, [['Running']]);

  // Retried after an interruption, it runs again.
  await f.app.ctx.sessions.dispatch.halt(f.operator, { sessionId: runner.session!.id });
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

test('an experiment naming a review Reviews does not hold is drawn without it, and the rest of the lane with it', async (t) => {
  const f = await assembled(t);
  const other = await f.create('ablate-depth');
  const dangling = await f.design(await f.create('ablate-retrieval'));
  await f.app.ctx.state.transaction(
    async (tx) =>
      await tx.run('UPDATE experiments SET review_id=? WHERE id=?', 'review_gone', dangling.id),
  );
  const board = await f.board();
  assert.deepEqual(board.lanes.work.failed, []);
  assert.deepEqual(node(board, work(dangling.id))?.lines, [['Design review']]);
  assert.equal(node(board, work(dangling.id))?.attention, undefined);
  assert.ok(node(board, work(other.id)), 'the other experiment is drawn');
});

test('a planned experiment’s sidebar draws its ladder without running a check, so no artifact is read', async (t) => {
  const f = await assembled(t);
  const experiment = await f.create('weight-decay');
  const feasibility = await f.attach(experiment, 'feasibility', 'feasibility.json');
  const written = await f.attach(experiment, 'plan', 'design/plan.md');
  // Every byte read, artifact.read's included, goes through bytes().
  const reads = t.mock.method(f.app.ctx.artifacts, 'bytes');
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
      ['Code', 'code', 'facts'],
      ['Question', 'content', 'text'],
      ['Evidence', 'content', 'links'],
      ['Details', 'details', 'facts'],
    ],
  );
  const [stage, code, question, evidence, details] = sidebar.sections;
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
  // Its files, newest first, each under the stage it was made in and the producer's role.
  assert.deepEqual(
    sidebar.unit?.artifacts?.map((item) => [item.id, item.stage, item.role, item.size]),
    [
      [written.id, 'planned', 'producer', written.size],
      [feasibility.id, 'planned', 'producer', feasibility.size],
    ],
  );
  assert.deepEqual(
    [sidebar.route, sidebar.live, sidebar.actions],
    [`/experiments/${experiment.id}`, false, []],
  );
});

test('evidence under a role the domain no longer writes is listed after every known role', () => {
  const file = (role: string, sequence: number) => ({
    role,
    sequence,
    current: true,
    attemptIndex: 1,
    artifactId: `art_${role}`,
    path: `${role}.md`,
    createdAt: '2026-09-25T10:00:00.000Z',
  });
  const panel = experimentPanel({
    standing: {
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
    },
    experiment: {
      intent: 'Does depth matter?',
      ownerId: 'act_owner',
      attempt: { index: 1 },
      evidence: [file('retired', 1), file('report', 2), file('plan', 3)],
    } as unknown as Experiment,
    graph: { nodes: [{}], edges: [], state: 'planned', dependencies: [] } as never,
    route: () => undefined,
  });
  const evidence = panel.sections.find((section) => section.title === 'Evidence');
  assert.ok(evidence?.kind === 'links');
  assert.deepEqual(
    evidence.rows.map((row) => row.kind),
    ['Plan', 'Report', 'Retired'],
  );
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
      ['No independent reviewer can take it'],
    ],
  );
  assert.equal(
    experimentNode({ ...base, state: 'experiment_review', review: { waiting: 'x' } as never })
      .attention?.who,
    'An operator provides one.',
  );
  // A failed prerequisite outranks a missing reviewer; rounds used up are Workflows' mark.
  assert.deepEqual(
    face({
      state: 'design_review',
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
  assert.deepEqual(face({ state: 'failed' }), [['Failed'], 'quiet', null]);
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
