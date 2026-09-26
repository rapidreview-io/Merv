import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  Artifact,
  Caller,
  ReviewApplication,
  RunningBoard,
  RunningNode,
  RunningPanel,
  RunningSection,
} from '@merv/contracts';
import type { RunningContribution } from '@merv/ui';
import { RunningRegistry, runningBoard, runningPanel, type RunningSources } from '@merv/ui/running';
import type { ChangeSpec, Reflection } from '../packages/reflections/src/types.js';
import { waveNode, wavePanel } from '../packages/reflections/src/running.js';
import { createApp } from './fixtures/app.js';

/**
 * Reflections on the Running page, read through the assembled application: the open wave is
 * one node heading the work lane with its lenses folded into it, and its sidebar is the wave's.
 * Review may send a wave back once here, so the second submission uses the returns up.
 */

const token = () => `ms_${randomBytes(32).toString('base64url')}`;
const earliest = (instants: string[]) =>
  instants.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-running-reflections-'));
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
            : entry.id === 'reflections'
              ? { ...entry, config: { limits: { reviewReturns: 1 } } }
              : entry,
      ) as never,
    },
  });
  t.after(() => app.stop());
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Running', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const actor = async (
    name: string,
    role: 'producer' | 'reviewer' | 'operator' | 'reader' = 'producer',
  ) => {
    const issued = await app.ctx.scope.issueActor(owner, { name, role });
    return {
      projectId: owner.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    } as Caller;
  };
  const board = async (caller: Caller) =>
    (await app.ctx.tools.call('ui.running', caller, {})) as RunningBoard;
  const panel = async (caller: Caller, key: string) =>
    (await app.ctx.tools.call('ui.running_panel', caller, { key })) as RunningPanel;
  const text = async (caller: Caller, title: string) =>
    await app.ctx.artifacts.create(caller, {
      title,
      content: `# Summary\n${title}: a source-linked observation.\n# Evidence\nNo empirical claim.`,
    });
  const lenses = async (wave: Reflection) => {
    for (const lens of wave.lenses) {
      const author = await actor(`Lens ${lens.perspective}`);
      await app.ctx.reflections.submitLens(author, {
        lensId: lens.id,
        artifactId: (await text(author, lens.perspective)).id,
        expectedRevision: lens.workflow.revision,
        requestId: `lens-${lens.id}`,
      });
    }
    return await app.ctx.reflections.get(owner, wave.id);
  };
  const synthesize = async (wave: Reflection, changes: Artifact) =>
    await app.ctx.reflections.submit(owner, {
      reflectionId: wave.id,
      reportArtifactId: (await text(owner, 'Synthesis')).id,
      changeSpecArtifactId: changes.id,
      expectedRevision: wave.workflow.revision,
      requestId: `synthesis-${wave.workflow.revision}`,
    });
  const verdict = async (wave: Reflection, reviewer: Caller, pass: boolean) => {
    const open = await app.ctx.reviews.get(reviewer, wave.review!.id);
    const review =
      open.status === 'started' ? open : await app.ctx.reviews.start(reviewer, open.id);
    const input: ReviewApplication = {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: wave.workflow.revision,
      verdict: pass ? 'pass' : 'needs_changes',
      ...(pass ? {} : { returnTo: 'synthesizing' }),
      notes: 'Verified the frozen sources and lens outputs.',
      synopsis: pass
        ? 'The synthesis holds against every lens report after independent verification.'
        : 'The synthesis drops the negative ablation result that two lenses reported.',
      findings: review.criteria.map((_, i) => ({
        criterionNumber: i + 1,
        status: pass ? 'met' : 'not_met',
        evidenceIds: [review.artifactIds[0]!],
        notes: 'Checked against the lens reports.',
      })),
      requestId: `verdict-${review.id}`,
    };
    return (await app.ctx.reviews.apply(reviewer, input)) as Reflection;
  };
  return { app, owner, actor, board, panel, text, lenses, synthesize, verdict };
}

