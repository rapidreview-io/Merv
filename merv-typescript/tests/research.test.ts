import { someAsync } from '@merv/contracts';
import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import { ResearchService } from '../packages/research/src/index.js';
import type { ResearchRecord } from '../packages/research/src/types.js';
import type { Caller, ReviewApplication, WorkflowDefinition } from '@merv/contracts';
import type { Reflection } from '@merv/reflections/types';

async function fixture(t: TestContext) {
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
      new ResearchService(
        app.ctx.state,
        app.ctx.scope,
        app.ctx.workflows,
        app.ctx.paper,
        app.ctx.reflections,
        app.ctx.consolidation,
        app.ctx.knowledge,
      ),
    );
  let research = await service(),
    sequence = 0;
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Research cycle',
    actorName: 'Coordinator',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const id = () => `research-test-${++sequence}`;
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const record = await app.ctx.scope.issueActor(owner, { name: id(), role });
    return {
      projectId: owner.projectId,
      actorId: record.actor.id,
      credentialId: record.credential.id,
    };
  };
  const reviewer = await issue('reviewer');
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
  const create = async (consolidationWorkspace: 'none' | 'git' = 'none') =>
    await research.create(owner, {
      name: 'Research loop',
      consolidationWorkspace,
      requestId: id(),
    });
  const legacy = async () => {
    research.close();
    // Seed an actual v2 record through its unchanged persisted graph, never by
    // relabelling a v3 instance or bypassing the immutable definition checks.
    const stored = await app.ctx.state.read(
      async (sql) =>
        (await sql.get<{ definition_json: string }>(
          "SELECT definition_json FROM wf_definitions WHERE name='research' AND version=2",
        ))!,
    );
    const definition = JSON.parse(stored.definition_json) as WorkflowDefinition;
    const handle = await app.ctx.workflows.register(definition, {
      successStates: ['complete'],
      actions: definition.edges.map((edge) => ({
        name: `advance_${edge.from}`,
        states: [edge.from],
        transitions: [edge.action],
        tool: 'research.advance',
        instruction: 'Advance the legacy research cycle.',
        check: () => {},
      })),
    });
    const workflow = await app.ctx.state.transaction(async (tx) => {
      const workflow = await handle.start(
        owner,
        { workflow: 'research', version: 2, requestId: id() },
        tx,
      );
      await tx.run(
        'INSERT INTO research_cycles(id,project_id,record) VALUES(?,?,?)',
        workflow.id,
        owner.projectId,
        JSON.stringify({
          id: workflow.id,
          projectId: owner.projectId,
          ownerId: owner.actorId,
          name: 'Retained v2 research',
          createdAt: workflow.createdAt,
          researchDependencies: [],
          consolidationWorkspace: 'none',
          consolidationDependencies: [],
        }),
      );
      return workflow;
    });
    handle.dispose();
    research = await service();
    return await research.get(owner, workflow.id);
  };
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
  const reflect = async (record: ResearchRecord) => {
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
      changeSpecArtifactId: (await artifact(owner, 'Change specification')).id,
      expectedRevision: wave.workflow.revision,
      requestId: id(),
    });
    return (await review(wave.review!.id, wave.workflow.revision)) as Reflection;
  };
  const consolidate = async (record: ResearchRecord) => {
    const work = await app.ctx.consolidation.get(owner, record.consolidationId!);
    const submitted = await app.ctx.consolidation.submit(owner, {
      consolidationId: work.id,
      expectedRevision: work.workflow.revision,
      reportArtifactId: (await artifact(owner, 'Consolidation report')).id,
      decisions: [],
      requestId: id(),
    });
    return await review(submitted.reviewId!, submitted.workflow.revision);
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
    consolidate,
    legacy,
    async restart() {
      research.close();
      await app.stop();
      app = await createApp({ directory, config });
      research = await service();
    },
  };
}

test('failed Research activation releases its earlier workflow registration', async (t) => {
  const f = await fixture(t);
  f.research.close();
  const releaseConflict = f.app.ctx.workflows.registerReadReferences({
    id: 'research',
    resolve: async () => null,
  });
  const activate = async () =>
    await createService(
      new ResearchService(
        f.app.ctx.state,
        f.app.ctx.scope,
        f.app.ctx.workflows,
        f.app.ctx.paper,
        f.app.ctx.reflections,
        f.app.ctx.consolidation,
        f.app.ctx.knowledge,
      ),
    );
  await assert.rejects(activate, { code: 'read_provider_exists' });
  releaseConflict();
  const restarted = await activate();
  try {
    assert.equal(
      (await restarted.create(f.owner, { name: 'Retry', requestId: f.id() })).workflow.state,
      'defining',
    );
  } finally {
    restarted.close();
  }
});

