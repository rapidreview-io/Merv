import { someAsync } from '@merv/contracts';
import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { CodeService } from '@merv/code/service';
import { CodeConsolidation } from '../packages/code/src/consolidation.js';
import { CodeRepositories } from '@merv/code/store/repository';
import { backends, optional, gitSource, type Backend } from './fixtures/code-store.js';
import { boundProject } from './fixtures/code-binding.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';
import type { CodeStoreOperation, Data, SessionWorkspace } from '@merv/contracts';
import { createApp } from '../src/app.js';
import { ResearchService } from '../packages/research/src/index.js';
import type { ResearchRecord } from '../packages/research/src/types.js';
import type { Caller, ReviewApplication, WorkflowDefinition } from '@merv/contracts';
import type { ChangeSpec, Reflection } from '@merv/reflections/types';
import type { ConsolidationDecision } from '@merv/consolidation/types';
import type { ResearchDigest } from '../packages/research/src/types.js';
import {
  CONSOLIDATION_LIMITS,
  createSchema as consolidationCreateSchema,
} from '../packages/consolidation/src/input.js';

async function fixture(t: TestContext, backend: Backend = 'sqlite', store = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-research-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  // These domain tests need Code's contracts, not its socket-backed repository store.
  if (!store) config.plugins.find((entry: { id: string }) => entry.id === 'code').config = {};
  const schema = `research_${randomUUID().replaceAll('-', '')}`;
  if (backend === 'postgres')
    config.plugins.find((entry: { id: string }) => entry.id === 'state').config = {
      backend,
      connectionStringEnv: 'MERV_TEST_POSTGRES_URL',
      schema,
    };
  config.plugins = config.plugins.filter(
    (entry: { id: string }) =>
      !['api', 'identity', 'ui', 'research', 'research-tools', 'research-ui'].includes(entry.id) &&
      !entry.id.endsWith('-api') &&
      !entry.id.endsWith('-ui'),
  );
  let app = await createApp({ directory, config });
  const service = async (digests = true) =>
    await createService(
      new ResearchService(
        app.ctx.state,
        app.ctx.scope,
        app.ctx.workflows,
        app.ctx.paper,
        app.ctx.reflections,
        app.ctx.consolidation,
        app.ctx.knowledge,
        app.ctx.tasks,
        app.ctx.experiments,
        digests ? app.ctx.artifacts : undefined,
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
  const consolidate = async (record: ResearchRecord, decisions: ConsolidationDecision[] = []) => {
    const work = await app.ctx.consolidation.get(owner, record.consolidationId!);
    const submitted = await app.ctx.consolidation.submit(owner, {
      consolidationId: work.id,
      expectedRevision: work.workflow.revision,
      reportArtifactId: (await artifact(owner, 'Consolidation report')).id,
      decisions,
      requestId: id(),
    });
    return await review(submitted.reviewId!, submitted.workflow.revision);
  };
  t.after(async () => {
    research.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
    if (backend === 'postgres') {
      const pool = new Pool({ connectionString: process.env.MERV_TEST_POSTGRES_URL });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
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
    /** The same storage with Artifacts unbound or bound again, as when a plugin is unloaded. */
    async rebind(digests: boolean) {
      research.close();
      research = await service(digests);
    },
    async restart() {
      research.close();
      await app.stop();
      app = await createApp({ directory, config });
      research = await service();
    },
  };
}

test('Research requests retain their admitted caller and reflection inputs', async (t) => {
  for (const method of ['get', 'list'] as const) {
    await t.test(method, async (t) => {
      const f = await fixture(t);
      const record = await f.create();
      const other = await f.app.ctx.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
      const caller = { projectId: other.project.id, actorId: other.actor.id };
      const authorize = f.app.ctx.scope.require.bind(f.app.ctx.scope);
      t.mock.method(f.app.ctx.scope, 'require', async (...args: Parameters<typeof authorize>) => {
        const result = await authorize(...args);
        Object.assign(caller, f.owner);
        return result;
      });
      if (method === 'get')
        await assert.rejects(f.research.get(caller, record.id), { code: 'research_not_found' });
      else assert.deepEqual(await f.research.list(caller), []);
    });
  }
  for (const method of ['advance', 'replan', 'end'] as const) {
    await t.test(method, async (t) => {
      const f = await fixture(t);
      await f.definition();
      const record = await f.create();
      const caller = await f.issue('producer');
      const get = f.research.get.bind(f.research);
      t.mock.method(f.research, 'get', async (...args: Parameters<typeof get>) => {
        const result = await get(...args);
        Object.assign(caller, f.owner);
        return result;
      });
      const input = {
        researchId: record.id,
        expectedRevision: record.workflow.revision,
        requestId: f.id(),
      };
      const changing =
        method === 'advance'
          ? f.research.advance(caller, input)
          : method === 'replan'
            ? f.research.replan(caller, { ...input, dependsOn: [] })
            : f.research.end(caller, { ...input, outcome: 'abandoned', reason: 'Stop this cycle' });
      await assert.rejects(changing, { code: 'forbidden' });
      assert.equal((await get(f.owner, record.id)).workflow.revision, record.workflow.revision);
    });
  }
  await t.test('creation', async (t) => {
    const f = await fixture(t);
    const producer = await f.issue('producer');
    const caller = { ...f.owner };
    const creating = f.research.create(caller, { name: 'Original', requestId: f.id() });
    Object.assign(caller, producer);
    assert.equal((await creating).ownerId, f.owner.actorId);
  });
  await t.test('reflection creation', async (t) => {
    const f = await fixture(t);
    const producer = await f.issue('producer');
    const caller = { ...f.owner };
    const input = { title: 'Original reflection', requestId: f.id() };
    const reflecting = f.research.startReflection(caller, input);
    Object.assign(caller, producer);
    input.title = 'Replacement reflection';
    const reflection = await reflecting;
    assert.equal(reflection.ownerId, f.owner.actorId);
    assert.equal(reflection.title, 'Original reflection');
  });
});

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
  await assert.rejects(async () => await f.advance(record), { code: 'reflection_not_approved' });
  await f.reflect(record);
  record = await f.advance(record);
  assert.equal(record.workflow.state, 'complete');
  // New cycles observe failed outcomes instead of requiring successful experiments.
  assert.equal(record.workflow.version, 5);
  assert.equal(record.consolidationId, null);
  assert.equal((await f.app.ctx.workflows.dependencies(f.owner, record.id)).dependencies.length, 1);
  assert.equal((await f.app.ctx.consolidation.list(f.owner)).length, 0);
  await assert.rejects(async () => await f.advance(record), { code: 'research_complete' });
  assert.equal((await f.app.ctx.paper.read(f.owner)).proposals.length, 0);
  // A text change specification opens nothing: the cycle neither follows nor leads another.
  assert.equal(record.origin, null);
  assert.equal(record.successorId, null);
});

test('a cycle follows at most one other, and which one never changes', async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  const follow = async (id: string, predecessorId: string) =>
    await f.app.ctx.state.transaction(
      async (tx) =>
        await tx.run(
          'INSERT INTO research_cycles(id,project_id,record,predecessor_id) VALUES(?,?,?,?)',
          id,
          f.owner.projectId,
          '{}',
          predecessorId,
        ),
    );
  await follow('research_follower', first.id);
  assert.equal((await f.research.get(f.owner, first.id)).successorId, 'research_follower');
  await assert.rejects(async () => await follow('research_rival', first.id));
  // Hand-made cycles follow nothing, and any number of them may.
  assert.equal((await f.create()).origin, null);
  for (const id of [first.id, 'research_follower'])
    await assert.rejects(
      async () =>
        await f.app.ctx.state.transaction(
          async (tx) =>
            await tx.run('UPDATE research_cycles SET predecessor_id=? WHERE id=?', 'other', id),
        ),
    );
});

test('a cycle digest is stored once, read back as artifact metadata, and never rewritten', async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  assert.equal(first.digest, null);
  assert.equal(first.previousCycleId, null);
  const artifact = await f.app.ctx.artifacts.create(f.owner, {
    title: 'Cycle digest',
    content: '{"formatVersion":1}',
    mediaType: 'application/json',
  });
  const write = async (value: string | null) =>
    await f.app.ctx.state.transaction(
      async (tx) =>
        await tx.run(
          'UPDATE research_cycles SET digest=? WHERE id=? AND digest IS NULL',
          value,
          first.id,
        ),
    );
  assert.equal((await write(JSON.stringify(artifact))).changes, 1);
  assert.deepEqual((await f.research.get(f.owner, first.id)).digest, artifact);
  // The guarded write a late composer uses finds nothing to do; an unguarded one is refused.
  assert.equal((await write('{}')).changes, 0);
  for (const value of ['{}', null])
    await assert.rejects(
      async () =>
        await f.app.ctx.state.transaction(
          async (tx) =>
            await tx.run('UPDATE research_cycles SET digest=? WHERE id=?', value, first.id),
        ),
      /A research cycle digest is immutable/,
    );
});