const keyOf = (id: string) => `work:${id}`;
const lensKeys = (wave: Reflection) => wave.lenses.map((lens) => keyOf(lens.id));
const drawn = (answer: RunningBoard, wave: Reflection) =>
  answer.lanes.work.nodes.find((node) => node.key === keyOf(wave.id));
const own = (answer: RunningPanel) =>
  answer.sections.filter((section) => section.owner === 'reflections');
const titles = (answer: RunningPanel) => own(answer).map((section) => section.title);
const section = <K extends RunningSection['kind']>(answer: RunningPanel, title: string, kind: K) =>
  own(answer).find((entry) => entry.title === title && entry.kind === kind) as Extract<
    RunningSection,
    { kind: K }
  >;

test('an open wave is one node at the head of the work lane that absorbs its lenses, for an operator and a reader alike', async (t) => {
  const f = await fixture(t);
  const reader = await f.actor('Reader', 'reader');
  const wave = await f.app.ctx.reflections.create(f.owner, {
    title: 'Retrieval depth: reflection',
    requestId: 'wave',
  });
  for (const caller of [f.owner, reader]) {
    const answer = await f.board(caller);
    assert.ok(!answer.lanes.work.failed.includes('reflections'));
    assert.deepEqual(drawn(answer, wave), {
      key: keyOf(wave.id),
      lane: 'work',
      kind: 'Reflection',
      title: 'Retrieval depth: reflection',
      lines: [
        [
          'Lenses ',
          { count: 0, of: 5 },
          ' · waiting ',
          { since: earliest(wave.lenses.map((lens) => lens.workflow.updatedAt)) },
        ],
      ],
      look: 'dashed',
      aliases: lensKeys(wave),
      rank: -1,
      owner: 'reflections',
    });
    // Its lenses are never drawn: every one of their keys lands on the wave.
    const keys = Object.values(answer.lanes).flatMap(({ nodes }) => nodes.map(({ key }) => key));
    assert.ok(lensKeys(wave).every((key) => !keys.includes(key)));
    assert.equal(answer.lanes.work.nodes[0]!.key, keyOf(wave.id));
  }
  // A lens's key is drawn by its wave, so no sidebar is its own.
  assert.equal(await f.app.ctx.reflections.runningPanel(f.owner, wave.lenses[0]!.id), null);
  assert.equal(await f.app.ctx.reflections.runningPanel(f.owner, 'wf_nothing'), null);
  await assert.rejects(f.panel(f.owner, keyOf(wave.lenses[0]!.id)), {
    code: 'running_not_found',
  });
  await assert.rejects(f.app.ctx.reflections.process(f.owner, wave.lenses[0]!.id), {
    code: 'reflection_not_found',
  });
  assert.equal((await f.app.ctx.reflections.process(f.owner, wave.id)).state, 'reflecting');
});

