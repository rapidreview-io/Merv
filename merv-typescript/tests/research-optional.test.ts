import type { Caller } from '@merv/contracts';
import type { Knowledge } from '@merv/knowledge/types';
import type { ResearchRecord } from '@merv/research/types';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { ResearchService } from '../packages/research/src/index.js';
import { createApp } from './fixtures/app.js';
import type { ApplicationConfig } from '../src/config.js';

async function fixture(t: TestContext, coreOnly = false, withoutCode = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-research-optional-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins = config.plugins.filter(
    ({ id }) =>
      (!withoutCode || !id.startsWith('code')) &&
      (coreOnly
        ? ['state', 'scope', 'workflows', 'research'].includes(id)
        : !['api', 'identity', 'ui'].includes(id) && !/-(api|ui)$/.test(id)),
  );
  const app = await createApp({ directory, config });
  if (!coreOnly && !withoutCode)
    assert.ok(app.ctx.codeResearch, 'The full fixture must activate Code research');
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
  const research = () => app.ctx.research as ResearchService;
  const create = () => research().create(owner, { name: 'Cycle', requestId: id() });
  const command = (record: ResearchRecord) => ({
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: id(),
  });
  const advance = (record: ResearchRecord) => research().advance(owner, command(record));
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
  return {
    app,
    owner,
    get research() {
      return research();
    },
    create,
    command,
    advance,
    define,
    approve,
    id,
  };
}

const pending = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('research completes with Code never loaded', async (t) => {
  const f = await fixture(t, false, true);
  assert.equal(f.app.ctx.code, undefined);
  assert.equal(f.app.ctx.codeResearch, undefined);
  await f.define();
  const reflected = await f.advance(await f.advance(await f.create()));
  await f.approve(reflected);
  const completed = await f.advance(reflected);
  assert.equal(completed.workflow.state, 'complete');
  assert.deepEqual(completed.integrations, []);
});

test("a new cycle during Code outage retains the project's earlier obligation", async (t) => {
  const f = await fixture(t);
  const unbind = f.research.bindCode({
    hosted: async () => true,
    acceptedSince: async () => ({
      unitIds: [],
      quarantined: [],
      main: 'main',
      hash: 'reading',
    }),
    publishOnAcceptance: async () => {
      throw new Error('unexpected publication');
    },
    unit: async () => {
      throw new Error('unexpected unit read');
    },
  });
  await f.create();
  unbind();
  await f.app.setEnabled('code', false);
  await f.define();
  const record = await f.advance(await f.advance(await f.create()));
  assert.deepEqual(record.researchDependencies, []);
  await f.approve(record);
  await assert.rejects(f.advance(record), { code: 'code_unavailable' });
  assert.equal((await f.research.get(f.owner, record.id)).workflow.state, 'reflecting');
});

for (const beforeCycle of [true, false])
  test(`unselected Git work declared ${beforeCycle ? 'before' : 'during'} the first research cycle survives Code outage`, async (t) => {
    const f = await fixture(t);
    await f.define();
    let record = beforeCycle ? undefined : await f.create();
    await f.app.ctx.tasks.create(f.owner, {
      title: 'Repository work',
      goal: 'Keep a reproducible harness',
      checks: ['The harness runs'],
      workspace: 'git',
      requestId: f.id(),
    });
    await f.app.setEnabled('code', false);
    record ??= await f.create();
    record = await f.advance(await f.advance(record));
    assert.deepEqual(record.researchDependencies, []);
    await f.approve(record);
    await assert.rejects(f.advance(record), { code: 'code_unavailable' });
    assert.equal((await f.research.get(f.owner, record.id)).workflow.state, 'reflecting');
  });

test('Research boots with only State, Scope and Workflows and reports the missing stage provider', async (t) => {
  const f = await fixture(t, true);
  const record = await f.create();
  assert.equal(f.app.status().find(({ id }) => id === 'research')!.state, 'active');
  assert.deepEqual(await f.research.list(f.owner), [record]);
  assert.equal((await f.research.get(f.owner, record.id)).workflow.version, 6);
  assert.match(
    JSON.stringify(await f.app.ctx.workflows.evaluate(f.owner, record.id)),
    /paper_unavailable/,
  );
  await assert.rejects(f.advance(record), { code: 'paper_unavailable' });
  await assert.rejects(f.research.startReflection(f.owner, { requestId: f.id() }), {
    code: 'reflections_unavailable',
  });
});

test('a hosted cycle retains its Code obligation when the provider unloads', async (t) => {
  const f = await fixture(t);
  const unbind = f.research.bindCode({
    hosted: async () => true,
    acceptedSince: async () => ({
      unitIds: [],
      quarantined: [],
      main: 'main',
      hash: 'reading',
    }),
    publishOnAcceptance: async () => {
      throw new Error('unexpected publication');
    },
    unit: async () => {
      throw new Error('unexpected unit read');
    },
  });
  await f.define();
  let record = await f.advance(await f.advance(await f.create()));
  await f.approve(record);
  unbind();
  await f.app.setEnabled('code', false);
  await f.app.setEnabled('research', false);
  await f.app.setEnabled('research', true);
  record = await f.research.get(f.owner, record.id);
  await assert.rejects(f.advance(record), { code: 'code_unavailable' });
  assert.equal((await f.research.get(f.owner, record.id)).workflow.state, 'reflecting');
});