const digestOf = async (f: Awaited<ReturnType<typeof fixture>>, record: ResearchRecord) => {
  const read = await f.app.ctx.artifacts.read(f.owner, record.digest!.id);
  assert.equal(read.artifact.mediaType, 'application/json');
  assert.ok(read.content.length <= 12000);
  return { digest: JSON.parse(read.content) as ResearchDigest, content: read.content };
};

test('completing a cycle digests what it decided, once, without naming anyone', async (t) => {
  const f = await fixture(t);
  await f.definition();
  let record = await f.advance(await f.advance(await f.create()));
  assert.equal(record.digest, null);
  await f.reflect(record);
  const completing = {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: 'complete-and-digest',
  };
  record = await f.research.advance(f.owner, completing);
  assert.equal(record.workflow.state, 'complete');
  const { digest, content } = await digestOf(f, record);
  const approved = await f.app.ctx.reflections.approved(f.owner, record.reflectionId!);
  assert.deepEqual(digest.cycle, {
    id: record.id,
    name: record.name,
    outcome: 'complete',
    reason: null,
    createdAt: record.createdAt,
    composedAt: digest.cycle.composedAt,
    late: false,
  });
  assert.deepEqual(digest.reflection!.changeSpec, {
    id: approved.changeSpec.id,
    title: approved.changeSpec.title,
    hash: approved.changeSpec.hash,
  });
  assert.equal(digest.reflection!.reviewId, approved.reviewId);
  assert.equal(digest.consolidation, null);
  assert.equal(digest.omitted, 0);
  // Handing the digest to a later worker or reviewer must say nothing about who did the work.
  for (const actor of await f.app.ctx.scope.actors(f.owner))
    assert.ok(!content.includes(actor.id), `the digest names actor ${actor.id}`);
  const artifacts = (await f.app.ctx.artifacts.list(f.owner)).length;
  assert.equal((await f.research.advance(f.owner, completing)).digest!.id, record.digest!.id);
  assert.equal((await f.app.ctx.artifacts.list(f.owner)).length, artifacts);
  const guidance = await f.app.ctx.workflows.evaluate(f.owner, record.id);
  assert.ok(
    guidance.references.some(
      (reference) => reference.id === record.digest!.id && reference.label === 'Cycle digest',
    ),
  );
});

test('a consolidated cycle digests each consolidation decision', async (t) => {
  const f = await fixture(t);
  const experiment = await f.app.ctx.experiments.create(f.owner, {
    name: 'ruled-out',
    intent: 'Evaluate whether the approach is feasible',
    requestId: f.id(),
  });
  await f.definition();
  // A cycle from before consolidation became optional consolidates without a Git workspace.
  let record = await f.advance(await f.advance(await f.legacy()));
  await f.app.ctx.experiments.attach(f.owner, {
    experimentId: experiment.id,
    artifactId: (await f.artifact(f.owner, 'Plan')).id,
    role: 'plan',
    path: 'plan.md',
    attemptIndex: 1,
    expectedRevision: 0,
    requestId: f.id(),
  });
  await f.reflect(record);
  const current = await f.app.ctx.experiments.get(f.owner, experiment.id);
  await f.app.ctx.experiments.transition(f.owner, {
    experimentId: current.id,
    expectedRevision: current.workflow.revision,
    transition: 'abandon',
    evidence: { reason: 'The feasibility analysis ruled out this approach.' },
    requestId: f.id(),
  });
  record = await f.advance(record);
  const rationale = 'Its code encodes the approach the analysis ruled out.';
  await f.consolidate(record, [{ experimentId: experiment.id, decision: 'drop', rationale }]);
  record = await f.advance(record);
  const { digest } = await digestOf(f, record);
  assert.equal(digest.consolidation!.id, record.consolidationId);
  assert.deepEqual(
    digest.experiments.map(({ id, state, decision, rationale }) => ({
      id,
      state,
      decision,
      rationale,
    })),
    [{ id: experiment.id, state: 'abandoned', decision: 'drop', rationale }],
  );
  assert.deepEqual(digest.dropped, [experiment.id]);
  assert.equal(digest.claims, undefined);
  assert.equal(digest.openQuestions, undefined);
});

test('an ended cycle digests its reason and the selected work it leaves unfinished', async (t) => {
  const f = await fixture(t);
  const task = await f.app.ctx.tasks.create(f.owner, {
    title: 'Survey the corpus',
    goal: 'List what the frozen corpus contains.',
    checks: ['The list exists'],
    requestId: f.id(),
  });
  const cycle = await f.research.create(f.owner, {
    name: 'Cut short',
    dependsOn: [task.id],
    requestId: f.id(),
  });
  const reason = 'The corpus was withdrawn before the survey finished.';
  const ended = await f.research.end(f.owner, {
    researchId: cycle.id,
    expectedRevision: cycle.workflow.revision,
    outcome: 'failed',
    reason,
    requestId: f.id(),
  });
  const { digest } = await digestOf(f, ended);
  assert.equal(digest.cycle.outcome, 'failed');
  assert.equal(digest.cycle.reason, reason);
  assert.equal(digest.reflection, null);
  assert.deepEqual(digest.tasks, [{ id: task.id, title: task.title, state: task.workflow.state }]);
  assert.deepEqual(digest.carriedOver, [task.id]);
});

