import type { Caller, TaskReview } from '@merv/contracts';
import type { Reflection } from '@merv/reflections/types';
import type { ResearchRecord } from '@merv/research/types';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
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
  // Optional-provider lifecycle needs Code's services, not the repository writer socket.
  config.plugins.find(({ id }) => id === 'code')!.config = {};
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
  const cycle = async () => {
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
    const record = await app.ctx.research.create(owner, {
      name: 'Optional code research',
      requestId: id(),
    });
    return await advance(await advance(record));
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
    active,
    cycle,
    reflect,
    advance,
  };
}

test('server boots without Code and completes no-code research after reflection approval', async (t) => {
  const f = await fixture(t, false);
  f.active();
  assert.equal(f.app.status().find((entry) => entry.id === 'code-tools')?.state, 'pending');
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
  assert.equal(record.workflow.state, 'complete');
  const research = f.app.ctx.research;
  await f.app.setEnabled('code', true);
  assert.equal(f.app.ctx.research, research);
  assert.equal(record.workflow.version, 6);
  assert.equal(record.workflow.state, 'complete');
  assert.deepEqual(record.integrations, []);
  assert.equal((await f.experiment('Now-with-code', 'git')).workspace, 'git');
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
  const scratch = await f.experiment('Scratch-work');
  const gitTask = await f.app.ctx.tasks.create(f.owner, {
    title: 'Harness',
    goal: 'Build the harness as a repository.',
    checks: ['The harness runs'],
    workspace: 'git',
    requestId: 'git-task',
  });
  // Unhosted projects keep the production versions, without a derived-base blocker.
  assert.equal(git.workflow.version, 6);
  assert.equal(gitTask.workflow.version, 3);
  assert.deepEqual(await f.app.ctx.workflows.blockers(f.owner), []);
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
    assert.ok((await f.app.ctx.tools.list()).some((tool) => tool.name === 'reflection.create'));
    await assert.rejects(async () => await f.app.ctx.workflows.assignment(f.owner, git.id), {
      code: 'code_unavailable',
    });
    assert.equal((await f.app.ctx.tasks.get(f.owner, gitTask.id)).workspace, 'git');
    await assert.rejects(async () => await f.app.ctx.workflows.assignment(f.owner, gitTask.id), {
      code: 'code_unavailable',
    });
    assert.equal(await f.app.ctx.tasks.codeUnit(f.owner, gitTask.id), null);
    const guidance = await f.app.ctx.workflows.evaluate(f.owner, gitTask.id);
    assert.deepEqual(guidance.providerBlockers, []);
    assert.ok(JSON.stringify(guidance).includes('code_unavailable'));
    assert.deepEqual(
      (await f.app.ctx.sessions.stuck(f.owner)).items.filter(
        (item) => item.kind === 'work_blocked',
      ),
      [],
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
    assert.deepEqual(await f.app.ctx.workflows.blockers(f.owner), []);
    assert.equal(await f.app.ctx.tasks.codeUnit(f.owner, gitTask.id), null);
    assert.match((await f.app.ctx.workflows.assignment(f.owner, gitTask.id)).brief, /Git task/);
    assert.equal(
      (await f.app.ctx.workflows.assignment(f.owner, git.id)).context?.type,
      'experiment.design',
    );
    assert.equal(
      (await f.app.ctx.knowledge.resolve(f.owner, ['code-proposal:missing']))[0].status,
      'missing',
    );
    assert.equal(f.app.status().find(({ id }) => id === 'code-tools')?.state, 'active');
  }
  assert.equal(session.assignment.instanceId, scratch.id);
});