test('a lens with an agent makes the wave solid and its row the way to that session, and letting it go restarts its wait', async (t) => {
  const f = await fixture(t);
  const wave = await f.app.ctx.reflections.create(f.owner, { title: 'Wave', requestId: 'wave' });
  const [first, ...rest] = wave.lenses;
  const secret = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Lens agent',
    runnerId: 'external',
    requestId: 'agent',
    secret,
  });
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: first!.id,
    expectedRevision: 0,
    requestId: 'assign-lens',
  });
  const held = ['Lenses ', { count: 0, of: 5 }, ' · ', '1 with an agent'];
  const node = drawn(await f.board(f.owner), wave)!;
  assert.deepEqual([node.lines, node.look], [[held], 'solid']);
  // The dot is the board's, from the sessions on the wave, never the owner's.
  assert.equal((await f.app.ctx.reflections.running(f.owner))[0]!.dot, undefined);

  let sidebar = await f.panel(f.owner, keyOf(wave.id));
  assert.deepEqual(sidebar.header, { kind: 'Reflection', title: 'Wave', says: held });
  assert.deepEqual(
    [sidebar.route, sidebar.live, sidebar.aliases, sidebar.actions],
    [`/reflections/${wave.id}`, true, lensKeys(wave), []],
  );
  assert.deepEqual(titles(sidebar), ['Stages', 'Holds up', 'Lenses']);
  assert.equal(section(sidebar, 'Stages', 'ladder').graph.state, 'reflecting');
  assert.deepEqual(section(sidebar, 'Holds up', 'facts').rows, [
    { label: 'New tasks and experiments', value: ['Paused'] },
  ]);
  const table = section(sidebar, 'Lenses', 'table');
  assert.deepEqual(
    [table.columns, table.aside],
    [['Perspective', 'Standing'], [{ count: 0, of: 5 }]],
  );
  assert.deepEqual(table.rows[0], {
    cells: [[first!.perspective], ['With an agent']],
    to: { key: `session:${execution.id}` },
  });
  assert.deepEqual(
    table.rows.slice(1).map(({ cells }) => cells),
    rest.map((lens) => [
      [lens.perspective.replaceAll('_', ' ')],
      ['Waiting ', { since: lens.workflow.updatedAt }],
    ]),
  );
  assert.ok(table.rows.some(({ cells }) => cells[0]![0] === 'next steps'));

  // A lease let go leaves the revision where it was, so the lens has waited since then.
  await f.app.ctx.sessions.releaseAgentAssignment(secret, execution.id);
  const [{ released_at: released }] = await f.app.ctx.state.transaction(
    async (tx) =>
      await tx.all<{ released_at: string }>(
        'SELECT released_at FROM reflection_leases WHERE id=?',
        execution.id,
      ),
  );
  assert.ok(Date.parse(released) > Date.parse(first!.workflow.updatedAt));
  sidebar = await f.panel(f.owner, keyOf(wave.id));
  assert.equal(sidebar.live, false);
  assert.deepEqual(section(sidebar, 'Lenses', 'table').rows[0], {
    cells: [[first!.perspective], ['Waiting ', { since: released }]],
  });
  assert.deepEqual(drawn(await f.board(f.owner), wave)!.lines, [
    [
      'Lenses ',
      { count: 0, of: 5 },
      ' · waiting ',
      { since: earliest(rest.map((lens) => lens.workflow.updatedAt)) },
    ],
  ]);
});

