import type { Caller, ReviewApplication } from '@merv/contracts';
import { createService } from '@merv/contracts';
import type { ChangeSpec, Reflection } from '@merv/reflections/types';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ResearchService } from '../packages/research/src/index.js';
import type { ResearchDigest, ResearchRecord } from '../packages/research/src/types.js';
import { createApp } from './fixtures/app.js';
import { deliverCurrentTask } from './fixtures/current-task-delivery.js';
import { currentTask } from './fixtures/current-work.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { hostedCode, providersOf, type Main } from './fixtures/research.js';

async function fixture(t: TestContext, store = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-research-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins = config.plugins.filter(
    (entry: { id: string }) =>
      !['api', 'identity', 'ui', 'research', 'research-tools', 'research-ui'].includes(entry.id) &&
      !entry.id.endsWith('-api') &&
      !entry.id.endsWith('-ui'),
  );
  let app = await createApp({ directory, config });
  const service = async () =>
    await createService(
      new ResearchService(app.ctx.state, app.ctx.scope, app.ctx.workflows, providersOf(app.ctx)),
    );
  let research = await service(),
    sequence = 0;
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Research cycle',
    actorName: 'Coordinator',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const id = () => `research-test-${++sequence}`;
  const issue = async (role: 'producer' | 'reviewer' | 'reader' | 'operator') => {
    const record = await app.ctx.scope.credentials.issueActor(owner, { name: id(), role });
    return {
      projectId: owner.projectId,
      actorId: record.actor.id,
      credentialId: record.credential.id,
    };
  };
  const reviewer = await issue('reviewer');
  const taskReviewer = await issue('operator');
  const artifact = async (caller: Caller, title: string) =>
    await app.ctx.artifacts.create(caller, {
      title,
      content: `# Summary\n${title} follows the approved sources.\n# Evidence\nNo empirical result is asserted without retained support.`,
    });
  const definition = async () =>
    await app.ctx.paper.patch(owner, {
      kind: 'problem',
      expectedRevision: (await app.ctx.paper.read(owner)).documents.problem.current.revision,
      requestId: id(),
      changes: [
        { id: 'problem', content: 'Can this comparison be evaluated reliably?' },
        { id: 'scope', content: 'A bounded local comparison.' },
        { id: 'goals', content: 'Retain independently verified evidence.' },
        { id: 'constraints', content: 'Use only the frozen available corpus.' },
      ],
    });
  const create = async () =>
    await research.create(owner, { name: 'Research loop', requestId: id() });
  const advance = async (record: ResearchRecord) =>
    await research.advance(owner, {
      researchId: record.id,
      expectedRevision: record.workflow.revision,
      requestId: id(),
    });
  const review = async (reviewId: string, expectedRevision: number) => {
    const claim = await app.ctx.reviews.start(reviewer, reviewId);
    const input: ReviewApplication = {
      reviewId,
      claimId: claim.claimId!,
      expectedRevision,
      verdict: 'pass',
      notes: 'Checked the exact frozen inputs and retained outputs independently.',
      synopsis:
        'The retained submission follows its frozen sources and satisfies all required checks.',
      findings: claim.criteria.map((_, i) => ({
        criterionNumber: i + 1,
        status: 'met',
        evidenceIds: [claim.artifactIds[0]],
        notes: 'Verified against retained evidence.',
      })),
      requestId: id(),
    };
    return await app.ctx.reviews.apply(reviewer, input);
  };
  const reflect = async (record: ResearchRecord, plan?: ChangeSpec) => {
    let wave = await app.ctx.reflections.get(owner, record.reflectionId!);
    for (const lens of wave.lenses) {
      const worker = await issue('producer');
      await app.ctx.reflections.submitLens(worker, {
        lensId: lens.id,
        artifactId: (await artifact(worker, lens.perspective)).id,
        expectedRevision: lens.workflow.revision,
        requestId: id(),
      });
    }
    wave = await app.ctx.reflections.get(owner, wave.id);
    wave = await app.ctx.reflections.submit(owner, {
      reflectionId: wave.id,
      reportArtifactId: (await artifact(owner, 'Report')).id,
      changeSpecArtifactId: plan
        ? (
            await app.ctx.artifacts.create(owner, {
              title: 'Change specification',
              content: JSON.stringify(plan),
              mediaType: 'application/json',
            })
          ).id
        : (await artifact(owner, 'Change specification')).id,
      expectedRevision: wave.workflow.revision,
      requestId: id(),
    });
    return (await review(wave.review!.id, wave.workflow.revision)) as Reflection;
  };
  /** A current Git task delivered and reviewed by distinct workers. */
  const finish = async (taskId: string) => {
    await deliverCurrentTask(app.ctx, directory, owner, taskId, taskReviewer);
  };
  t.after(async () => {
    research.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    get research() {
      return research;
    },
    owner,
    reviewer,
    id,
    issue,
    definition,
    create,
    advance,
    artifact,
    reflect,
    finish,
    /**
     * Code unloaded or loaded again, and with it Tasks and Experiments, which require it; this
     * service holds the providers it was handed.
     */
    async code(enabled: boolean) {
      await app.setEnabled('code', enabled);
      if (enabled) Object.assign(research.providers, providersOf(app.ctx));
    },
    async restart() {
      research.close();
      await app.stop();
      app = await createApp({ directory, config });
      research = await service();
    },
  };
}

/**
 * A version-6 cycle whose reflection is approved, with Code answering for a hosted project
 * whose main lacks `unitIds`. Returns the cycle, the units marked to publish, and an advance
 * that carries the choices given.
 */
async function hosted(f: Awaited<ReturnType<typeof fixture>>, main: Main) {
  await f.definition();
  let record = await f.advance(await f.advance(await f.create()));
  await f.reflect(record);
  record = await f.research.get(f.owner, record.id);
  const published = hostedCode(f.research, f.app.ctx, f.owner, main);
  const advance = async (choice: { retryIntegration?: boolean } = {}) =>
    await f.research.advance(f.owner, {
      researchId: record.id,
      expectedRevision: (await f.research.get(f.owner, record.id)).workflow.revision,
      requestId: f.id(),
      ...choice,
    });
  return { record, published, advance };
}
/** A finished task standing for accepted code main lacks. */
const work = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const task = await currentTask(f.app.ctx, f.owner, {
    title: 'Accepted work',
    goal: 'Deliver code main will need.',
    checks: ['It is delivered'],
    requestId: f.id(),
  });
  await f.finish(task.id);
  return task;
};