test('a digest stays within its bound by leaving entries out and counting them', async (t) => {
  const f = await fixture(t);
  const dependsOn: string[] = [];
  for (let index = 0; index < 60; index++)
    dependsOn.push(
      (
        await f.app.ctx.tasks.create(f.owner, {
          title: `${'A long title that fills the digest. '.repeat(8)}${index}`,
          goal: 'Fill the digest.',
          checks: ['It is full'],
          requestId: f.id(),
        })
      ).id,
    );
  const cycle = await f.research.create(f.owner, { name: 'Wide', dependsOn, requestId: f.id() });
  const ended = await f.research.end(f.owner, {
    researchId: cycle.id,
    expectedRevision: cycle.workflow.revision,
    outcome: 'abandoned',
    reason: 'Too wide to finish.',
    requestId: f.id(),
  });
  const { digest } = await digestOf(f, ended);
  assert.ok(digest.omitted > 0);
  assert.equal(digest.tasks.length + digest.carriedOver.length + digest.omitted, 120);
});

test('ending and completing never wait for a digest; the successor composes it late', async (t) => {
  const f = await fixture(t);
  await f.rebind(false);
  const end = async (name: string) => {
    const cycle = await f.research.create(f.owner, { name, requestId: f.id() });
    return await f.research.end(f.owner, {
      researchId: cycle.id,
      expectedRevision: cycle.workflow.revision,
      outcome: 'abandoned',
      reason: 'Nothing was worth selecting.',
      requestId: f.id(),
    });
  };
  const first = await end('Undigested');
  assert.equal(first.workflow.state, 'abandoned');
  assert.equal(first.digest, null);
  // The caller asked for the digest to be carried forward, so here its absence is refused.
  const following = { name: 'Successor', previousCycleId: first.id, requestId: 'follow-first' };
  await assert.rejects(async () => await f.research.create(f.owner, following), {
    code: 'artifacts_unavailable',
  });
  assert.equal((await f.research.list(f.owner)).length, 1);
  await f.rebind(true);
  // Any writer may follow a finished cycle: the digest is the server's composition, not theirs.
  const writer = await f.issue('producer');
  const successor = await f.research.create(writer, following);
  assert.equal(successor.previousCycleId, first.id);
  assert.equal(successor.origin, null);
  const digested = await f.research.get(f.owner, first.id);
  assert.equal(digested.successorId, successor.id);
  const { digest } = await digestOf(f, digested);
  assert.equal(digest.cycle.late, true);
  assert.equal(digest.cycle.reason, 'Nothing was worth selecting.');
  assert.deepEqual(await f.research.create(writer, following), successor);
  await assert.rejects(
    async () =>
      await f.research.create(f.owner, { ...following, name: 'Rival', requestId: 'rival' }),
    { code: 'previous_cycle_followed', status: 409 },
  );
});

test('only a finished cycle of this project can be followed, and never by a leased worker', async (t) => {
  const f = await fixture(t);
  const open = await f.create();
  const follow = async (caller: Caller, previousCycleId: string) =>
    await f.research.create(caller, { name: 'Successor', previousCycleId, requestId: f.id() });
  await assert.rejects(async () => await follow(f.owner, open.id), {
    code: 'previous_cycle_open',
    status: 409,
  });
  await assert.rejects(async () => await follow(f.owner, 'research_unknown'), {
    code: 'research_not_found',
    status: 404,
  });
  const ended = await f.research.end(f.owner, {
    researchId: open.id,
    expectedRevision: open.workflow.revision,
    outcome: 'abandoned',
    reason: 'Stopped.',
    requestId: f.id(),
  });
  const other = await f.app.ctx.scope.bootstrap({ projectName: 'Other', actorName: 'Other' });
  await assert.rejects(
    async () =>
      await follow(
        {
          projectId: other.project.id,
          actorId: other.actor.id,
          credentialId: other.credential.id,
        },
        ended.id,
      ),
    { code: 'research_not_found', status: 404 },
  );
  await assert.rejects(
    async () => await follow({ ...f.owner, session: { id: 'session_leased' } }, ended.id),
    { code: 'forbidden', status: 403 },
  );
  assert.equal((await f.research.get(f.owner, ended.id)).successorId, null);
});