test('synthesis and review read as the wave stands, used-up returns turn it red with the way to its review, and approval takes it off the board', async (t) => {
  const f = await fixture(t);
  const reviewer = await f.actor('Reviewer', 'reviewer');
  let wave = await f.lenses(
    await f.app.ctx.reflections.create(f.owner, { title: 'Wave', requestId: 'wave' }),
  );
  assert.equal(wave.workflow.state, 'synthesizing');
  let node = drawn(await f.board(f.owner), wave)!;
  assert.deepEqual(
    [node.lines, node.look, node.aliases],
    [[['Synthesis · waiting ', { since: wave.workflow.updatedAt }]], 'dashed', lensKeys(wave)],
  );
  assert.deepEqual(titles(await f.panel(f.owner, keyOf(wave.id))), ['Stages', 'Holds up']);

  wave = await f.synthesize(wave, await f.text(f.owner, 'Changes'));
  node = drawn(await f.board(f.owner), wave)!;
  assert.deepEqual(
    [node.lines, node.look],
    [[['Review · waiting for a reviewer ', { since: wave.workflow.updatedAt }]], 'dashed'],
  );
  let sidebar = await f.panel(f.owner, keyOf(wave.id));
  assert.deepEqual(titles(sidebar), ['Stages', 'Holds up', 'Result']);
  // A text change specification proposes no plan, so only the report is named.
  assert.deepEqual(section(sidebar, 'Result', 'facts').rows, [
    {
      label: 'Report',
      value: [{ link: { route: `/artifacts/${wave.report!.id}` }, text: 'Synthesis' }],
    },
  ]);

  await f.app.ctx.reviews.start(reviewer, wave.review!.id);
  node = drawn(await f.board(f.owner), wave)!;
  assert.deepEqual(
    [node.lines, node.look],
    [[['Review · ', { actor: reviewer.actorId, prefix: 'with ', unnamed: 'claimed' }]], 'solid'],
  );
  assert.equal(node.attention, undefined);

  // Sent back as often as the limit allows, the next review waits for a person.
  wave = await f.verdict(wave, reviewer, false);
  assert.equal(wave.workflow.state, 'synthesizing');
  const plan: ChangeSpec = {
    version: 2,
    changes: 'Narrow the scope to the controlled setting.',
    next: { decision: 'continue', name: 'Second wave', rationale: 'The control is cheap.' },
    items: [
      {
        key: 'measure',
        kind: 'task',
        title: 'Build the measurement',
        goal: 'Establish the measurement the experiment needs.',
        checks: ['The measurement is recorded'],
        dependsOn: [],
        rationale: 'The methods lens found it missing.',
        workspace: { provider: 'none' },
      },
      {
        key: 'control',
        kind: 'experiment',
        name: 'controlled-rerun',
        question: 'Does the effect survive the control?',
        details: '',
        dependsOn: ['measure'],
        rationale: 'The evidence lens found the control missing.',
        workspace: { provider: 'none' },
      },
    ],
    carriedOver: [],
    rejected: [],
  };
  wave = await f.synthesize(
    wave,
    await f.app.ctx.artifacts.create(f.owner, {
      title: 'Changes',
      mediaType: 'application/json',
      content: JSON.stringify(plan),
    }),
  );
  const red = {
    says: ['Review returns used up'],
    who: 'An independent reviewer reviews it by hand, or its owner or an operator ends it.',
    to: { route: `/reviews/${wave.review!.id}`, text: 'Open the review' },
  };
  const answer = await f.board(f.owner);
  assert.deepEqual(drawn(answer, wave)!.attention, red);
  assert.equal(answer.lanes.work.nodes[0]!.key, keyOf(wave.id));
  assert.ok(answer.lanes.work.needsYou >= 1);
  sidebar = await f.panel(f.owner, keyOf(wave.id));
  assert.deepEqual(sidebar.header.attention, red);
  assert.deepEqual(section(sidebar, 'Result', 'facts').rows[1], {
    label: 'Plan',
    value: ['Continue · 1 task · 1 experiment'],
  });

  // A reviewer who takes it by hand is the person it waited for.
  await f.app.ctx.reviews.start(reviewer, wave.review!.id);
  node = drawn(await f.board(f.owner), wave)!;
  assert.deepEqual(
    [node.lines, node.attention],
    [[['Review · ', { actor: reviewer.actorId, prefix: 'with ', unnamed: 'claimed' }]], undefined],
  );

  // Approved, the wave has left the board, unless another owner holds it there.
  wave = await f.verdict(wave, reviewer, true);
  assert.equal(wave.workflow.state, 'approved');
  assert.equal(drawn(await f.board(f.owner), wave), undefined);
  for (const key of [keyOf(wave.id), lensKeys(wave)[2]!]) {
    const [held] = await f.app.ctx.reflections.running(f.owner, new Set([key]));
    assert.deepEqual(
      [held!.key, held!.lines, held!.look, held!.attention],
      [keyOf(wave.id), [['Approved']], 'quiet', undefined],
    );
  }
  sidebar = await f.panel(f.owner, keyOf(wave.id));
  assert.deepEqual(
    [titles(sidebar), sidebar.header.says, sidebar.live],
    [['Stages', 'Result'], ['Approved'], false],
  );

  // A stop plan says why, and a title longer than a card holds is cut to fit.
  const graph = await f.app.ctx.reflections.process(f.owner, wave.id);
  const stopped = wavePanel(
    {
      wave: {
        ...wave,
        plan: { ...wave.plan!, next: { decision: 'stop', reason: 'goal_met', rationale: 'Done.' } },
      },
      leases: [],
      exhausted: false,
    },
    graph,
  );
  assert.deepEqual(
    (stopped.sections.find((entry) => entry.title === 'Result') as { rows: unknown[] }).rows[1],
    { label: 'Plan', value: ['Stop · goal met'] },
  );
  const long = waveNode({
    wave: { ...wave, title: 'x'.repeat(300) },
    leases: [],
    exhausted: false,
  });
  assert.equal(long.title.length, 200);
  assert.ok(long.title.endsWith('…'));
});