test('accepted code main lacks injects one consolidation task marked to publish, and the cycle waits on it', async (t) => {
  const f = await fixture(t);
  const accepted = await work(f);
  const { record, published, advance } = await hosted(f, {
    unitIds: [accepted.id],
    quarantined: ['wf_quarantined'],
  });
  const input = {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: f.id(),
  };
  const moved = await f.research.advance(f.owner, input);
  assert.equal(moved.workflow.state, 'consolidating');
  assert.equal(moved.integrations.length, 1);
  const [taskId] = moved.integrations;
  assert.deepEqual(published, [taskId]);
  const task = await f.app.ctx.tasks.get(f.owner, taskId);
  assert.equal(task.title, 'Research loop: consolidation');
  assert.match(task.goal, /^Integrate this cycle's accepted work onto one branch\./);
  const approved = (await f.app.ctx.reflections.approved(f.owner, record.reflectionId!))!;
  assert.ok(
    task.goal.endsWith(
      `Origin: reflection ${approved.id}, report ${approved.report.id} (${approved.report.hash}), change specification ${approved.changeSpec.id} (${approved.changeSpec.hash}).`,
    ),
  );
  assert.equal(task.checks.length, 3);
  assert.deepEqual(
    (await f.app.ctx.workflows.prerequisites(f.owner, [taskId])).get(taskId)!.map((d) => d.id),
    [accepted.id],
  );
  // The task is a child the cycle waits on, not part of the wave it reflected over.
  assert.ok(
    (await f.app.ctx.workflows.prerequisites(f.owner, [record.id]))
      .get(record.id)!
      .some((d) => d.id === taskId),
  );
  assert.deepEqual(moved.researchDependencies, []);
  assert.deepEqual(
    (await advanced(f, record.id)).at(-1).quarantined,
    ['wf_quarantined'],
    'what was left out is on the record',
  );
  assert.deepEqual(await f.research.advance(f.owner, input), moved);
  assert.equal(published.length, 1);
  await assert.rejects(advance(), { code: 'dependencies_pending' });
});

test('a published integration completes without the legacy Consolidation plugin and names its task', async (t) => {
  const f = await fixture(t);
  const accepted = await work(f);
  const main: Main = { unitIds: [accepted.id] };
  const { advance } = await hosted(f, main);
  assert.ok(!f.app.status().some(({ id }) => id.startsWith('consolidation')));
  const [taskId] = (await advance()).integrations;
  await f.finish(taskId);
  main.publication = { blockers: [], state: 'published', mergeCommit: 'c'.repeat(40) };
  const done = await advance();
  assert.equal(done.workflow.state, 'complete');
  assert.deepEqual((await digestOf(f, done)).digest.integration, {
    taskId,
    publication: 'published',
  });
});

const digestOf = async (f: Awaited<ReturnType<typeof fixture>>, record: ResearchRecord) => {
  const read = await f.app.ctx.artifacts.read(f.owner, record.digest!.id);
  assert.equal(read.artifact.mediaType, 'application/json');
  assert.ok(read.content.length <= 12000);
  return { digest: JSON.parse(read.content) as ResearchDigest, content: read.content };
};

test('research owner authorization, project scoping, selected prerequisite success and request replay survive restart', async (t) => {
  const f = await fixture(t);
  await f.definition();
  const handle = await f.app.ctx.workflows.register(
    {
      name: 'research-test-prerequisite',
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'finish', to: 'done' }],
    },
    {
      successStates: ['done'],
      actions: [
        {
          name: 'finish',
          states: ['working'],
          transitions: ['finish'],
          tool: 'test.finish',
          instruction: 'Finish.',
          check: async () => {},
        },
      ],
    },
  );
  const selected = await handle.start(f.owner, {
    workflow: 'research-test-prerequisite',
    requestId: f.id(),
  });
  const input = { name: 'Selected work', dependsOn: [selected.id], requestId: f.id() };
  let record = await f.research.create(f.owner, input);
  assert.deepEqual(await f.research.create(f.owner, input), record);
  await assert.rejects(
    async () => await f.research.create(f.owner, { ...input, name: 'Different' }),
    {
      code: 'request_conflict',
    },
  );
  await assert.rejects(
    async () =>
      await f.research.advance(await f.issue('producer'), {
        researchId: record.id,
        expectedRevision: 0,
        requestId: f.id(),
      }),
    { code: 'forbidden' },
  );
  await assert.rejects(
    async () =>
      await f.research.advance(await f.issue('reader'), {
        researchId: record.id,
        expectedRevision: 0,
        requestId: f.id(),
      }),
    { code: 'forbidden' },
  );
  // Each reader is told whether Research would take its move, so a page offers none it refuses.
  const producer = await f.issue('producer');
  assert.equal(record.writable, true);
  assert.equal((await f.research.get(producer, record.id)).writable, false);
  assert.equal((await f.research.get(await f.issue('reader'), record.id)).writable, false);
  const own = await f.research.create(producer, { name: 'Own cycle', requestId: f.id() });
  assert.equal(own.writable, true);
  assert.deepEqual(
    (await f.research.list(producer)).map((item) => [item.name, item.writable]),
    [
      ['Selected work', false],
      ['Own cycle', true],
    ],
  );
  const other = await f.app.ctx.scope.credentials.bootstrap({
    projectName: 'Another project',
    actorName: 'Another owner',
  });
  const foreign = { projectId: other.project.id, actorId: other.actor.id };
  await assert.rejects(async () => await f.research.get(foreign, record.id), {
    code: 'research_not_found',
  });
  assert.deepEqual(await f.research.list(foreign), []);
  record = await f.advance(record);
  assert.equal(record.workflow.state, 'researching');
  await assert.rejects(async () => await f.advance(record), { code: 'dependencies_pending' });
  // The owner reselects the cycle's work: a second prerequisite joins, then leaves again.
  const spare = await handle.start(f.owner, {
    workflow: 'research-test-prerequisite',
    requestId: f.id(),
  });
  const replan = async (dependsOn: string[]) =>
    await f.research.replan(f.owner, {
      researchId: record.id,
      expectedRevision: (await f.research.get(f.owner, record.id)).workflow.revision,
      dependsOn,
      requestId: f.id(),
    });
  await assert.rejects(
    async () =>
      await f.research.replan(await f.issue('producer'), {
        researchId: record.id,
        expectedRevision: record.workflow.revision,
        dependsOn: [],
        requestId: f.id(),
      }),
    { code: 'forbidden' },
  );
  const widened = await replan([selected.id, spare.id]);
  assert.deepEqual(widened.progress, { settled: 0, total: 2 });
  assert.deepEqual(
    (await f.app.ctx.workflows.prerequisites(f.owner, [record.id]))
      .get(record.id)!
      .map((item) => item.id)
      .sort(),
    [selected.id, spare.id].sort(),
  );
  record = await replan([selected.id]);
  assert.equal(record.workflow.revision, widened.workflow.revision + 1);
  // The record reports the live selection, and a repeated replan replays its answer.
  assert.deepEqual(record.researchDependencies, [selected.id]);
  const again = {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    dependsOn: [],
    requestId: f.id(),
  };
  assert.deepEqual(
    await f.research.replan(f.owner, again),
    await f.research.replan(f.owner, again),
  );
  record = await replan([selected.id]);
  assert.deepEqual(
    (await f.app.ctx.workflows.prerequisites(f.owner, [record.id]))
      .get(record.id)!
      .map((i) => i.id),
    [selected.id],
  );
  await handle.transition(f.owner, {
    instanceId: selected.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: f.id(),
  });
  const advance = {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: f.id(),
  };
  const reflecting = await f.research.advance(f.owner, advance);
  // Progress counts the selected work that ended well, and never the cycle's own wave.
  assert.deepEqual(reflecting.progress, { settled: 1, total: 1 });
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 1);
  assert.deepEqual(await f.research.advance(f.owner, advance), reflecting);
  await assert.rejects(
    async () => await f.research.advance(f.owner, { ...advance, requestId: f.id() }),
    {
      code: 'revision_conflict',
    },
  );
  handle.dispose();
  await f.restart();
  assert.deepEqual(await f.research.get(f.owner, record.id), reflecting);
  assert.deepEqual(await f.research.advance(f.owner, advance), reflecting);
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 1);
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run('UPDATE research_cycles SET reflection_id=? WHERE id=?', 'other', record.id),
      ),
    { code: 'state_constraint' },
  );
});

