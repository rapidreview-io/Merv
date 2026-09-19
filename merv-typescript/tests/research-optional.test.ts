import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Caller } from '@merv/contracts';
import type { Knowledge } from '@merv/knowledge/types';
import type { ResearchRecord } from '@merv/research/types';
import { ResearchService } from '../packages/research/src/index.js';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';

async function fixture(t: TestContext, coreOnly = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-research-optional-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins = config.plugins.filter(({ id }) =>
    coreOnly
      ? ['state', 'scope', 'workflows', 'research'].includes(id)
      : !['api', 'identity', 'ui'].includes(id) && !/-(api|ui)$/.test(id),
  );
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Optional research',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  let sequence = 0;
  const id = () => `optional-research-${++sequence}`;
  const research = app.ctx.research as ResearchService;
  const create = (workspace: 'none' | 'git' = 'none') =>
    research.create(owner, { name: 'Cycle', consolidationWorkspace: workspace, requestId: id() });
  const command = (record: ResearchRecord) => ({
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: id(),
  });
  const advance = (record: ResearchRecord) => research.advance(owner, command(record));
  const define = async () =>
    app.ctx.paper.patch(owner, {
      kind: 'problem',
      expectedRevision: (await app.ctx.paper.read(owner)).documents.problem.current.revision,
      requestId: id(),
      changes: ['problem', 'scope', 'goals', 'constraints'].map((section) => ({
        id: section,
        content: `A bounded ${section} supported by retained evidence.`,
      })),
    });
  const artifact = (caller: Caller, title: string) =>
    app.ctx.artifacts.create(caller, {
      title,
      content: `# Summary\n${title}: no empirical conclusion without evidence.\n# Evidence\nThe retained observations require further investigation.`,
    });
  const approve = async (record: ResearchRecord) => {
    let wave = await app.ctx.reflections.get(owner, record.reflectionId!);
    for (const lens of wave.lenses) {
      const issued = await app.ctx.scope.issueActor(owner, { name: id(), role: 'producer' });
      const worker = {
        projectId: owner.projectId,
        actorId: issued.actor.id,
        credentialId: issued.credential.id,
      };
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
      changeSpecArtifactId: (await artifact(owner, 'Changes')).id,
      expectedRevision: wave.workflow.revision,
      requestId: id(),
    });
    const issued = await app.ctx.scope.issueActor(owner, { name: id(), role: 'reviewer' });
    const reviewer = {
      projectId: owner.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    };
    const review = await app.ctx.reviews.start(reviewer, wave.review!.id);
    return app.ctx.reviews.apply(reviewer, {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: wave.workflow.revision,
      verdict: 'pass',
      notes: 'Verified the retained evidence and each lens report.',
      synopsis: 'The synthesis matches the observed evidence and its limitations.',
      findings: review.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: 'met' as const,
        evidenceIds: [wave.report!.id],
        notes: 'Checked the evidence and coverage independently.',
      })),
      requestId: id(),
    });
  };
  return { app, owner, research, create, command, advance, define, approve, id };
}

const pending = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('Research boots with only State, Scope and Workflows and reports the missing stage provider', async (t) => {
  const f = await fixture(t, true);
  const record = await f.create();
  assert.equal(f.app.status().find(({ id }) => id === 'research')!.state, 'active');
  assert.deepEqual(await f.research.list(f.owner), [record]);
  assert.equal((await f.research.get(f.owner, record.id)).workflow.version, 4);
  assert.match(
    JSON.stringify(await f.app.ctx.workflows.evaluate(f.owner, record.id)),
    /paper_unavailable/,
  );
  await assert.rejects(f.advance(record), { code: 'paper_unavailable' });
  await assert.rejects(f.research.startReflection(f.owner, { requestId: f.id() }), {
    code: 'reflections_unavailable',
  });
});

test('optional provider unload keeps Research and its tools alive; only the current stage waits', async (t) => {
  const f = await fixture(t);
  await f.define();
  let record = await f.create();
  const definitionInput = f.command(record);
  await f.app.setEnabled('paper', false);
  assert.equal(f.app.ctx.research, f.research);
  assert.ok((await f.app.ctx.tools.list()).some(({ name }) => name === 'research.advance'));
  assert.deepEqual(await f.research.list(f.owner), [record]);
  await assert.rejects(f.research.advance(f.owner, definitionInput), { code: 'paper_unavailable' });
  await f.app.setEnabled('paper', true);
  record = await f.research.advance(f.owner, definitionInput);
  const researching = record;
  assert.equal(record.workflow.state, 'researching');
  const reflectionInput = f.command(record);
  await f.app.setEnabled('reflections', false);
  assert.equal(f.app.ctx.research, f.research);
  assert.match(
    JSON.stringify(await f.app.ctx.workflows.evaluate(f.owner, record.id)),
    /reflections_unavailable/,
  );
  await assert.rejects(f.research.advance(f.owner, reflectionInput), {
    code: 'reflections_unavailable',
  });
  await f.app.setEnabled('reflections', true);
  await f.app.setEnabled('knowledge', false);
  await f.app.setEnabled('consolidation', false);
  record = await f.research.advance(f.owner, reflectionInput);
  assert.equal(record.workflow.state, 'reflecting');
  assert.equal(f.app.ctx.research, f.research);
  assert.deepEqual(await f.research.advance(f.owner, definitionInput), researching);
  await f.approve(record);
  const finish = f.command(record);
  await f.app.setEnabled('reflections', false);
  await assert.rejects(f.research.advance(f.owner, finish), { code: 'reflections_unavailable' });
  await f.app.setEnabled('reflections', true);
  const completed = await f.research.advance(f.owner, finish);
  assert.equal(completed.workflow.state, 'complete');
  assert.equal(completed.consolidationId, null);
  await f.app.setEnabled('paper', false);
  assert.deepEqual(await f.research.advance(f.owner, finish), completed);
});