test('a review leased to an agent says so rather than naming the agent, and letting it go restarts its wait', async (t) => {
  const f = await fixture(t);
  let wave = await f.lenses(
    await f.app.ctx.reflections.create(f.owner, { title: 'Wave', requestId: 'wave' }),
  );
  wave = await f.synthesize(wave, await f.text(f.owner, 'Changes'));
  const secret = token();
  // The owner wrote the synthesis, so the review worker is directed by someone else.
  await f.app.ctx.sessions.registerAgent(await f.actor('Lead', 'operator'), {
    name: 'Review agent',
    runnerId: 'external',
    requestId: 'review-agent',
    secret,
  });
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'review',
  });
  assert.equal(execution.role, 'reviewer');
  // The lease started the review, so its reviewer is the agent.
  const review = await f.app.ctx.reviews.get(f.owner, wave.review!.id);
  assert.deepEqual([review.status, review.reviewerId], ['started', execution.actorId]);
  const reader = await f.actor('Reader', 'reader');
  for (const caller of [f.owner, reader]) {
    const node = drawn(await f.board(caller), wave)!;
    assert.deepEqual([node.lines, node.look], [[['Review · with an agent']], 'solid']);
  }
  let sidebar = await f.panel(f.owner, keyOf(wave.id));
  assert.deepEqual([sidebar.header.says, sidebar.live], [['Review · with an agent'], true]);

  await f.app.ctx.sessions.releaseAgentAssignment(secret, execution.id);
  await f.app.ctx.domainEvents.drain();
  const [{ released_at: released }] = await f.app.ctx.state.transaction(
    async (tx) =>
      await tx.all<{ released_at: string }>(
        'SELECT released_at FROM reflection_leases WHERE id=?',
        execution.id,
      ),
  );
  const node = drawn(await f.board(f.owner), wave)!;
  assert.deepEqual(
    [node.lines, node.look],
    [[['Review · waiting for a reviewer ', { since: released }]], 'dashed'],
  );
  sidebar = await f.panel(f.owner, keyOf(wave.id));
  assert.equal(sidebar.live, false);
});

test('a wave naming a review Reviews does not hold is drawn without it, and the rest of the lane with it', async (t) => {
  const f = await fixture(t);
  const task = await f.app.ctx.tasks.create(await f.actor('Producer'), {
    title: 'Rebuild citation index',
    goal: 'Finish rebuilding the citation index so the draft can cite it.',
    checks: ['Every reference resolves.'],
    requestId: 'task',
  });
  let wave = await f.lenses(
    await f.app.ctx.reflections.create(f.owner, { title: 'Wave', requestId: 'wave' }),
  );
  wave = await f.synthesize(wave, await f.text(f.owner, 'Changes'));
  assert.equal(wave.workflow.state, 'in_review');
  await f.app.ctx.state.transaction(
    async (tx) =>
      await tx.run('UPDATE reflections SET review_id=? WHERE id=?', 'review_gone', wave.id),
  );
  const answer = await f.board(f.owner);
  assert.deepEqual(answer.lanes.work.failed, []);
  const node = drawn(answer, wave);
  assert.equal(node?.lines[0]?.[0], 'Review · waiting for a reviewer ');
  assert.equal(node?.attention, undefined);
  assert.ok(
    answer.lanes.work.nodes.some(({ key }) => key === keyOf(task.id)),
    'the task is drawn beside it',
  );
  const sidebar = await f.panel(f.owner, keyOf(wave.id));
  assert.equal(sidebar.header.title, 'Wave');
});