test('lineage reads the cycles before this one, oldest first, and the one after', async (t) => {
  const f = await fixture(t);
  let previousCycleId: string | undefined;
  const ids: string[] = [];
  for (let index = 0; index < 22; index++) {
    const cycle = await f.research.create(f.owner, {
      name: `Cycle ${index}`,
      ...(previousCycleId ? { previousCycleId } : {}),
      requestId: f.id(),
    });
    ids.push(cycle.id);
    if (index === 21) break;
    await f.research.end(f.owner, {
      researchId: cycle.id,
      expectedRevision: cycle.workflow.revision,
      outcome: 'abandoned',
      reason: 'Superseded by the next cycle.',
      requestId: f.id(),
    });
    previousCycleId = cycle.id;
  }
  const reader = await f.issue('reader');
  const short = await f.research.lineage(reader, ids[2]!);
  assert.deepEqual(
    short.cycles.map((cycle) => cycle.id),
    ids.slice(0, 3),
  );
  assert.equal(short.truncated, false);
  assert.equal(short.successor!.id, ids[3]);
  assert.ok(short.cycles.every((cycle) => cycle.digest && cycle.state === 'abandoned'));
  const long = await f.research.lineage(reader, ids[21]!);
  assert.deepEqual(
    long.cycles.map((cycle) => cycle.id),
    ids.slice(2),
  );
  assert.equal(long.truncated, true);
  assert.equal(long.successor, null);
  assert.equal(long.cycles.at(-1)!.digest, null);
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

test('a research cycle that cannot reach an answer can be ended', async (t) => {
  const f = await fixture(t);
  // A preflight carries the bound fields beside the choice; refusing them there would report
  // an action blocked that the call then accepts.
  const preflight = async (id: string, revision: number) =>
    await f.app.ctx.workflows.evaluate(f.owner, id, {
      action: 'end',
      input: { researchId: id, expectedRevision: revision, outcome: 'abandoned', reason: 'No.' },
    });
  const cycle = await f.research.create(f.owner, {
    name: 'A question that cannot be answered',
    dependsOn: [],
    requestId: 'endable',
  });
  const guidance = await f.app.ctx.workflows.evaluate(f.owner, cycle.id);
  assert.ok(
    guidance.actions.some((action) => action.action === 'end'),
    'a cycle offers a way to end from every stage before complete',
  );
  assert.equal((await preflight(cycle.id, cycle.workflow.revision)).nextAction?.action, 'end');
  const ended = await f.research.end(f.owner, {
    researchId: cycle.id,
    expectedRevision: cycle.workflow.revision,
    outcome: 'abandoned',
    reason: 'The question stopped being worth pursuing before any work was selected.',
    requestId: 'end-it',
  });
  assert.equal(ended.workflow.state, 'abandoned');
  assert.equal((await f.app.ctx.workflows.evaluate(f.owner, cycle.id)).terminal, true);
  assert.ok((await f.app.ctx.workflows.overview(f.owner)).terminal.includes(cycle.id));
  await assert.rejects(
    async () =>
      await f.research.advance(f.owner, {
        researchId: cycle.id,
        expectedRevision: ended.workflow.revision,
        requestId: 'advance-after-end',
      }),
    { code: 'invalid_transition' },
  );
});

test('a consolidation can hold every prerequisite a cycle is allowed to give it', () => {
  // research.create takes up to 100 consolidationDependsOn and the advance adds the cycle's
  // own reflection, so a child cap of 100 made a 100-prerequisite cycle refuse its own
  // consolidation on every attempt while reporting the advance ready.
  const parse = (value: unknown) =>
    consolidationCreateSchema.safeParse({
      sourceArtifactIds: ['art_1'],
      name: 'Child',
      requestId: 'r',
      dependsOn: value,
    });
  assert.equal(parse(Array.from({ length: 101 }, (_, i) => `wf_${i}`)).success, true);
  assert.equal(
    parse(Array.from({ length: CONSOLIDATION_LIMITS.dependsOn + 1 }, (_, i) => `wf_${i}`)).success,
    false,
  );
});

for (const backend of backends)
  for (const hosted of [false, true])
    test(
      `${backend}: research hands task scope to consolidation and its owner routes ${hosted ? 'hosted' : 'unhosted'} Git work`,
      optional(backend),
      async (t) => {
        const f = await fixture(t, backend);
        const { state, tasks, reviews, code, scope, sessions, workflows } = f.app.ctx;
        await f.definition();
        let task = await tasks.create(f.owner, {
          title: 'Cycle task',
          goal: 'Retain a checked result.',
          checks: ['Result is retained.'],
          requestId: f.id(),
        });
        const evidence = await f.artifact(f.owner, 'Task result');
        task = await tasks.submitDelivery(f.owner, {
          ...confirmedDelivery({ taskId: task.id, artifactIds: [evidence.id] }),
          expectedRevision: task.workflow.revision,
          requestId: f.id(),
        });
        const claim = await reviews.start(f.reviewer, task.reviewId!);
        await reviews.apply(f.reviewer, {
          reviewId: claim.id,
          claimId: claim.claimId!,
          expectedRevision: task.workflow.revision,
          verdict: 'pass',
          notes: 'Checked.',
          synopsis: 'The retained task result satisfies the check.',
          findings: claim.criteria.map((_, i) => ({
            criterionNumber: i + 1,
            status: 'met',
            evidenceIds: [evidence.id],
            notes: 'Checked.',
          })),
          requestId: f.id(),
        });
        if (hosted) {
          const source = gitSource(t);
          const main = source.commit({ 'main.txt': 'main' });
          const root = join(source.directory, 'code');
          mkdirSync(join(root, 'tmp'), { recursive: true });
          mkdirSync(join(root, 'empty-template'));
          const repositories = new CodeRepositories({
            root,
            quotaBytes: 1024 ** 3,
            reservedFreeBytes: 1,
          });
          await repositories.ensure(f.owner.projectId, 'repository', 'sha1');
          source.git(
            'push',
            repositories.paths(f.owner.projectId).repository,
            `${main}:refs/heads/main`,
          );
          t.after(() => repositories.git.close());
          await boundProject(state, f.owner.projectId, main, 'repository');
          await state.transaction((tx) =>
            tx.run(
              'UPDATE code_projects SET store_json=?,main_json=? WHERE project_id=?',
              JSON.stringify({ format: 1, objectFormat: 'sha1', rootOid: main }),
              JSON.stringify({ oid: main, operationId: 'fixture', stored: true }),
              f.owner.projectId,
            ),
          );
          (code as unknown as { consolidationStore: CodeConsolidation }).consolidationStore =
            new CodeConsolidation(state, scope, workflows, sessions, () => repositories);
        }
        let cycle = await f.research.create(f.owner, {
          name: 'Cycle with a task',
          dependsOn: [task.id],
          consolidationWorkspace: 'git',
          requestId: f.id(),
        });
        cycle = await f.advance(cycle);
        cycle = await f.advance(cycle);
        await f.reflect(cycle);
        const input = {
          researchId: cycle.id,
          expectedRevision: cycle.workflow.revision,
          requestId: f.id(),
        };
        cycle = await f.research.advance(f.owner, input);
        const child = await f.app.ctx.consolidation.get(f.owner, cycle.consolidationId!);
        assert.equal(child.workflow.version, hosted ? 5 : 4);
        if (hosted) {
          assert.deepEqual(child.taskIds, [task.id]);
          assert.deepEqual(
            child.candidates!.candidates.map((candidate) => candidate.unitId),
            [task.id],
          );
          assert.equal(child.workflow.state, 'deciding');
        } else {
          assert.equal(child.taskIds, undefined);
          assert.equal(child.candidates, undefined);
          assert.equal(child.workflow.state, 'consolidating');
        }
        assert.deepEqual(await f.research.advance(f.owner, input), cycle);
      },
    );

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
  // Whether an approved plan waits for an answer is Reflections' to say. Without it the cycle
  // does not guess: the owner either restores it or says outright that nothing is to be created.
  f.research.bindReflections(f.app.ctx.reflections)();
  record = await f.research.get(f.owner, record.id);
  await assert.rejects(f.advance(record), { code: 'reflections_unavailable' });
  record = await f.research.advance(f.owner, {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: f.id(),
    nextWave: 'skip',
  });
  assert.equal(record.workflow.state, 'complete');
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

const planned = (
  overrides: Partial<Extract<ChangeSpec, { version: 2 }>> = {},
): Extract<ChangeSpec, { version: 2 }> => ({
  version: 2,
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
      workspace: { provider: 'none' },
      title: 'Freeze the comparison corpus',
      goal: 'Select and freeze the documents the ordering experiment will read.',
      checks: ['The corpus manifest is retained as an artifact'],
      dependsOn: [],
      rationale: 'The evidence lens found the corpus drifting between runs.',
    },
    {
      key: 'harness',
      kind: 'task',
      workspace: { provider: 'none' },
      title: 'Show the harness runs on one document',
      goal: 'Run the harness end to end on a single document.',
      checks: ['One complete run is retained'],
      dependsOn: [],
      rationale: 'Cheap feasibility before the experiment spends compute.',
    },
    {
      key: 'ordering',
      kind: 'experiment',
      workspace: { provider: 'none' },
      name: 'ordering-effect',
      question: 'Does input ordering change the ranking?',
      details: '',

      dependsOn: ['corpus', 'harness'],
      rationale: 'The method lens named ordering as the untested confound.',
    },
    {
      key: 'writeup',
      kind: 'task',
      workspace: { provider: 'none' },
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
async function reflected(f: Awaited<ReturnType<typeof fixture>>, plan: ChangeSpec, git = false) {
  await f.definition();
  let record = await f.advance(await f.advance(await f.create(git ? 'git' : 'none')));
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

test('completing a cycle with nextWave create opens the approved plan as work and the next cycle', async (t) => {
  const f = await fixture(t);
  const carried = await f.app.ctx.tasks.create(f.owner, {
    title: 'Work already under way',
    goal: 'Finish what the last wave started.',
    checks: ['It is finished'],
    requestId: f.id(),
  });
  const plan = planned({ carriedOver: [{ workflowId: carried.id, reason: 'Still needed.' }] });
  const { record, command } = await reflected(f, plan);
  const before = await counts(f);

  // An advance that does not answer the plan creates nothing, whoever sends it.
  const guidance = await f.app.ctx.workflows.evaluate(f.owner, record.id);
  assert.equal(guidance.nextAction?.status, 'needs_input');
  assert.deepEqual(guidance.nextAction?.requiredInput, ['nextWave']);
  await assert.rejects(f.research.advance(f.owner, command()), {
    code: 'next_wave_choice_required',
  });
  assert.deepEqual(await counts(f), before);
  assert.equal(
    (
      await f.app.ctx.workflows.evaluate(f.owner, record.id, {
        action: 'advance_reflecting',
        input: { ...command('create') },
      })
    ).nextAction?.status,
    'ready',
  );

  // A leased worker never reaches the plan.
  await assert.rejects(
    f.research.advance({ ...f.owner, session: { id: 'session_leased' } }, command('create')),
    { code: 'forbidden' },
  );
  assert.deepEqual(await counts(f), before);

  const input = command('create');
  const done = await f.research.advance(f.owner, input);
  assert.equal(done.workflow.state, 'complete');
  assert.ok(done.successorId);
  const successor = await f.research.get(f.owner, done.successorId);
  assert.equal(successor.workflow.state, 'defining');
  assert.equal(successor.name, 'Ordering effect');
  assert.equal(successor.previousCycleId, done.id);
  assert.equal(done.previousCycleId, null);
  const origin = successor.origin!;
  const approved = await f.app.ctx.reflections.approved(f.owner, record.reflectionId!);
  assert.deepEqual(
    { ...origin, items: origin.items.map((item) => [item.key, item.kind]) },
    {
      researchId: record.id,
      reflectionId: approved.id,
      reviewId: approved.reviewId,
      changeSpec: { id: approved.changeSpec.id, hash: approved.changeSpec.hash },
      items: [
        ['corpus', 'task'],
        ['harness', 'task'],
        ['ordering', 'experiment'],
        ['writeup', 'task'],
      ],
      carriedOver: [carried.id],
    },
  );
  const ids = Object.fromEntries(origin.items.map((item) => [item.key, item.id]));
  assert.deepEqual(
    [...successor.researchDependencies].sort(),
    [...Object.values(ids), carried.id].sort(),
  );
  const depends = async (id: string) =>
    (await f.app.ctx.workflows.dependencies(f.owner, id)).dependencies.map((entry) => entry.id);
  assert.deepEqual((await depends(ids.ordering)).sort(), [ids.corpus, ids.harness].sort());
  assert.deepEqual(await depends(ids.writeup), [ids.ordering]);
  const writeup = await f.app.ctx.tasks.get(f.owner, ids.writeup);
  assert.ok(
    writeup.goal.endsWith(
      `Origin: reflection ${approved.id}, change specification ${approved.changeSpec.id} (${approved.changeSpec.hash}), item writeup.`,
    ),
  );
  assert.match(writeup.goal, /\n\nWhy: The result must reach the paper\.\n\n/);
  const experiment = await f.app.ctx.experiments.get(f.owner, ids.ordering);
  assert.equal(experiment.intent, 'Does input ordering change the ranking?');
  assert.match(experiment.details, /^Why: .*item ordering\.$/s);
  assert.deepEqual((await advanced(f, record.id)).at(-1), {
    from: 'reflecting',
    to: 'complete',
    children: [],
    successorId: successor.id,
  });
  assert.ok(
    (await f.app.ctx.workflows.evaluate(f.owner, record.id)).references.some(
      (reference) => reference.id === successor.id && reference.label === 'Next research cycle',
    ),
  );

  // The same request is the same records, across a restart; another request finds it complete.
  const after = await counts(f);
  assert.deepEqual(after, {
    tasks: before.tasks + 3,
    experiments: before.experiments + 1,
    cycles: before.cycles + 1,
  });
  assert.deepEqual(await f.research.advance(f.owner, input), done);
  await f.restart();
  assert.deepEqual(await f.research.advance(f.owner, input), done);
  assert.deepEqual(await counts(f), after);
  await assert.rejects(
    f.research.advance(f.owner, {
      researchId: done.id,
      expectedRevision: done.workflow.revision,
      requestId: f.id(),
      nextWave: 'create',
    }),
    { code: 'research_complete' },
  );
  assert.deepEqual(await counts(f), after);
});

test('a plan that cannot be created rolls the whole advance back, and skip completes the cycle', async (t) => {
  const f = await fixture(t);
  const plan = planned();
  plan.items[2] = {
    ...plan.items[2],
    kind: 'experiment',
    name: 'already-exists',
  } as never;
  const { record, command } = await reflected(f, plan);
  await f.app.ctx.experiments.create(f.owner, {
    name: 'already-exists',
    intent: 'Earlier work',
    requestId: f.id(),
  });
  const before = await counts(f);
  await assert.rejects(
    f.research.advance(f.owner, command('create')),
    (error: { status: number }) => {
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.deepEqual(await counts(f), before);
  const kept = await f.research.get(f.owner, record.id);
  assert.equal(kept.workflow.state, 'reflecting');
  assert.equal(kept.workflow.revision, record.workflow.revision);

  const skipped = await f.research.advance(f.owner, command('skip'));
  assert.equal(skipped.workflow.state, 'complete');
  assert.equal(skipped.successorId, null);
  assert.deepEqual(await counts(f), before);
  assert.deepEqual((await advanced(f, record.id)).at(-1), {
    from: 'reflecting',
    to: 'complete',
    children: [],
    nextWave: 'skipped',
  });
});

test('materialised work rolls back with the caller transaction', async (t) => {
  const f = await fixture(t);
  const { record, command } = await reflected(f, planned());
  const before = await counts(f);
  const input = command('create');
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(async (tx) => {
        await f.research.advance(f.owner, input, tx);
        throw new Error('caller rollback');
      }),
    /caller rollback/,
  );
  assert.deepEqual(await counts(f), before);
  assert.equal((await f.research.get(f.owner, record.id)).workflow.state, 'reflecting');
  assert.ok((await f.research.advance(f.owner, input)).successorId);
});

test('a stop plan and a text change specification complete as before and ignore nextWave', async (t) => {
  const f = await fixture(t);
  const stop = planned({
    next: { decision: 'stop', reason: 'goal_met', rationale: 'The question is answered.' },
    items: [],
  });
  const { record, command } = await reflected(f, stop);
  const before = await counts(f);
  assert.equal(
    (await f.app.ctx.workflows.evaluate(f.owner, record.id)).nextAction?.status,
    'ready',
  );
  const done = await f.research.advance(f.owner, command());
  assert.equal(done.workflow.state, 'complete');
  assert.equal(done.successorId, null);
  assert.deepEqual(await counts(f), before);
  // The digest carries the decision and what the plan turned down, not the plan itself.
  const decided = (await digestOf(f, done)).digest;
  assert.deepEqual(decided.reflection!.next, {
    decision: 'stop',
    reason: 'goal_met',
    rationale: 'The question is answered.',
  });
  assert.deepEqual(decided.rejected, stop.rejected);

  // Nothing to create: the choice is accepted and creates nothing.
  let text = await f.advance(await f.advance(await f.create()));
  await f.reflect(text);
  text = await f.research.advance(f.owner, {
    researchId: text.id,
    expectedRevision: text.workflow.revision,
    requestId: f.id(),
    nextWave: 'create',
  });
  assert.equal(text.workflow.state, 'complete');
  assert.equal(text.successorId, null);
  assert.deepEqual(await counts(f), { ...before, cycles: before.cycles + 1 });
  const prose = (await digestOf(f, text)).digest;
  assert.deepEqual([prose.reflection!.next, prose.rejected], [null, []]);
});

test('a consolidated cycle creates the plan when consolidation completes, not at the handoff', async (t) => {
  const f = await fixture(t);
  await f.definition();
  // Before version 3 every cycle consolidates, so this is where a retained v2 cycle continues.
  let record = await f.advance(await f.advance(await f.legacy()));
  assert.equal(record.workflow.version, 2);
  await f.reflect(record, planned());
  const before = await counts(f);
  // The handoff to consolidation is not a completion: it asks nothing and creates nothing.
  record = await f.advance(record);
  assert.equal(record.workflow.state, 'consolidating');
  assert.deepEqual(await counts(f), before);
  await f.consolidate(record);
  await assert.rejects(f.advance(record), { code: 'next_wave_choice_required' });
  record = await f.research.advance(f.owner, {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: f.id(),
    nextWave: 'create',
  });
  assert.equal(record.workflow.state, 'complete');
  const successor = await f.research.get(f.owner, record.successorId!);
  assert.equal(successor.origin?.items.length, 4);
  // What follows a retained cycle is a cycle of today.
  assert.equal(successor.workflow.version, 5);

  let git = await f.advance(await f.advance(await f.create('git')));
  await f.reflect(git, planned({ items: planned().items.slice(0, 1) }));
  const waiting = await counts(f);
  git = await f.advance(git);
  assert.equal(git.workflow.state, 'consolidating');
  assert.deepEqual(await counts(f), waiting);
});

test('what would refuse the plan is reported before the advance, and skip is always a way on', async (t) => {
  const f = await fixture(t);
  const carried = await f.app.ctx.tasks.create(f.owner, {
    title: 'Work already under way',
    goal: 'Finish what the last wave started.',
    checks: ['It is finished'],
    requestId: f.id(),
  });
  const { record, command } = await reflected(
    f,
    planned({ carriedOver: [{ workflowId: carried.id, reason: 'Still needed.' }] }),
  );
  const before = await counts(f);
  const refused = async (code: string) => {
    const preflight = await f.app.ctx.workflows.evaluate(f.owner, record.id, {
      action: 'advance_reflecting',
      input: command('create'),
    });
    assert.equal(preflight.nextAction, null);
    assert.equal(preflight.blockers[0].code, code);
    await assert.rejects(f.research.advance(f.owner, command('create')), { code });
    assert.deepEqual(await counts(f), before);
  };

  f.research.bindTasks(f.app.ctx.tasks)();
  await refused('tasks_unavailable');
  f.research.bindTasks(f.app.ctx.tasks);
  f.research.bindExperiments(f.app.ctx.experiments)();
  await refused('experiments_unavailable');
  f.research.bindExperiments(f.app.ctx.experiments);

  // Another wave pauses the very starts the plan needs.
  await f.research.startReflection(f.owner, { requestId: f.id() });
  await refused('reflection_open');
  f.research.bindTasks(f.app.ctx.tasks)();
  const skipped = await f.research.advance(f.owner, command('skip'));
  assert.equal(skipped.workflow.state, 'complete');
  assert.equal(skipped.successorId, null);
  assert.deepEqual(await counts(f), before);
});

test('failed carried-over work remains evidence, while a project full of experiments refuses the plan', async (t) => {
  const f = await fixture(t);
  const dead = await f.app.ctx.tasks.create(f.owner, {
    title: 'Work that will die',
    goal: 'Be carried over and then fail.',
    checks: ['It is finished'],
    requestId: f.id(),
  });
  const { record, command } = await reflected(
    f,
    planned({ carriedOver: [{ workflowId: dead.id, reason: 'Still needed.' }] }),
  );
  const code = async () =>
    (
      await f.app.ctx.workflows.evaluate(f.owner, record.id, {
        action: 'advance_reflecting',
        input: command('create'),
      })
    ).blockers[0]?.code;
  assert.equal(await code(), undefined);
  // A failed carried-over task is an outcome for the next reflection.
  await f.app.ctx.tasks.markFailed(f.owner, {
    taskId: dead.id,
    expectedRevision: (await f.app.ctx.tasks.get(f.owner, dead.id)).workflow.revision,
    reason: 'The approach it depended on was withdrawn.',
    requestId: f.id(),
  });
  assert.equal(await code(), undefined);
  for (let index = 0; index < 7; index++)
    await f.app.ctx.experiments.create(f.owner, {
      name: `filler-${index}`,
      intent: 'Occupies an active slot.',
      requestId: f.id(),
    });
  assert.equal(await code(), 'experiment_limit');
  await assert.rejects(f.research.advance(f.owner, command('create')), {
    code: 'experiment_limit',
  });
});

test('a plan at its size limits is created whole, and a taken experiment name refuses it first', async (t) => {
  const f = await fixture(t);
  const fill = (length: number) => 'x'.repeat(length);
  const plan = planned();
  plan.items = plan.items.map((item) => ({
    ...item,
    rationale: fill(1000),
    ...(item.kind === 'task'
      ? {
          title: fill(200),
          goal: fill(4000),
          // Checks that differ only where Tasks still tells them apart.
          checks: Array.from({ length: 12 }, (_, i) => `${i} `.padEnd(500, 'c')),
        }
      : { details: fill(4000) }),
  }));
  const { record, command } = await reflected(f, plan);
  const taken = await f.app.ctx.experiments.create(f.owner, {
    name: 'Ordering-Effect',
    intent: 'Holds the planned name in another case.',
    requestId: f.id(),
  });
  await assert.rejects(f.research.advance(f.owner, command('create')), {
    code: 'experiment_name_conflict',
  });
  assert.equal((await f.research.get(f.owner, record.id)).successorId, null);
  assert.ok(taken.id);

  const other = await fixture(t);
  const second = await reflected(other, plan);
  const done = await other.research.advance(other.owner, second.command('create'));
  const origin = (await other.research.get(other.owner, done.successorId!)).origin!;
  // The Origin line is what ties an agent's text to the reviewed plan; no cap may clip it.
  for (const item of origin.items) {
    const text =
      item.kind === 'task'
        ? (await other.app.ctx.tasks.get(other.owner, item.id)).goal
        : (await other.app.ctx.experiments.get(other.owner, item.id)).details;
    assert.ok(text.endsWith(`item ${item.key}.`));
    assert.ok(text.length > 5000 && text.length < 16000);
  }
});

test('a capability replaced while the plan is being created invalidates the whole advance', async (t) => {
  const f = await fixture(t);
  const { record, command } = await reflected(f, planned());
  const before = await counts(f);
  const input = command('create');
  const tasks = f.app.ctx.tasks;
  let entered = false;
  f.research.bindTasks({
    ...tasks,
    create: async (...args) => {
      const task = await tasks.create(...args);
      // Reflections was read earlier in this advance; what it said may no longer hold.
      if (!entered) f.research.bindReflections(f.app.ctx.reflections);
      entered = true;
      return task;
    },
  });
  await assert.rejects(f.research.advance(f.owner, input), { code: 'reflections_unavailable' });
  assert.deepEqual(await counts(f), before);
  assert.equal((await f.research.get(f.owner, record.id)).workflow.state, 'reflecting');
  const done = await f.research.advance(f.owner, input);
  assert.ok(done.successorId);
});

const workspacePlan = (): Extract<ChangeSpec, { version: 2 }> => ({
  ...planned(),
  version: 2,
  items: planned()
    .items.slice(0, 3)
    .map((item, index) => ({
      ...item,
      dependsOn: item.kind === 'experiment' ? ['harness'] : [],
      workspace: index === 0 ? { provider: 'none' } : { provider: 'code', version: 1 },
    })),
});

for (const backend of backends) {
  test(
    `${backend}: a mixed workspace plan is atomic, replayable and uses legacy Git until hosted`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const { record, command } = await reflected(f, workspacePlan());
      const before = await counts(f);
      const input = command('create');
      await assert.rejects(
        f.app.ctx.state.transaction(async (tx) => {
          const done = await f.research.advance(f.owner, input, tx);
          assert.ok(done.successorId);
          throw new Error('caller rollback');
        }),
        /caller rollback/,
      );
      assert.deepEqual(await counts(f), before);
      assert.equal((await f.research.get(f.owner, record.id)).successorId, null);
      const done = await f.research.advance(f.owner, input);
      const successor = await f.research.get(f.owner, done.successorId!);
      const ids = Object.fromEntries(successor.origin!.items.map((item) => [item.key, item.id]));
      const plain = await f.app.ctx.tasks.get(f.owner, ids.corpus);
      const coded = await f.app.ctx.tasks.get(f.owner, ids.harness);
      const experiment = await f.app.ctx.experiments.get(f.owner, ids.ordering);
      assert.equal(plain.workspace, undefined);
      assert.equal(coded.workspace, 'git');
      assert.equal(coded.workflow.version, 3);
      assert.equal(coded.baseTaskId, undefined);
      assert.equal(experiment.workspace, 'git');
      assert.equal(experiment.workflow.version, 6);
      assert.equal(experiment.workflow.data.baseTaskId, undefined);
      assert.deepEqual(
        (await f.app.ctx.workflows.dependencies(f.owner, experiment.id)).dependencies.map(
          (item) => item.id,
        ),
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
    },
  );

  for (const firstCode of ['task', 'experiment'] as const)
    test(
      `${backend}: Code absence refuses a ${firstCode} declaration without losing approval or partial work`,
      optional(backend),
      async (t) => {
        const f = await fixture(t, backend);
        const plan = workspacePlan();
        if (firstCode === 'experiment') plan.items[1].workspace = { provider: 'none' };
        const { record, command } = await reflected(f, plan);
        const approved = await f.app.ctx.reflections.approved(f.owner, record.reflectionId!);
        const before = await counts(f);
        await f.app.setEnabled('code', false);
        const input = command('create');
        await assert.rejects(f.research.advance(f.owner, input), { code: 'code_unavailable' });
        assert.deepEqual(await counts(f), before);
        assert.deepEqual(
          await f.app.ctx.reflections.approved(f.owner, record.reflectionId!),
          approved,
        );
        assert.equal(
          (await f.research.get(f.owner, record.id)).workflow.revision,
          record.workflow.revision,
        );
        await f.app.setEnabled('code', true);
        assert.ok((await f.research.advance(f.owner, input)).successorId);
      },
    );

  test(
    `${backend}: v1 plans keep their exact hash and workspace-free behavior with Code unloaded`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.app.setEnabled('code', false);
      const current = planned();
      const { record, command } = await reflected(f, current);
      const plan: ChangeSpec = {
        ...current,
        version: 1,
        items: current.items.map(({ workspace: _workspace, ...item }) => item),
      };
      const changeSpec = await f.app.ctx.artifacts.create(f.owner, {
        title: 'Retained v1 specification',
        content: JSON.stringify(plan),
        mediaType: 'application/json',
      });
      const approved = {
        ...(await f.app.ctx.reflections.approved(f.owner, record.reflectionId!)),
        plan,
        changeSpec,
      };
      // Research consumes the retained owner contract without resubmitting it through a new wave.
      t.mock.method(f.app.ctx.reflections, 'approved', async () => approved);
      const done = await f.research.advance(f.owner, command('create'));
      const next = await f.research.get(f.owner, done.successorId!);
      assert.deepEqual(approved.plan, plan);
      assert.equal(next.origin!.changeSpec.hash, approved.changeSpec.hash);
      assert.equal(
        (await digestOf(f, done)).digest.reflection!.changeSpec.hash,
        approved.changeSpec.hash,
      );
      for (const item of next.origin!.items) {
        const work =
          item.kind === 'task'
            ? await f.app.ctx.tasks.get(f.owner, item.id)
            : await f.app.ctx.experiments.get(f.owner, item.id);
        assert.notEqual(work.workspace, 'git');
      }
    },
  );
}

for (const backend of backends)
  test(
    `${backend}: a materialised hosted experiment derives its base from its task's reviewed acceptance`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend, true);
      const source = gitSource(t);
      const main = source.commit({ 'README.md': 'Research harness\n' });
      const { code, sessions, tasks, workflows, artifacts } = f.app.ctx;
      const protocol = (code as CodeService).v2!;
      await boundProject(f.app.ctx.state, f.owner.projectId, main, 'fixture-repository');
      const complete = async (operation: CodeStoreOperation) => {
        for (let attempt = 0; operation.status === 'prepared' && attempt < 200; attempt++) {
          operation = (
            (await protocol.call(f.owner, `uploads/${operation.id}/complete`, {})) as {
              operation: CodeStoreOperation;
            }
          ).operation;
          if (operation.status === 'prepared') await delay(25);
        }
        assert.equal(operation.status, 'completed', JSON.stringify(operation));
        return operation;
      };
      const initial = source.bundle(main);
      const imported = await code.importRepository(f.owner, {
        source: 'bundle',
        tip: main,
        bundle: { sha256: initial.sha256, bytes: initial.bytes },
        requestId: f.id(),
      });
      await protocol.putPart(f.owner, imported.id, 0, initial.content);
      await complete(imported);
      const { command } = await reflected(f, workspacePlan());
      const done = await f.research.advance(f.owner, command('create'));
      const successor = await f.research.get(f.owner, done.successorId!);
      const ids = Object.fromEntries(successor.origin!.items.map((item) => [item.key, item.id]));
      let task = await tasks.get(f.owner, ids.harness);
      const experiment = await f.app.ctx.experiments.get(f.owner, ids.ordering);
      assert.equal(task.workflow.version, 5);
      assert.equal(experiment.workflow.version, 8);
      assert.equal(task.baseTaskId, undefined);
      assert.equal(experiment.workflow.data.baseTaskId, undefined);
      assert.equal((await code.unit(f.owner, experiment.id)).base, null);

      const heartbeat = async (caller: Caller, runnerId: string) =>
        sessions.heartbeatRunner(caller, {
          runnerId,
          machine: { hostname: runnerId, system: 'test', architecture: 'test' },
          platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 1 }],
          capacity: 1,
          capabilities: ['code.v2'],
        });
      await heartbeat(f.owner, 'producer');
      const secret = `ms_${randomBytes(32).toString('base64url')}`;
      const session = await sessions.offer(f.owner, {
        instanceId: task.id,
        expectedRevision: task.workflow.revision,
        runnerId: 'producer',
        requestId: f.id(),
        secret,
      });
      const control = { sessionId: session.id, runnerId: 'producer', hostRef: 'producer-launch' };
      const workspace: SessionWorkspace = {
        repositoryId: 'fixture-repository',
        workspaceId: task.id,
        mode: 'persistent',
        branch: `merv/work/${task.id}`,
        baseOid: main,
        headOid: main,
        stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
      };
      await sessions.attach(f.owner, { ...control, workspace });
      await f.app.ctx.domainEvents.drain();
      const worker = await sessions.authenticate(secret);
      const run = async <T>(
        caller: Caller,
        tool: string,
        input: Data,
        fn: (caller: Caller, input: Data) => Promise<T>,
      ) => sessions.run(await sessions.prepare(caller, tool, input), fn);
      const requested = await run(
        worker,
        'code.commit',
        { expectedHead: main, message: 'Build harness', requestId: f.id() },
        (caller, input) =>
          code.commit(caller, input as unknown as Parameters<typeof code.commit>[1]),
      );
      const queued = (await code.nextCommand(f.owner, control))!;
      assert.equal(queued.id, requested.command.id);
      const head = source.commit({ 'harness.ts': 'export const measured = 1;\n' });
      const bundle = source.bundle(head, [main]);
      const generation = (await code.unit(f.owner, task.id)).generation;
      const upload = (
        (await protocol.call(f.owner, 'uploads', {
          ...control,
          unitId: task.id,
          generation,
          leaseId: session.id,
          expectedHead: main,
          proposedHead: head,
          treeOid: source.git('rev-parse', `${head}^{tree}`),
          bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
          kind: 'checkpoint',
          commandId: queued.id,
          requestId: queued.id,
        })) as { operation: CodeStoreOperation }
      ).operation;
      await protocol.putPart(f.owner, upload.id, 0, bundle.content);
      await complete(upload);
      await code.completeCommand(f.owner, {
        ...control,
        commandId: queued.id,
        receipt: {
          commandId: queued.id,
          repositoryId: workspace.repositoryId,
          workspaceId: workspace.workspaceId,
          baseOid: main,
          parentOid: main,
          headOid: head,
          treeOid: source.git('rev-parse', `${head}^{tree}`),
          stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 0 },
        },
      });
      const evidence = await run(
        worker,
        'artifact.create',
        { title: 'Harness evidence', content: 'The harness runs.' },
        (caller, input) =>
          artifacts.create(caller, input as unknown as Parameters<typeof artifacts.create>[1]),
      );
      task = await run(
        worker,
        'task.submit_delivery',
        {
          ...confirmedDelivery({
            taskId: task.id,
            artifactIds: [evidence.id],
            commandId: queued.id,
          }),
          expectedRevision: task.workflow.revision,
          requestId: f.id(),
        },
        (caller, input) =>
          tasks.submitDelivery(
            caller,
            input as unknown as Parameters<typeof tasks.submitDelivery>[1],
          ),
      );
      await sessions.release(f.owner, { sessionId: session.id, runnerId: 'producer' });
      await f.app.ctx.domainEvents.drain();
      await complete(
        (
          (await protocol.call(f.owner, 'finalize', {
            ...control,
            unitId: task.id,
            generation,
            leaseId: session.id,
            expectedHead: head,
            proposedHead: head,
            treeOid: source.git('rev-parse', `${head}^{tree}`),
            bundle: null,
            kind: 'final',
          })) as { operation: CodeStoreOperation }
        ).operation,
      );
      const issuedReviewer = await f.app.ctx.scope.issueActor(f.owner, {
        name: 'Independent review machine',
        role: 'operator',
      });
      const reviewRunner: Caller = {
        projectId: f.owner.projectId,
        actorId: issuedReviewer.actor.id,
        credentialId: issuedReviewer.credential.id,
      };
      await heartbeat(reviewRunner, 'reviewer');
      const reviewSecret = `ms_${randomBytes(32).toString('base64url')}`;
      const reviewSession = await sessions.offer(reviewRunner, {
        instanceId: task.id,
        expectedRevision: task.workflow.revision,
        runnerId: 'reviewer',
        requestId: f.id(),
        secret: reviewSecret,
      });
      await sessions.attach(reviewRunner, {
        sessionId: reviewSession.id,
        runnerId: 'reviewer',
        hostRef: 'review-launch',
        workspace: {
          ...workspace,
          workspaceId: reviewSession.id,
          mode: 'ephemeral',
          branch: null,
          baseOid: head,
          headOid: head,
        },
      });
      const reviewer = await sessions.authenticate(reviewSecret);
      const review = await f.app.ctx.reviews.get(f.owner, task.reviewId!);
      await run(
        reviewer,
        'review.submit',
        {
          reviewId: review.id,
          claimId: review.claimId!,
          expectedRevision: task.workflow.revision,
          verdict: 'pass',
          notes: 'Verified the admitted harness commit.',
          synopsis:
            'The admitted harness was checked independently against the delivery and its checks.',
          findings: review.criteria.map((_, i) => ({
            criterionNumber: i + 1,
            status: 'met',
            evidenceIds: [evidence.id],
            notes: 'Ran the harness.',
          })),
          requestId: f.id(),
        },
        (caller, input) => f.app.ctx.reviews.apply(caller, input as unknown as ReviewApplication),
      );
      const accepted = (await code.unit(f.owner, task.id)).acceptance!;
      assert.equal(accepted.reference, head);
      assert.equal(accepted.storage, 'code');
      assert.ok(accepted.receipt);
      await f.app.ctx.domainEvents.drain();
      const planner = await sessions.offer(f.owner, {
        instanceId: experiment.id,
        expectedRevision: (await workflows.get(f.owner, experiment.id)).revision,
        runnerId: 'producer',
        secret: `ms_${randomBytes(32).toString('base64url')}`,
        requestId: f.id(),
      });
      const pin = (await code.unit(f.owner, experiment.id)).base!;
      assert.equal(pin.reference, accepted.reference);
      assert.notEqual(pin.reference, main);
      assert.deepEqual(pin.sources, [{ unitId: task.id, acceptanceHash: accepted.hash }]);
      await sessions.release(f.owner, { sessionId: planner.id, runnerId: 'producer' });
    },
  );