test('reflection.create remains usable without Knowledge; live Git handoff waits for actual evidence access', async (t) => {
  const f = await fixture(t);
  await f.define();
  let record = await f.advance(await f.create('git'));
  await f.app.setEnabled('knowledge', false);
  record = await f.advance(record);
  assert.equal(record.workflow.state, 'reflecting');
  await f.approve(record);
  const input = f.command(record);
  assert.match(
    JSON.stringify(await f.app.ctx.workflows.evaluate(f.owner, record.id)),
    /knowledge_unavailable/,
  );
  await assert.rejects(f.research.advance(f.owner, input), { code: 'knowledge_unavailable' });
  assert.equal((await f.research.get(f.owner, record.id)).consolidationId, null);
  assert.deepEqual(await f.app.ctx.consolidation.list(f.owner), []);
  await f.app.setEnabled('knowledge', true);
  const result = await f.research.advance(f.owner, input);
  assert.equal(result.workflow.state, 'consolidating');
  assert.deepEqual(await f.research.advance(f.owner, input), result);
});

test('a withdrawn optional provider cannot commit results returned after an await; unrelated removal is harmless', async (t) => {
  const f = await fixture(t);
  await f.define();
  const record = await f.create();
  const input = f.command(record);
  const paper = f.app.ctx.paper;
  const entered = pending(),
    release = pending();
  const unbind = f.research.bindPaper({
    ...paper,
    read: async (...args) => {
      const result = await paper.read(...args);
      entered.resolve();
      await release.promise;
      return result;
    },
  });
  const operation = f.research.advance(f.owner, input);
  const rejected = assert.rejects(operation, { code: 'paper_unavailable' });
  await entered.promise;
  unbind();
  // Rebinding even the same object is a different lifetime, not permission to accept stale work.
  f.research.bindPaper(paper);
  release.resolve();
  await rejected;
  assert.equal((await f.research.get(f.owner, record.id)).workflow.state, 'defining');
  assert.equal((await f.research.get(f.owner, record.id)).problem, null);
  const reentered = pending(),
    rerelease = pending();
  const finalUnbind = f.research.bindPaper({
    ...paper,
    read: async (...args) => {
      const result = await paper.read(...args);
      reentered.resolve();
      await rerelease.promise;
      return result;
    },
  });
  const retry = f.research.advance(f.owner, input);
  await reentered.promise;
  await f.app.setEnabled('knowledge', false);
  rerelease.resolve();
  assert.equal((await retry).workflow.state, 'researching');
  finalUnbind();
});

test('Knowledge withdrawal during live handoff rolls back children and same-request retry remains valid', async (t) => {
  const f = await fixture(t);
  await f.define();
  const record = await f.advance(await f.advance(await f.create('git')));
  await f.approve(record);
  const input = f.command(record);
  const knowledge = f.app.ctx.knowledge;
  const entered = pending(),
    release = pending();
  const delayed: Knowledge = {
    ...knowledge,
    researchReferences: async (...args) => {
      const refs = await knowledge.researchReferences(...args);
      entered.resolve();
      await release.promise;
      return refs;
    },
  };
  const unbind = f.research.bindKnowledge(delayed);
  const operation = f.research.advance(f.owner, input);
  const rejected = assert.rejects(operation, { code: 'knowledge_unavailable' });
  await entered.promise;
  unbind();
  f.research.bindKnowledge(knowledge);
  release.resolve();
  await rejected;
  assert.equal((await f.research.get(f.owner, record.id)).consolidationId, null);
  assert.deepEqual(await f.app.ctx.consolidation.list(f.owner), []);
  const result = await f.research.advance(f.owner, input);
  assert.equal(result.workflow.state, 'consolidating');
  assert.equal((await f.app.ctx.consolidation.list(f.owner)).length, 1);
});