test('outer advance rolls back both child creation and replay receipts when caller transaction aborts', async (t) => {
  const f = await fixture(t);
  await f.definition();
  let record = await f.advance(await f.create());
  const input = {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: f.id(),
  };
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(async (tx) => {
        await f.research.advance(f.owner, input, tx);
        throw new Error('caller rollback');
      }),
    /caller rollback/,
  );
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 0);
  assert.equal((await f.research.get(f.owner, record.id)).workflow.state, 'researching');
  record = await f.research.advance(f.owner, input);
  assert.equal(record.workflow.state, 'reflecting');
  assert.equal((await f.app.ctx.reflections.list(f.owner)).length, 1);
});

const planned = (
  overrides: Partial<Extract<ChangeSpec, { version: 3 }>> = {},
): Extract<ChangeSpec, { version: 3 }> => ({
  version: 3,
  changes: 'Narrow the comparison to the retained corpus and test the ordering effect directly.',
  next: {
    decision: 'continue',
    name: 'Ordering effect',
    rationale: 'The lenses agree it is open.',
  },
  items: [
    {
      key: 'corpus',
      kind: 'task',
      title: 'Freeze the comparison corpus',
      goal: 'Select and freeze the documents the ordering experiment will read.',
      checks: ['The corpus manifest is retained as an artifact'],
      dependsOn: [],
      rationale: 'The evidence lens found the corpus drifting between runs.',
    },
    {
      key: 'harness',
      kind: 'task',
      title: 'Show the harness runs on one document',
      goal: 'Run the harness end to end on a single document.',
      checks: ['One complete run is retained'],
      dependsOn: [],
      rationale: 'Cheap feasibility before the experiment spends compute.',
    },
    {
      key: 'ordering',
      kind: 'experiment',
      name: 'ordering-effect',
      question: 'Does input ordering change the ranking?',
      details: '',

      dependsOn: ['corpus', 'harness'],
      rationale: 'The method lens named ordering as the untested confound.',
    },
    {
      key: 'writeup',
      kind: 'task',
      title: 'Write up the ordering result',
      goal: 'Summarise what the ordering experiment showed.',
      checks: ['The summary cites the experiment'],
      dependsOn: ['ordering'],
      rationale: 'The result must reach the paper.',
    },
  ],
  carriedOver: [],
  rejected: [{ title: 'A larger corpus', reason: 'Nothing suggests size is the limit.' }],
  ...overrides,
});
/** A no-consolidation cycle whose approved reflection carries the plan, ready to complete. */
async function reflected(f: Awaited<ReturnType<typeof fixture>>, plan: ChangeSpec) {
  await f.definition();
  let record = await f.advance(await f.advance(await f.create()));
  await f.reflect(record, plan);
  record = await f.research.get(f.owner, record.id);
  const command = (nextWave?: 'create' | 'skip') => ({
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: f.id(),
    ...(nextWave ? { nextWave } : {}),
  });
  return { record, command };
}
const counts = async (f: Awaited<ReturnType<typeof fixture>>) => ({
  tasks: (await f.app.ctx.tasks.list(f.owner)).length,
  experiments: (await f.app.ctx.experiments.list(f.owner)).length,
  cycles: (await f.research.list(f.owner)).length,
});
const advanced = async (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  (
    await f.app.ctx.state.read(
      async (sql) =>
        await sql.all<{ data_json: string }>(
          "SELECT data_json FROM events WHERE type='research.advanced' AND subject_id=? ORDER BY id",
          id,
        ),
    )
  ).map((row) => JSON.parse(row.data_json));

const harnessPlan = (): Extract<ChangeSpec, { version: 3 }> => ({
  ...planned(),
  items: planned()
    .items.slice(0, 3)
    .map((item) => ({ ...item, dependsOn: item.kind === 'experiment' ? ['harness'] : [] })),
});

test('a plan creates only managed Git work atomically and replayably', async (t) => {
  const f = await fixture(t);
  const { record, command } = await reflected(f, harnessPlan());
  const before = await counts(f);
  const input = command('create');
  await assert.rejects(
    f.app.ctx.state.transaction(async (tx) => {
      const done = await f.research.advance(f.owner, input, tx);
      assert.ok(done.successorId);
      throw new Error('caller rollback');
    }),
    { code: 'integration_candidates_unavailable' },
  );
  assert.deepEqual(await counts(f), before);
  const rolledBack = await f.research.get(f.owner, record.id);
  assert.equal(rolledBack.successorId, null);
  assert.equal(rolledBack.workflow.state, 'reflecting');
  const done = await f.research.advance(f.owner, input);
  const successor = await f.research.get(f.owner, done.successorId!);
  const ids = Object.fromEntries(successor.origin!.items.map((item) => [item.key, item.id]));
  const plain = await f.app.ctx.tasks.get(f.owner, ids.corpus);
  const coded = await f.app.ctx.tasks.get(f.owner, ids.harness);
  const experiment = await f.app.ctx.experiments.get(f.owner, ids.ordering);
  assert.equal(plain.workspace, 'git');
  assert.equal(coded.workspace, 'git');
  assert.equal(coded.workflow.version, 46);
  assert.equal(coded.baseTaskId, undefined);
  assert.equal(experiment.workspace, 'git');
  assert.equal(experiment.workflow.version, 45);
  assert.equal(experiment.workflow.data.baseTaskId, undefined);
  assert.deepEqual(
    (await f.app.ctx.workflows.prerequisites(f.owner, [experiment.id]))
      .get(experiment.id)!
      .map((item) => item.id),
    [coded.id],
  );
  assert.equal(
    (await digestOf(f, done)).digest.reflection!.changeSpec.hash,
    successor.origin!.changeSpec.hash,
  );
  await f.restart();
  assert.deepEqual(await f.research.advance(f.owner, input), done);
  assert.deepEqual(await counts(f), {
    tasks: before.tasks + 2,
    experiments: before.experiments + 1,
    cycles: before.cycles + 1,
  });
});

test('Code absence refuses managed Git work without losing approval or partial work', async (t) => {
  const f = await fixture(t);
  const { record, command } = await reflected(f, harnessPlan());
  const approved = (await f.app.ctx.reflections.approved(f.owner, record.reflectionId!))!;
  const before = await counts(f);
  // Tasks and Experiments require Code Work, so they go with it.
  await f.code(false);
  const input = command('create');
  await assert.rejects(f.research.advance(f.owner, input), { code: /_unavailable$/ });
  assert.deepEqual(await f.app.ctx.reflections.approved(f.owner, record.reflectionId!), approved);
  assert.equal(
    (await f.research.get(f.owner, record.id)).workflow.revision,
    record.workflow.revision,
  );
  await f.code(true);
  assert.deepEqual(await counts(f), before);
  assert.ok((await f.research.advance(f.owner, input)).successorId);
});