for (const backend of backends)
  test(
    `${backend}: an automatic v2 wave exposes Code absence and rolls back before retry`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await f.definition();
      const input = await f.app.ctx.tasks.create(f.owner, {
        title: 'Unavailable input',
        goal: 'Find input data.',
        checks: ['Data is available'],
        requestId: f.id(),
      });
      await f.app.ctx.tasks.markFailed(f.owner, {
        taskId: input.id,
        expectedRevision: input.workflow.revision,
        reason: 'The required data does not exist.',
        requestId: f.id(),
      });
      let record = await f.research.create(f.owner, {
        name: 'Automatic workspaces',
        dependsOn: [input.id],
        automatic: true,
        maxCycles: 2,
        requestId: f.id(),
      });
      record = await f.advance(await f.advance(record));
      await f.reflect(record, workspacePlan());
      const approved = await f.app.ctx.reflections.approved(f.owner, record.reflectionId!);
      const before = await counts(f);
      await f.app.setEnabled('code', false);
      const release = await f.research.bindAutomatic(f.app.ctx.domainEvents);
      try {
        await f.app.ctx.domainEvents.drain();
        const blocked = await f.research.get(f.owner, record.id);
        assert.equal(blocked.automation!.blocker!.code, 'code_unavailable');
        assert.equal(blocked.successorId, null);
        assert.deepEqual(await counts(f), before);
        assert.deepEqual(
          await f.app.ctx.reflections.approved(f.owner, record.reflectionId!),
          approved,
        );
        await f.app.setEnabled('code', true);
        await f.research.wakeAutomatic();
        await f.app.ctx.domainEvents.drain();
        const done = await f.research.get(f.owner, record.id);
        assert.ok(done.successorId);
        assert.equal(done.workflow.state, 'complete');
        assert.equal(done.automation!.blocker, null);
      } finally {
        await release();
      }
    },
  );