test('new no-code research completes after approved reflection without consolidation or paper assignments', async (t) => {
  const f = await fixture(t);
  let record = await f.create();
  assert.equal(record.workflow.state, 'defining');
  await assert.rejects(async () => await f.advance(record), {
    code: 'research_definition_required',
  });
  const defined = await f.definition();
  record = await f.advance(record);
  assert.equal(record.workflow.state, 'researching');
  assert.deepEqual(record.problem, defined);
  // Later living edits never rewrite the accepted definition.
  await f.definition();
  assert.equal((await f.research.get(f.owner, record.id)).problem!.revision, defined.revision);
  record = await f.advance(record);
  assert.equal(record.workflow.state, 'reflecting');
  assert.equal(
    (await f.app.ctx.workflows.dependencies(f.owner, record.id)).dependencies[0].id,
    record.reflectionId,
  );
  assert.equal(
    (await f.app.ctx.workflows.dispatchCandidates(f.owner)).some(
      (candidate) => candidate.instanceId === record.id,
    ),
    false,
  );
  await assert.rejects(async () => await f.advance(record), { code: 'dependencies_pending' });
  await f.reflect(record);
  record = await f.advance(record);
  assert.equal(record.workflow.state, 'complete');
  assert.equal(record.workflow.version, 3);
  assert.equal(record.consolidationId, null);
  assert.equal((await f.app.ctx.workflows.dependencies(f.owner, record.id)).dependencies.length, 1);
  assert.equal((await f.app.ctx.consolidation.list(f.owner)).length, 0);
  await assert.rejects(async () => await f.advance(record), { code: 'research_complete' });
  assert.equal((await f.app.ctx.paper.read(f.owner)).proposals.length, 0);
});

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
  const other = await f.app.ctx.scope.bootstrap({
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
  assert.deepEqual(
    (await f.app.ctx.workflows.dependencies(f.owner, record.id)).dependencies
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
    (await f.app.ctx.workflows.dependencies(f.owner, record.id)).dependencies.map((i) => i.id),
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
    /immutable/,
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

test('persisted v2 research retains report-only consolidation and exact replay through restart', async (t) => {
  const f = await fixture(t);
  await f.definition();
  let record = await f.advance(await f.advance(await f.legacy()));
  assert.equal(record.workflow.version, 2);
  await f.reflect(record);
  const handoff = {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: f.id(),
  };
  record = await f.research.advance(f.owner, handoff);
  assert.equal(record.workflow.state, 'consolidating');
  assert.equal(
    (await f.app.ctx.consolidation.get(f.owner, record.consolidationId!)).workspace,
    'none',
  );
  assert.deepEqual(await f.research.advance(f.owner, handoff), record);
  await f.restart();
  assert.deepEqual(await f.research.advance(f.owner, handoff), record);
  assert.equal((await f.app.ctx.consolidation.list(f.owner)).length, 1);
  await f.consolidate(record);
  const finish = {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: f.id(),
  };
  record = await f.research.advance(f.owner, finish);
  assert.equal(record.workflow.state, 'complete');
  assert.equal(record.workflow.version, 2);
  await f.restart();
  assert.deepEqual(await f.research.advance(f.owner, finish), record);
  assert.deepEqual(
    (await f.app.ctx.workflows.dependencies(f.owner, record.id)).dependencies
      .map((entry) => entry.id)
      .sort(),
    [record.reflectionId!, record.consolidationId!].sort(),
  );
});

test('consolidation workspace and extra prerequisites are forwarded to the exact child', async (t) => {
  const f = await fixture(t);
  await f.definition();
  const pending = await f.app.ctx.workflows.register(
    {
      name: 'research-extra-prerequisite',
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
  const extra = await pending.start(f.owner, {
    workflow: 'research-extra-prerequisite',
    requestId: f.id(),
  });
  let record = await f.research.create(f.owner, {
    name: 'Git cycle',
    consolidationWorkspace: 'git',
    consolidationDependsOn: [extra.id],
    requestId: f.id(),
  });
  record = await f.advance(record);
  record = await f.advance(record);
  await f.reflect(record);
  record = await f.advance(record);
  const child = await f.app.ctx.consolidation.get(f.owner, record.consolidationId!);
  assert.equal(child.workspace, 'git');
  // 4 is the Git workflow with a way out of a failed prerequisite; 2 was the same without one.
  assert.equal(child.workflow.version, 4);
  assert.deepEqual(
    (await f.app.ctx.workflows.dependencies(f.owner, child.id)).dependencies
      .map((d) => d.id)
      .sort(),
    [record.reflectionId!, extra.id].sort(),
  );
  await assert.rejects(async () => await f.app.ctx.workflows.assignment(f.owner, child.id), {
    code: 'dependencies_pending',
  });
  pending.dispose();
});

test('consolidation continues from retained artifacts after Reflections and Knowledge unload', async (t) => {
  const f = await fixture(t);
  await f.definition();
  let record = await f.advance(await f.advance(await f.legacy()));
  await f.reflect(record);
  record = await f.advance(record);
  const before = await f.app.ctx.consolidation.get(f.owner, record.consolidationId!);
  await f.app.setEnabled('reflections', false);
  await f.app.setEnabled('knowledge', false);
  assert.equal(f.app.status().find((p) => p.id === 'consolidation')!.state, 'active');
  assert.equal(f.app.status().find((p) => p.id === 'paper')!.state, 'active');
  assert.deepEqual(await f.app.ctx.consolidation.get(f.owner, before.id), before);
  assert.ok((await f.app.ctx.workflows.assignment(f.owner, before.id)).context);
  const completed = await f.consolidate(record);
  assert.equal((completed as { workflow: { state: string } }).workflow.state, 'complete');
  assert.equal((await f.app.ctx.paper.read(f.owner)).documents.problem.current.revision, 1);
});

test('Research selects live research evidence and completed experiments when advancing to consolidation', async (t) => {
  const f = await fixture(t);
  const completed = await f.app.ctx.experiments.create(f.owner, {
    name: 'finishes-during-reflection',
    intent: 'Evaluate whether the approach is feasible',
    requestId: f.id(),
  });
  const continuing = await f.app.ctx.experiments.create(f.owner, {
    name: 'still-running',
    intent: 'Explore another approach',
    requestId: f.id(),
  });
  const evidence = await f.artifact(f.owner, 'Plan retained during reflection');
  const unrelated = await f.artifact(f.owner, 'Unattached project file');
  await f.definition();
  let record = await f.advance(await f.advance(await f.create('git')));
  await f.app.ctx.experiments.attach(f.owner, {
    experimentId: completed.id,
    artifactId: evidence.id,
    role: 'plan',
    path: 'plan.md',
    attemptIndex: 1,
    expectedRevision: 0,
    requestId: f.id(),
  });
  await f.reflect(record);
  assert.deepEqual(
    (await f.app.ctx.reflections.approved(f.owner, record.reflectionId!)).experimentIds,
    [],
  );
  const current = await f.app.ctx.experiments.get(f.owner, completed.id);
  await f.app.ctx.experiments.transition(f.owner, {
    experimentId: current.id,
    expectedRevision: current.workflow.revision,
    transition: 'abandon',
    evidence: { reason: 'The feasibility analysis ruled out this approach.' },
    requestId: f.id(),
  });
  record = await f.advance(record);
  const child = await f.app.ctx.consolidation.get(f.owner, record.consolidationId!);
  assert.deepEqual(child.experimentIds, [completed.id]);
  assert.ok(!child.experimentIds.includes(continuing.id));
  assert.ok(child.sources.some((source) => source.id === evidence.id));
  assert.ok(!child.sources.some((source) => source.id === unrelated.id));
  assert.ok(
    await someAsync(
      child.sources,
      async (source) =>
        source.id === (await f.app.ctx.reflections.get(f.owner, record.reflectionId!)).report!.id,
    ),
  );
});

test('v2 and v3 metadata and committed receipts survive all optional capabilities being absent', async (t) => {
  const f = await fixture(t);
  await f.definition();
  let legacy = await f.advance(await f.advance(await f.legacy()));
  await f.reflect(legacy);
  legacy = await f.advance(legacy);
  await f.consolidate(legacy);
  const finish = {
    researchId: legacy.id,
    expectedRevision: legacy.workflow.revision,
    requestId: f.id(),
  };
  legacy = await f.research.advance(f.owner, finish);
  const create = { name: 'Retained v3', requestId: f.id() };
  const current = await f.research.create(f.owner, create);
  const before = await f.research.list(f.owner);
  for (const release of [
    f.research.bindPaper(f.app.ctx.paper),
    f.research.bindReflections(f.app.ctx.reflections),
    f.research.bindKnowledge(f.app.ctx.knowledge),
    f.research.bindConsolidation(f.app.ctx.consolidation),
  ])
    release();
  for (const id of ['paper', 'reflections', 'knowledge', 'consolidation'])
    await f.app.setEnabled(id, false);
  assert.deepEqual(await f.research.list(f.owner), before);
  assert.deepEqual(await f.research.get(f.owner, legacy.id), legacy);
  assert.deepEqual(await f.research.get(f.owner, current.id), current);
  assert.deepEqual(await f.research.advance(f.owner, finish), legacy);
  assert.deepEqual(await f.research.create(f.owner, create), current);
  assert.ok(legacy.reflectionId);
  assert.ok(legacy.consolidationId);
});