test('a wave begun before version 4 cannot be ended, so its red asks for a review by hand or another round', async (t) => {
  const f = await fixture(t);
  const reviewer = await f.actor('Reviewer', 'reviewer');
  let wave = await f.app.ctx.reflections.create(f.owner, { title: 'Wave', requestId: 'wave' });
  // As production holds it: a wave started before version 4, with version-2 lenses.
  await f.app.ctx.state.transaction(async (tx) => {
    await tx.run('UPDATE wf_instances SET version=3 WHERE id=?', wave.id);
    for (const lens of wave.lenses)
      await tx.run('UPDATE wf_instances SET version=2 WHERE id=?', lens.id);
  });
  wave = await f.synthesize(await f.lenses(wave), await f.text(f.owner, 'Changes'));
  wave = await f.verdict(wave, reviewer, false);
  wave = await f.synthesize(wave, await f.text(f.owner, 'Changes again'));
  assert.deepEqual([wave.workflow.version, wave.workflow.state], [3, 'in_review']);
  const red = {
    says: ['Review returns used up'],
    who: 'An independent reviewer reviews it by hand, or an operator allows another round.',
    to: { route: `/reviews/${wave.review!.id}`, text: 'Open the review' },
  };
  assert.deepEqual(drawn(await f.board(f.owner), wave)!.attention, red);
  assert.deepEqual((await f.panel(f.owner, keyOf(wave.id))).header.attention, red);
  await assert.rejects(
    f.app.ctx.reflections.end(f.owner, {
      reflectionId: wave.id,
      expectedRevision: wave.workflow.revision,
      reason: 'Version 3 has no ending.',
      requestId: 'end',
    }),
    { code: 'invalid_transition' },
  );

  // The move it names is one an operator can make, and it lifts the red.
  await f.app.ctx.workflows.extendLimit(f.owner, {
    instanceId: wave.id,
    limit: 'review_returns',
    additional: 1,
    reason: 'One more round to restore the ablation result.',
    requestId: 'another-round',
  });
  const node = drawn(await f.board(f.owner), wave)!;
  assert.deepEqual(
    [node.lines, node.attention],
    [[['Review · waiting for a reviewer ', { since: wave.workflow.updatedAt }]], undefined],
  );
});

test('a review no eligible reviewer can take turns the wave red until an operator provides one', async (t) => {
  const f = await fixture(t);
  let wave = await f.lenses(
    await f.app.ctx.reflections.create(f.owner, { title: 'Wave', requestId: 'wave' }),
  );
  wave = await f.synthesize(wave, await f.text(f.owner, 'Changes'));
  assert.equal(wave.workflow.state, 'in_review');
  // Reviews' own signal, which review.get gives an operator alone, as it does for a task: its
  // Review section says why in ink, and the wave carries the red and whose move it is.
  const waiting = {
    ...wave.review!,
    waiting:
      'Every eligible reviewer is a retained contributor or directing authority. An operator must provide an independent reviewer.',
  };
  const facts = { wave: { ...wave, review: waiting }, leases: [], exhausted: false };
  const red = {
    says: ['No independent reviewer can take it'],
    who: 'An operator provides one.',
    to: { route: `/reviews/${wave.review!.id}`, text: 'Open the review' },
  };
  const node = waveNode(facts);
  assert.deepEqual(node.attention, red);
  assert.deepEqual(node.lines, [
    ['Review · waiting for a reviewer ', { since: wave.workflow.updatedAt }],
  ]);
  const graph = await f.app.ctx.reflections.process(f.owner, wave.id);
  assert.deepEqual(wavePanel(facts, graph).header.attention, red);
  // Returns used up name the move that ends both waits; with no signal there is no red.
  assert.deepEqual(waveNode({ ...facts, exhausted: true }).attention!.says, [
    'Review returns used up',
  ]);
  assert.equal(waveNode({ ...facts, wave }).attention, undefined);
  // Only a wave still in review waits for a reviewer.
  const approved = { ...wave.workflow, state: 'approved' };
  assert.equal(
    waveNode({ ...facts, wave: { ...facts.wave, workflow: approved } }).attention,
    undefined,
  );
});