test('becoming hosted during a cycle records the obligation even when advance waits for review', async (t) => {
  const f = await fixture(t);
  await f.define();
  const record = await f.advance(await f.advance(await f.create()));
  const unbind = f.research.bindCode({
    hosted: async () => true,
    acceptedSince: async () => ({
      unitIds: [],
      quarantined: [],
      main: 'main',
      hash: 'reading',
    }),
    publishOnAcceptance: async () => {
      throw new Error('unexpected publication');
    },
    unit: async () => {
      throw new Error('unexpected unit read');
    },
  });
  await assert.rejects(f.advance(record), { code: 'reflection_not_approved' });
  unbind();
  await f.app.setEnabled('code', false);
  await f.approve(record);
  await assert.rejects(f.advance(record), { code: 'code_unavailable' });
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
  await assert.rejects(f.research.advance(f.owner, definitionInput), {
    code: 'paper_unavailable',
  });
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
  record = await f.research.advance(f.owner, reflectionInput);
  assert.equal(record.workflow.state, 'reflecting');
  assert.equal(f.app.ctx.research, f.research);
  assert.deepEqual(await f.research.advance(f.owner, definitionInput), researching);
  await f.approve(record);
  const finish = f.command(record);
  await f.app.setEnabled('reflections', false);
  await assert.rejects(f.research.advance(f.owner, finish), {
    code: 'reflections_unavailable',
  });
  await f.app.setEnabled('reflections', true);
  const completed = await f.research.advance(f.owner, finish);
  assert.equal(completed.workflow.state, 'complete');
  await f.app.setEnabled('paper', false);
  assert.deepEqual(await f.research.advance(f.owner, finish), completed);
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

test('an approved current cycle completes while Knowledge is absent and retains its reflection', async (t) => {
  const f = await fixture(t);
  await f.define();
  const record = await f.advance(await f.advance(await f.create()));
  await f.approve(record);
  await f.app.setEnabled('knowledge', false);
  const completed = await f.advance(record);
  assert.equal(completed.workflow.state, 'complete');
  assert.equal(completed.reflectionId, record.reflectionId);
  assert.equal(completed.digest, null);
});

test('Knowledge withdrawal during current cycle digest rolls back the completion and same-request retry works', async (t) => {
  const f = await fixture(t);
  await f.define();
  const record = await f.advance(await f.advance(await f.create()));
  await f.approve(record);
  const input = f.command(record);
  const knowledge = f.app.ctx.knowledge;
  const entered = pending(),
    release = pending();
  const delayed: Knowledge = {
    ...knowledge,
    records: async (...args) => {
      const records = await knowledge.records(...args);
      entered.resolve();
      await release.promise;
      return records;
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
  assert.equal((await f.research.get(f.owner, record.id)).workflow.state, 'reflecting');
  const result = await f.research.advance(f.owner, input);
  assert.equal(result.workflow.state, 'complete');
  assert.ok(result.digest);
});

test('replacing Reflections during Knowledge await invalidates current cycle completion', async (t) => {
  const f = await fixture(t);
  await f.define();
  const record = await f.advance(await f.advance(await f.create()));
  await f.approve(record);
  const input = f.command(record);
  const knowledge = f.app.ctx.knowledge;
  const entered = pending(),
    release = pending();
  f.research.bindKnowledge({
    ...knowledge,
    records: async (...args) => {
      const records = await knowledge.records(...args);
      entered.resolve();
      await release.promise;
      return records;
    },
  });
  const operation = f.research.advance(f.owner, input);
  const rejected = assert.rejects(operation, { code: 'reflections_unavailable' });
  await entered.promise;
  f.research.bindReflections(f.app.ctx.reflections);
  release.resolve();
  await rejected;
  assert.equal((await f.research.get(f.owner, record.id)).workflow.state, 'reflecting');
  f.research.bindKnowledge(knowledge);
  assert.equal((await f.research.advance(f.owner, input)).workflow.state, 'complete');
});

test('replacement during approved reflection read cannot use a second provider lifetime', async (t) => {
  const f = await fixture(t);
  await f.define();
  const record = await f.advance(await f.advance(await f.create()));
  await f.approve(record);
  const input = f.command(record);
  const reflections = f.app.ctx.reflections;
  const original = reflections.approved.bind(reflections);
  const entered = pending(),
    release = pending();
  const waiting = t.mock.method(
    reflections,
    'approved',
    async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      entered.resolve();
      await release.promise;
      return result;
    },
  );
  const operation = f.research.advance(f.owner, input);
  const rejected = assert.rejects(operation, { code: 'reflections_unavailable' });
  await entered.promise;
  let calls = 0;
  f.research.bindReflections({
    ...reflections,
    get: reflections.get.bind(reflections),
    approved: async (...args) => {
      calls++;
      return reflections.approved(...args);
    },
  });
  release.resolve();
  await rejected;
  waiting.mock.restore();
  assert.equal(calls, 0);
  assert.equal((await f.research.get(f.owner, record.id)).workflow.state, 'reflecting');
  assert.equal((await f.research.advance(f.owner, input)).workflow.state, 'complete');
});