test('live read grants reject in-flight results from a replaced Knowledge registration', async (t) => {
  const f = await fixture(t);
  const wave = await f.research.startReflection(f.owner, { requestId: f.id() });
  const target = { instanceId: wave.lenses[0]!.id, expectedRevision: 0 };
  const execution = await f.app.ctx.workflows.execution(f.owner, target);
  const entered = pending(),
    release = pending();
  const knowledge = f.app.ctx.knowledge;
  const unbind = f.research.bindKnowledge({
    ...knowledge,
    researchReferences: async () => {
      entered.resolve();
      await release.promise;
      return { artifacts: ['art_withdrawn'], reviews: [], experiments: [] };
    },
  });
  const request = {
    ...target,
    policyHash: execution.policyHash,
    registrationId: execution.registrationId,
    tool: 'artifact.read',
    input: { artifactId: 'art_withdrawn' },
  };
  const operation = f.app.ctx.workflows.authorizeDispatch(f.owner, request);
  const rejected = assert.rejects(operation, { code: 'knowledge_unavailable' });
  await entered.promise;
  unbind();
  f.research.bindKnowledge(knowledge);
  release.resolve();
  await rejected;
  await assert.rejects(f.app.ctx.workflows.authorizeDispatch(f.owner, request), {
    code: 'execution_arguments_forbidden',
  });
  assert.equal(f.app.ctx.research, f.research);
});

test('a previously used Reflections binding replaced during Knowledge await invalidates the whole handoff', async (t) => {
  const f = await fixture(t);
  await f.define();
  const record = await f.advance(await f.advance(await f.create('git')));
  await f.approve(record);
  const input = f.command(record);
  const knowledge = f.app.ctx.knowledge;
  const entered = pending(),
    release = pending();
  f.research.bindKnowledge({
    ...knowledge,
    researchReferences: async (...args) => {
      const refs = await knowledge.researchReferences(...args);
      entered.resolve();
      await release.promise;
      return refs;
    },
  });
  const operation = f.research.advance(f.owner, input);
  const rejected = assert.rejects(operation, { code: 'reflections_unavailable' });
  await entered.promise;
  f.research.bindReflections(f.app.ctx.reflections);
  release.resolve();
  await rejected;
  assert.equal((await f.research.get(f.owner, record.id)).consolidationId, null);
  assert.deepEqual(await f.app.ctx.consolidation.list(f.owner), []);
  f.research.bindKnowledge(knowledge);
  const result = await f.research.advance(f.owner, input);
  assert.equal(result.workflow.state, 'consolidating');
  assert.equal((await f.app.ctx.consolidation.list(f.owner)).length, 1);
});

test('historical approved corpus handoff uses only its retained sources without consulting live Knowledge', async (t) => {
  const f = await fixture(t);
  const oldSource = await f.app.ctx.artifacts.create(f.owner, {
    title: 'Historical source',
    content: 'Previously approved evidence.',
  });
  const laterSource = await f.app.ctx.artifacts.create(f.owner, {
    title: 'Later source',
    content: 'Unrelated later evidence.',
  });
  await f.define();
  const record = await f.advance(await f.advance(await f.create('git')));
  await f.approve(record);
  const reflections = f.app.ctx.reflections;
  const approved = await reflections.approved(f.owner, record.reflectionId!);
  // A trusted domain-service fixture supplies the preserved historical contract;
  // no immutable live row or workflow graph is relabelled.
  f.research.bindReflections({
    ...reflections,
    approved: async () => ({
      ...approved,
      corpus: {
        selection: {
          artifacts: [{ id: oldSource.id, status: 'retained', artifact: oldSource }],
          experiments: [],
        },
      },
    }),
  });
  await f.app.setEnabled('knowledge', false);
  const result = await f.advance(record);
  const child = await f.app.ctx.consolidation.get(f.owner, result.consolidationId!);
  assert.ok(child.sources.some(({ id }) => id === oldSource.id));
  assert.ok(!child.sources.some(({ id }) => id === laterSource.id));
  assert.deepEqual(child.experimentIds, []);
});

test('replacement between stage checks and provider use never invokes a second provider lifetime', async (t) => {
  const f = await fixture(t);
  await f.define();
  const record = await f.advance(await f.advance(await f.create('git')));
  await f.approve(record);
  const input = f.command(record);
  const workflows = f.app.ctx.workflows;
  const original = workflows.checkDependencies.bind(workflows);
  const entered = pending(),
    release = pending();
  const waiting = t.mock.method(
    workflows,
    'checkDependencies',
    async (...args: Parameters<typeof original>) => {
      await original(...args);
      entered.resolve();
      await release.promise;
    },
  );
  const operation = f.research.advance(f.owner, input);
  const rejected = assert.rejects(operation, { code: 'reflections_unavailable' });
  await entered.promise;
  let calls = 0;
  const reflections = f.app.ctx.reflections;
  f.research.bindReflections({
    ...reflections,
    approved: async (...args) => {
      calls++;
      return reflections.approved(...args);
    },
  });
  release.resolve();
  await rejected;
  waiting.mock.restore();
  assert.equal(calls, 0);
  assert.equal((await f.research.get(f.owner, record.id)).consolidationId, null);
  assert.deepEqual(await f.app.ctx.consolidation.list(f.owner), []);
  assert.equal((await f.research.advance(f.owner, input)).workflow.state, 'consolidating');
});