test('an ended wave leaves the board and its sidebar keeps only its stages', async (t) => {
  const f = await fixture(t);
  let wave = await f.app.ctx.reflections.create(f.owner, { title: 'Wave', requestId: 'wave' });
  wave = await f.app.ctx.reflections.end(f.owner, {
    reflectionId: wave.id,
    expectedRevision: wave.workflow.revision,
    reason: 'No five independent lens authors can be found.',
    requestId: 'end',
  });
  assert.equal(wave.workflow.state, 'abandoned');
  assert.equal(drawn(await f.board(f.owner), wave), undefined);
  const [held] = await f.app.ctx.reflections.running(f.owner, new Set([keyOf(wave.id)]));
  assert.deepEqual([held!.lines, held!.look], [[['Ended']], 'quiet']);
  const sidebar = await f.panel(f.owner, keyOf(wave.id));
  assert.deepEqual([titles(sidebar), sidebar.header.says], [['Stages'], ['Ended']]);
});

test('on the board a session on a lens lands on its wave, and a mark on a lens colours the wave', async (t) => {
  const f = await fixture(t);
  const wave = await f.app.ctx.reflections.create(f.owner, { title: 'Wave', requestId: 'wave' });
  const [first, second] = wave.lenses;
  const held = {
    says: ['Held after 5 failed launches'],
    who: 'A signed-in operator',
  };
  let asked: readonly string[] = [];
  const sessions: RunningContribution = {
    owner: 'sessions',
    kinds: ['session'],
    lanes: ['sessions'],
    marks: async () => [{ key: keyOf(second!.id), ...held }],
    nodes: async () => ({
      nodes: [
        {
          key: 'session:lens-agent',
          lane: 'sessions',
          title: 'Lens agent',
          lines: [],
          look: 'solid',
          dot: 'live',
          links: [{ to: keyOf(first!.id), verb: 'works on' }],
        } satisfies RunningNode,
      ],
    }),
    sections: async (_read, keys) => ((asked = keys), []),
  };
  // The real reflections part, beside a stand-in for Sessions, read as the tool reads them.
  const registry = new RunningRegistry();
  registry.contribute(sessions);
  registry.contribute(f.app.ctx.ui.contributions().find(({ owner }) => owner === 'reflections')!);
  const sources: RunningSources = {
    contributions: () => registry.contributions(),
    tools: async () => [],
    isolated: async (read) => await f.app.ctx.state.isolated(read),
  };
  const answer = await f.app.ctx.state.snapshot(async () => await runningBoard(sources, f.owner));
  assert.deepEqual(answer.edges, [
    { from: 'session:lens-agent', to: keyOf(wave.id), verb: 'works on', waiting: false },
  ]);
  const node = drawn(answer, wave)!;
  assert.deepEqual([node.attention, node.dot], [held, 'live']);
  assert.deepEqual(answer.lanes.work.failed, []);
  assert.equal(answer.lanes.work.needsYou, 1);

  // Other owners are asked about the wave and every lens it absorbed.
  const sidebar = await f.app.ctx.state.snapshot(
    async () => await runningPanel(sources, f.owner, keyOf(wave.id)),
  );
  assert.deepEqual(asked, [keyOf(wave.id), ...lensKeys(wave)]);
  assert.deepEqual(sidebar.aliases, lensKeys(wave));
});
