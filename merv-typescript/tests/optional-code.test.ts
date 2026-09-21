import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, TaskReview } from '@merv/contracts';
import type { ResearchRecord } from '@merv/research/types';
import type { Reflection } from '@merv/reflections/types';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { boundProject } from './fixtures/code-binding.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

async function fixture(t: TestContext, enabled: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-optional-code-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  // Exercise the real server composition without opening HTTP listeners.
  config.plugins = config.plugins.filter(
    ({ id }) =>
      !['api', 'identity', 'ui'].includes(id) && !id.endsWith('-api') && !id.endsWith('-ui'),
  );
  config.plugins.find(({ id }) => id === 'code')!.disabled = !enabled;
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Optional Code', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const issued = await app.ctx.scope.issueActor(owner, { name: 'Reviewer', role: 'reviewer' });
  const reviewer: Caller = {
    projectId: owner.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  const source = await app.ctx.artifacts.create(owner, {
    title: 'Source',
    content: 'Retained research findings.',
  });
  const experiment = async (name: string, workspace: 'none' | 'git' = 'none') =>
    await app.ctx.experiments.create(owner, {
      name,
      intent: 'Compare observations.',
      workspace,
      requestId: name,
    });
  const consolidation = async (name: string) =>
    await app.ctx.consolidation.create(owner, {
      name,
      workspace: 'git',
      sourceArtifactIds: [source.id],
      experimentIds: [],
      requestId: name,
    });
  const active = () => {
    for (const id of ['experiments', 'knowledge', 'reflections', 'research', 'tasks', 'sessions'])
      assert.equal(app.status().find((entry) => entry.id === id)?.state, 'active', id);
  };
  let sequence = 0;
  const id = () => `optional-code-${++sequence}`;
  const advance = async (record: ResearchRecord) =>
    await app.ctx.research.advance(owner, {
      researchId: record.id,
      expectedRevision: record.workflow.revision,
      requestId: id(),
    });
  const cycle = async (consolidationWorkspace: 'none' | 'git' = 'none') => {
    await app.ctx.paper.patch(owner, {
      kind: 'problem',
      expectedRevision: (await app.ctx.paper.read(owner)).documents.problem.current.revision,
      requestId: id(),
      changes: [
        { id: 'problem', content: 'Can retained observations answer this question?' },
        { id: 'scope', content: 'A bounded local study.' },
        { id: 'goals', content: 'Explain the evidence and its limitations.' },
        { id: 'constraints', content: 'Do not assert unsupported empirical conclusions.' },
      ],
    });
    return await advance(
      await advance(
        await app.ctx.research.create(owner, {
          name: 'Optional code research',
          consolidationWorkspace,
          requestId: id(),
        }),
      ),
    );
  };
  const artifact = async (caller: Caller, title: string) =>
    await app.ctx.artifacts.create(caller, {
      title,
      content: `# Summary\n${title}: no empirical conclusion without retained evidence.\n# Evidence\nThe existing observations require further study.`,
    });
  const reflect = async (record: ResearchRecord) => {
    let wave = await app.ctx.reflections.get(owner, record.reflectionId!);
    for (const lens of wave.lenses) {
      const issued = await app.ctx.scope.issueActor(owner, {
        name: lens.perspective,
        role: 'producer',
      });
      const caller = {
        projectId: owner.projectId,
        actorId: issued.actor.id,
        credentialId: issued.credential.id,
      };
      await app.ctx.reflections.submitLens(caller, {
        lensId: lens.id,
        artifactId: (await artifact(caller, lens.perspective)).id,
        expectedRevision: 0,
        requestId: id(),
      });
    }
    wave = await app.ctx.reflections.get(owner, wave.id);
    wave = await app.ctx.reflections.submit(owner, {
      reflectionId: wave.id,
      expectedRevision: wave.workflow.revision,
      reportArtifactId: (await artifact(owner, 'Report')).id,
      changeSpecArtifactId: (await artifact(owner, 'Changes')).id,
      requestId: id(),
    });
    const review = await app.ctx.reviews.start(reviewer, wave.review!.id);
    return (await app.ctx.reviews.apply(reviewer, {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: wave.workflow.revision,
      verdict: 'pass',
      notes: 'Verified the source evidence and every lens report.',
      synopsis:
        'The review confirms the synthesis is consistent with the observed evidence and limitations.',
      findings: review.criteria.map((_, i) => ({
        criterionNumber: i + 1,
        status: 'met',
        evidenceIds: [wave.report!.id],
        notes: 'Checked the retained observations and coverage.',
      })),
      requestId: id(),
    })) as Reflection;
  };
  return {
    app,
    owner,
    reviewer,
    source,
    experiment,
    consolidation,
    active,
    cycle,
    reflect,
    advance,
  };
}

test('server boots without Code and completes no-code research after reflection approval', async (t) => {
  const f = await fixture(t, false);
  f.active();
  for (const id of ['code-tools', 'consolidation', 'consolidation-tools'])
    assert.equal(f.app.status().find((entry) => entry.id === id)?.state, 'pending', id);
  assert.equal(
    (await f.app.ctx.tools.list()).filter((tool) => tool.name === 'reflection.create').length,
    1,
  );
  const experiment = await f.experiment('No-git');
  assert.equal(
    (await f.app.ctx.workflows.assignment(f.owner, experiment.id)).context?.type,
    'experiment.design',
  );
  await f.app.ctx.experiments.attach(f.owner, {
    experimentId: experiment.id,
    artifactId: f.source.id,
    role: 'plan',
    path: 'plan.md',
    attemptIndex: 1,
    expectedRevision: 0,
    requestId: 'attach-source',
  });
  assert.equal((await f.app.ctx.knowledge.records(f.owner)).experiments[0].id, experiment.id);
  assert.equal((await f.app.ctx.knowledge.resolve(f.owner, [f.source.id]))[0].status, 'resolved');
  assert.deepEqual(
    (
      await f.app.ctx.knowledge.resolve(f.owner, [
        'code-proposal:missing',
        'code-commit:missing',
        'session-final:missing',
      ])
    ).map((ref) => ref.status),
    ['unavailable', 'unavailable', 'unavailable'],
  );
  await assert.rejects(async () => await f.experiment('Needs-code', 'git'), {
    code: 'code_unavailable',
  });
  // Only a Git task asks for Code: a task that delivers files runs to done without it.
  const task = { title: 'Notes', goal: 'Write the notes.', checks: ['The notes exist'] };
  await assert.rejects(
    async () =>
      await f.app.ctx.tasks.create(f.owner, { ...task, workspace: 'git', requestId: 'git-task' }),
    { code: 'code_unavailable' },
  );
  const scratchTask = await f.app.ctx.tasks.create(f.owner, { ...task, requestId: 'scratch-task' });
  const delivered = await f.app.ctx.tasks.submitDelivery(f.owner, {
    ...confirmedDelivery({ taskId: scratchTask.id, artifactIds: [f.source.id] }),
    expectedRevision: 0,
    requestId: 'scratch-delivery',
  });
  const claimed = await f.app.ctx.reviews.start(f.reviewer, delivered.reviewId!);
  assert.equal(
    (
      await f.app.ctx.tasks.submitReview(f.reviewer, {
        ...reviewedFindings(claimed),
        reviewId: claimed.id,
        claimId: claimed.claimId!,
        verdict: 'pass',
        notes: 'Read the notes against the check.',
        expectedRevision: delivered.workflow.revision,
        requestId: 'scratch-review',
      } as TaskReview)
    ).workflow.state,
    'done',
  );

  let record = await f.cycle();
  const wave = await f.app.ctx.reflections.get(f.owner, record.reflectionId!);
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const session = await f.app.ctx.sessions.offer(f.owner, {
    instanceId: wave.lenses[0]!.id,
    expectedRevision: 0,
    runnerId: 'fixture',
    requestId: 'reflection-access',
    secret,
  });
  const worker = await f.app.ctx.sessions.authenticate(secret);
  assert.match(
    JSON.stringify(
      await f.app.ctx.tools.call('artifact.read', worker, { artifactId: f.source.id }),
    ),
    /Retained research findings/,
  );
  await f.app.ctx.sessions.release(f.owner, { sessionId: session.id, runnerId: 'fixture' });
  await f.app.ctx.domainEvents.drain();
  assert.equal((await f.reflect(record)).workflow.state, 'approved');
  record = await f.advance(record);
  assert.equal(record.workflow.version, 4);
  assert.equal(record.workflow.state, 'complete');
  assert.equal(record.consolidationId, null);
  assert.equal(
    (await f.app.ctx.workflows.list(f.owner)).filter((work) => work.workflow === 'consolidation')
      .length,
    0,
  );

  const research = f.app.ctx.research;
  await f.app.setEnabled('code', true);
  assert.equal(f.app.ctx.research, research);
  assert.equal(f.app.status().find(({ id }) => id === 'consolidation')?.state, 'active');
  assert.equal((await f.experiment('Now-with-code', 'git')).workspace, 'git');
  assert.equal((await f.consolidation('Now-with-code')).workspace, 'git');
  assert.equal(
    (await f.app.ctx.knowledge.resolve(f.owner, ['code-proposal:missing']))[0].status,
    'missing',
  );
});

test('Code unload leaves live non-Git assignments and providers intact; reload rebinds Git access', async (t) => {
  const f = await fixture(t, true);
  const providers = {
    experiments: f.app.ctx.experiments,
    knowledge: f.app.ctx.knowledge,
    sessions: f.app.ctx.sessions,
    reflections: f.app.ctx.reflections,
    research: f.app.ctx.research,
  };
  const git = await f.experiment('Git-work', 'git');
  const gitConsolidation = await f.consolidation('Git-consolidation');
  const scratch = await f.experiment('Scratch-work');
  const gitTask = await f.app.ctx.tasks.create(f.owner, {
    title: 'Harness',
    goal: 'Build the harness as a repository.',
    checks: ['The harness runs'],
    workspace: 'git',
    requestId: 'git-task',
  });
  // The project names no repository yet, so Code published why neither unit can start. The
  // rows are Workflows', which is what keeps them readable below while Code is unloaded.
  const blockedWork = async () => ({
    gate: (await f.app.ctx.workflows.evaluate(f.owner, gitTask.id)).currentGate,
    next: (await f.app.ctx.workflows.evaluate(f.owner, gitTask.id)).nextAction,
    published: (await f.app.ctx.workflows.blockers(f.owner)).map((item) => [
      item.instanceId,
      item.provider,
      item.code,
      item.key,
    ]),
    stuck: (await f.app.ctx.sessions.stuck(f.owner)).items
      .filter((item) => item.kind === 'work_blocked')
      .map((item) => [item.instanceId, item.code]),
  });
  const unbound = {
    gate: 'code_base_pending',
    next: null,
    published: [
      [git.id, 'code', 'code_base_pending', 'main'],
      [gitTask.id, 'code', 'code_base_pending', 'main'],
    ],
    stuck: [
      [git.id, 'code_base_pending'],
      [gitTask.id, 'code_base_pending'],
    ],
  };
  assert.deepEqual(await blockedWork(), unbound);
  const candidates = (await f.app.ctx.workflows.dispatchCandidates(f.owner)).map(
    (item) => item.instanceId,
  );
  assert.equal(candidates.includes(scratch.id), true);
  assert.equal(candidates.includes(git.id) || candidates.includes(gitTask.id), false);
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const session = await f.app.ctx.sessions.offer(f.owner, {
    instanceId: scratch.id,
    expectedRevision: 0,
    runnerId: 'fixture',
    requestId: 'offer',
    secret,
  });
  const worker = await f.app.ctx.sessions.authenticate(secret);
  const packet = await f.app.ctx.workflows.assignment(worker, scratch.id);

  for (let cycle = 0; cycle < 2; cycle++) {
    await f.app.setEnabled('code', false);
    f.active();
    for (const [name, service] of Object.entries(providers))
      assert.equal(f.app.ctx.get(name), service, name);
    assert.deepEqual(await f.app.ctx.sessions.authenticate(secret), worker);
    assert.deepEqual(await f.app.ctx.workflows.assignment(worker, scratch.id), packet);
    assert.equal((await f.app.ctx.experiments.get(f.owner, git.id)).workspace, 'git');
    assert.equal(f.app.status().find(({ id }) => id === 'consolidation')?.state, 'pending');
    assert.ok(!(await f.app.ctx.tools.list()).some((tool) => tool.name === 'consolidation.create'));
    assert.ok((await f.app.ctx.tools.list()).some((tool) => tool.name === 'reflection.create'));
    await assert.rejects(async () => await f.app.ctx.workflows.assignment(f.owner, git.id), {
      code: 'code_unavailable',
    });
    assert.equal((await f.app.ctx.tasks.get(f.owner, gitTask.id)).workspace, 'git');
    await assert.rejects(async () => await f.app.ctx.workflows.assignment(f.owner, gitTask.id), {
      code: 'code_unavailable',
    });
    assert.equal(await f.app.ctx.tasks.codeUnit(f.owner, gitTask.id), null);
    if (cycle === 0) {
      // What Code said before it left still reads, and the project is bound in its absence.
      assert.deepEqual(await blockedWork(), unbound);
      await boundProject(f.app.ctx.state, f.owner.projectId, 'a'.repeat(40));
    } else {
      // Work that was never blocked has no row: unloaded Code shows only as the refusal to
      // begin it, which status_and_next reports and the stuck report does not.
      const guidance = await f.app.ctx.workflows.evaluate(f.owner, gitTask.id);
      assert.deepEqual(guidance.providerBlockers, []);
      assert.ok(JSON.stringify(guidance).includes('code_unavailable'));
      assert.deepEqual((await blockedWork()).stuck, []);
    }
    await assert.rejects(
      async () => await f.app.ctx.workflows.assignment(f.owner, gitConsolidation.id),
      {
        code: 'workflow_unavailable',
      },
    );
    assert.equal(
      (await f.app.ctx.knowledge.resolve(f.owner, ['code-proposal:missing']))[0].status,
      'unavailable',
    );
    const current = await f.app.ctx.sessions.run(
      await f.app.ctx.sessions.prepare(worker, 'experiment.get_state', {
        experimentId: scratch.id,
      }),
      async (caller) => await f.app.ctx.experiments.get(caller, scratch.id),
    );
    assert.equal(current.id, scratch.id);

    await f.app.setEnabled('code', true);
    assert.equal(f.app.ctx.experiments, providers.experiments);
    // Loading Code derives every unpinned unit again, so the binding made meanwhile clears them.
    assert.deepEqual((await blockedWork()).published, []);
    assert.deepEqual((await f.app.ctx.tasks.codeUnit(f.owner, gitTask.id))!.baseStatus, {
      status: 'ready',
      kind: 'main',
      sources: [],
    });
    assert.match((await f.app.ctx.workflows.assignment(f.owner, gitTask.id)).brief, /Git task/);
    assert.equal(
      (await f.app.ctx.workflows.assignment(f.owner, git.id)).context?.type,
      'experiment.design',
    );
    assert.equal(
      (await f.app.ctx.workflows.assignment(f.owner, gitConsolidation.id)).context?.type,
      'consolidation.consolidating',
    );
    assert.equal(
      (await f.app.ctx.knowledge.resolve(f.owner, ['code-proposal:missing']))[0].status,
      'missing',
    );
    assert.equal(f.app.status().find(({ id }) => id === 'code-tools')?.state, 'active');
  }
  assert.equal(session.assignment.instanceId, scratch.id);
});

test('Git research reports missing consolidation, then retries the same handoff after Code loads', async (t) => {
  const f = await fixture(t, false);
  let record = await f.cycle('git');
  await f.reflect(record);
  const input = {
    researchId: record.id,
    expectedRevision: record.workflow.revision,
    requestId: 'git-handoff',
  };
  const research = f.app.ctx.research;
  const advance = async () => await f.app.ctx.research.advance(f.owner, input);
  const blocked = await f.app.ctx.workflows.evaluate(f.owner, record.id);
  assert.ok(JSON.stringify(blocked).includes('consolidation_unavailable'));
  await assert.rejects(advance, { code: 'consolidation_unavailable' });
  await assert.rejects(advance, { code: 'consolidation_unavailable' });
  assert.equal((await f.app.ctx.research.get(f.owner, record.id)).consolidationId, null);
  assert.equal(
    (await f.app.ctx.research.get(f.owner, record.id)).workflow.revision,
    record.workflow.revision,
  );
  assert.equal(
    (await f.app.ctx.workflows.list(f.owner)).filter((work) => work.workflow === 'consolidation')
      .length,
    0,
  );

  await f.app.setEnabled('code', true);
  assert.equal(f.app.ctx.research, research);
  record = await advance();
  assert.equal(record.workflow.state, 'consolidating');
  assert.equal(
    (await f.app.ctx.consolidation.get(f.owner, record.consolidationId!)).workspace,
    'git',
  );
  assert.deepEqual(await advance(), record);
  assert.equal((await f.app.ctx.consolidation.list(f.owner)).length, 1);
  const childId = record.consolidationId;
  await f.app.setEnabled('code', false);
  assert.equal(f.app.ctx.research, research);
  assert.deepEqual(
    await advance(),
    record,
    'completed handoff can replay while its child provider is absent',
  );
  assert.equal((await f.app.ctx.research.get(f.owner, record.id)).consolidationId, childId);
  await f.app.setEnabled('code', true);
  assert.equal(f.app.ctx.research, research);
  assert.deepEqual(await advance(), record);
  assert.equal((await f.app.ctx.consolidation.list(f.owner)).length, 1);
});
