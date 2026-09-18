import { forEachAsync, mapAsync } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import type { Artifact, Caller, ReviewApplication } from '@merv/contracts';
import type { Reflection } from '../packages/reflections/src/types.js';
const token = () => `ms_${randomBytes(32).toString('base64url')}`;
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-reflection-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins = config.plugins.filter(
    (entry: { id: string }) =>
      entry.id !== 'api' &&
      entry.id !== 'identity' &&
      entry.id !== 'ui' &&
      !entry.id.endsWith('-api') &&
      !entry.id.endsWith('-ui'),
  );
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Reflection integration',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const actor = async (name: string, role: 'producer' | 'reviewer' | 'operator' = 'producer') => {
    const issued = await app.ctx.scope.issueActor(owner, { name, role });
    return {
      projectId: owner.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    } as Caller;
  };
  const create = async (caller: Caller, label: string) =>
    await app.ctx.artifacts.create(caller, {
      title: label,
      content: `# Summary\n${label}: source-linked observation.\n# Evidence\nNo completed experiments in the pinned corpus; no empirical conclusion is claimed.`,
    });
  const lenses = async (wave: Reflection) => {
    await forEachAsync(wave.lenses, async (lens, i) => {
      const caller = await actor(`Lens ${wave.attempt}-${i}`);
      const artifact = await create(caller, lens.perspective);
      await app.ctx.reflections.submitLens(caller, {
        lensId: lens.id,
        artifactId: artifact.id,
        expectedRevision: 0,
        requestId: `lens-${lens.id}`,
      });
    });
    return await app.ctx.reflections.get(owner, wave.id);
  };
  const synthesize = async (wave: Reflection) => {
    const report = await create(owner, 'Synthesis'),
      spec = await create(owner, 'Changes');
    return await app.ctx.reflections.submit(owner, {
      reflectionId: wave.id,
      reportArtifactId: report.id,
      changeSpecArtifactId: spec.id,
      expectedRevision: wave.workflow.revision,
      requestId: `synthesis-${wave.workflow.revision}`,
    });
  };
  const verdict = async (wave: Reflection, reviewer: Caller, pass: boolean, returnTo?: string) => {
    const review = await app.ctx.reviews.start(reviewer, wave.review!.id);
    const input: ReviewApplication = {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: wave.workflow.revision,
      verdict: pass ? 'pass' : 'needs_changes',
      ...(returnTo ? { returnTo } : {}),
      notes: 'Verified exact frozen sources and lens outputs.',
      synopsis: pass
        ? 'The exact frozen evidence supports this synthesis after independent verification.'
        : 'The exact submission requires repair of the documented coverage and evidence problems.',
      findings: review.criteria.map((_, i) => ({
        criterionNumber: i + 1,
        status: pass ? 'met' : 'not_met',
        evidenceIds: [review.artifactIds[0]!],
        notes: 'Checked against the corpus.',
      })),
      requestId: `verdict-${review.id}`,
    };
    await assert.rejects(
      async () =>
        await app.ctx.reviews.apply(reviewer, {
          ...input,
          expectedRevision: input.expectedRevision + 1,
          requestId: `stale-${review.id}`,
        }),
      { code: 'revision_conflict' },
    );
    return (await app.ctx.reviews.apply(reviewer, input)) as Reflection;
  };
  return { app, owner, actor, create, lenses, synthesize, verdict };
}
test('reflection uses live research, joins five independent ordinary workflows, reviews and retains exact approval', async (t) => {
  const f = await fixture(t);
  let wave = await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave' });
  assert.equal(wave.workflow.workflow, 'reflection');
  await assert.rejects(
    async () =>
      await f.app.ctx.workflows.start(f.owner, {
        workflow: 'reflection.lens',
        requestId: 'unowned-start',
      }),
    { code: 'workflow_managed' },
  );
  assert.equal(wave.lenses.length, 5);
  assert.ok(wave.lenses.every((l) => l.workflow.workflow === 'reflection.lens'));
  assert.equal(
    (await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave' })).id,
    wave.id,
  );
  await assert.rejects(
    async () => await f.app.ctx.research.startReflection(f.owner, { requestId: 'other' }),
    {
      code: 'reflection_open',
    },
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave', title: 'Different' }),
    { code: 'request_conflict' },
  );
  await assert.rejects(async () => await f.app.ctx.reflections.approved(f.owner, wave.id), {
    code: 'reflection_not_approved',
  });
  assert.equal(wave.corpus, null);
  assert.equal(wave.paper, null);
  await assert.rejects(
    async () =>
      await f.app.ctx.tasks.create(f.owner, {
        title: 'Later task',
        goal: 'Paused during reflection',
        checks: ['Recorded'],
        requestId: 'later',
      }),
    { code: 'workflow_creation_paused' },
  );
  const lensWorker = await f.actor('Independent lens', 'operator');
  // A blank Summary is refused whether or not a blank line separates it from the next heading.
  for (const [index, content] of [
    '# Summary\n\n# Evidence\nThis is evidence, not a summary.',
    '# Summary\n# Evidence\nThis is evidence, not a summary.',
    '```\n# Summary\nA fenced example is not the summary.\n```\n# Evidence\nEvidence.',
  ].entries()) {
    const emptySummary = await f.app.ctx.artifacts.create(lensWorker, {
      title: 'Empty summary',
      content,
    });
    await assert.rejects(
      async () =>
        await f.app.ctx.reflections.submitLens(lensWorker, {
          lensId: wave.lenses[0]!.id,
          artifactId: emptySummary.id,
          expectedRevision: 0,
          requestId: `invalid-summary-${index}`,
        }),
      { code: 'reflection_summary_required' },
    );
  }
  const artifact = await f.create(lensWorker, 'First');
  await f.app.ctx.reflections.submitLens(lensWorker, {
    lensId: wave.lenses[0]!.id,
    artifactId: artifact.id,
    expectedRevision: 0,
    requestId: 'first',
  });
  await assert.rejects(
    async () =>
      await f.app.ctx.reflections.submitLens(lensWorker, {
        lensId: wave.lenses[1]!.id,
        artifactId: artifact.id,
        expectedRevision: 0,
        requestId: 'repeat-worker',
      }),
    { code: 'lens_independence' },
  );
  for (const lens of wave.lenses.slice(1)) {
    const actor = await f.actor(lens.perspective);
    await f.app.ctx.reflections.submitLens(actor, {
      lensId: lens.id,
      artifactId: (await f.create(actor, lens.perspective)).id,
      expectedRevision: 0,
      requestId: lens.id,
    });
  }
  wave = await f.app.ctx.reflections.get(f.owner, wave.id);
  assert.equal(wave.workflow.state, 'synthesizing');
  assert.match(
    (await f.app.ctx.workflows.assignment(f.owner, wave.id)).context!.prompt,
    /Independent lens reports/,
  );
  wave = await f.synthesize(wave);
  assert.equal(wave.workflow.state, 'in_review');
  await assert.rejects(async () => await f.synthesize(wave), { code: 'reflection_in_review' });
  await assert.rejects(async () => await f.app.ctx.workflows.assignment(lensWorker, wave.id), {
    code: 'review_independence',
  });
  await assert.rejects(async () => await f.app.ctx.reviews.start(lensWorker, wave.review!.id), {
    code: 'review_independence',
  });
  const reviewer = await f.actor('Independent reviewer', 'reviewer');
  wave = await f.verdict(wave, reviewer, true);
  assert.equal(wave.workflow.state, 'approved');
  await assert.rejects(async () => await f.synthesize(wave), { code: 'reflection_complete' });
  const approved = await f.app.ctx.reflections.approved(f.owner, wave.id);
  assert.equal(approved.report.id, wave.report!.id);
  assert.equal(approved.reviewerId, reviewer.actorId);
  assert.equal(approved.corpus, null);
  assert.equal(approved.paper, null);
  assert.ok(
    (
      await f.app.ctx.tasks.create(f.owner, {
        title: 'Later task',
        goal: 'Paused during reflection',
        checks: ['Recorded'],
        requestId: 'later',
      })
    ).id,
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run('UPDATE reflections SET title=? WHERE id=?', 'Tampered', wave.id),
      ),
    /immutable/,
  );
  assert.ok((await f.app.ctx.research.startReflection(f.owner, { requestId: 'next-wave' })).id);
});

test('review return preserves lenses for synthesis repair and creates fresh versioned children for lens repair', async (t) => {
  const f = await fixture(t);
  let wave = await f.synthesize(
    await f.lenses(await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave' })),
  );
  const firstIds = wave.lenses.map((l) => l.id);
  const reviewer = await f.actor('Reviewer', 'reviewer');
  wave = await f.verdict(wave, reviewer, false, 'synthesizing');
  assert.equal(wave.workflow.state, 'synthesizing');
  assert.deepEqual(
    wave.lenses.map((l) => l.id),
    firstIds,
  );
  wave = await f.synthesize(wave);
  wave = await f.verdict(wave, reviewer, false, 'reflecting');
  assert.equal(wave.workflow.state, 'reflecting');
  assert.equal(wave.attempt, 2);
  assert.ok(wave.lenses.every((l) => !firstIds.includes(l.id) && l.artifact === null));
  assert.equal((await f.app.ctx.workflows.get(f.owner, firstIds[0]!)).state, 'complete');
  wave = await f.synthesize(await f.lenses(wave));
  wave = await f.verdict(wave, reviewer, true);
  assert.equal(wave.workflow.state, 'approved');
});

test('leased lens calls use exact execution evidence, retain context through release and recover independent review claims', async (t) => {
  const f = await fixture(t);
  let wave = await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave' });
  const secret = token();
  const agent = await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Lens agent',
    runnerId: 'external',
    requestId: 'agent',
    secret,
  });
  const first = wave.lenses[0]!;
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: first.id,
    expectedRevision: 0,
    requestId: 'assign-first',
  });
  const caller = await f.app.ctx.sessions.authenticate(secret);
  assert.equal(execution.role, 'producer');
  assert.match(execution.assignment.context!.prompt, /live research access/i);
  // The lens may read the wave it belongs to, as it may read anything in the project.
  assert.ok(await f.app.ctx.tools.call('reflection.get', caller, { reflectionId: wave.id }));
  const artifact = (await f.app.ctx.tools.call('artifact.create', caller, {
    title: 'Lens evidence',
    content:
      '# Summary\nThe corpus contains no completed research.\n# Evidence\nNo empirical conclusion is claimed.',
  })) as Artifact;
  await f.app.ctx.tools.call('reflection.submit_lens', caller, {
    lensId: first.id,
    artifactId: artifact.id,
    expectedRevision: 0,
    requestId: 'submit-first',
  });
  await f.app.ctx.sessions.releaseAgentAssignment(secret, execution.id);
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.assignAgent(secret, {
        instanceId: wave.lenses[1]!.id,
        expectedRevision: 0,
        requestId: 'same-agent-second',
      }),
    { code: 'lens_independence' },
  );
  for (const lens of wave.lenses.slice(1)) {
    const actor = await f.actor(lens.perspective);
    await f.app.ctx.reflections.submitLens(actor, {
      lensId: lens.id,
      artifactId: (await f.create(actor, lens.perspective)).id,
      expectedRevision: 0,
      requestId: lens.id,
    });
  }
  wave = await f.synthesize(await f.app.ctx.reflections.get(f.owner, wave.id));
  const reviewToken = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Review agent',
    runnerId: 'external',
    requestId: 'review-agent',
    secret: reviewToken,
  });
  const reviewExecution = await f.app.ctx.sessions.assignAgent(reviewToken, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'review',
  });
  assert.equal(reviewExecution.role, 'reviewer');
  const oldClaim = (await f.app.ctx.reviews.get(f.owner, wave.review!.id)).claimId;
  await f.app.ctx.sessions.releaseAgentAssignment(reviewToken, reviewExecution.id);
  await f.app.ctx.domainEvents.drain();
  assert.equal((await f.app.ctx.reviews.get(f.owner, wave.review!.id)).status, 'requested');
  const next = await f.app.ctx.sessions.assignAgent(reviewToken, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'review-again',
  });
  assert.notEqual((await f.app.ctx.reviews.get(f.owner, wave.review!.id)).claimId, oldClaim);
  assert.match(next.assignment.context!.prompt, /recovery/);
  assert.equal(agent.id, execution.agentId);
});

test('ordinary session workers execute five lenses, synthesis and repair; unload preserves frozen assignments', async (t) => {
  const f = await fixture(t);
  let wave = await f.app.ctx.research.startReflection(f.owner, { requestId: 'leased-wave' });
  const actors: string[] = [];
  for (const lens of wave.lenses) {
    const secret = token();
    const agent = await f.app.ctx.sessions.registerAgent(f.owner, {
      name: lens.perspective,
      runnerId: 'external',
      requestId: lens.id,
      secret,
    });
    actors.push(agent.actorId);
    const execution = await f.app.ctx.sessions.assignAgent(secret, {
      instanceId: lens.id,
      expectedRevision: 0,
      requestId: `assign-${lens.id}`,
    });
    const caller = await f.app.ctx.sessions.authenticate(secret);
    if (actors.length === 1) {
      const previous = f.app.ctx.reflections;
      await f.app.setEnabled('reflections', false);
      await assert.rejects(async () => await previous.get(f.owner, wave.id), {
        code: 'reflection_unavailable',
      });
      await f.app.setEnabled('reflections', true);
      assert.equal((await f.app.ctx.reflections.get(f.owner, wave.id)).corpus, null);
      assert.equal(
        (await f.app.ctx.sessions.agentSelf(secret)).current!.assignment.context!.hash,
        execution.assignment.context!.hash,
      );
    }
    const artifact = (await f.app.ctx.tools.call('artifact.create', caller, {
      title: lens.perspective,
      content:
        '# Summary\nIndependent observations from the frozen corpus.\n# Evidence\nNo empirical claims without completed experiments.',
    })) as Artifact;
    await f.app.ctx.tools.call('reflection.submit_lens', caller, {
      lensId: lens.id,
      artifactId: artifact.id,
      expectedRevision: 0,
      requestId: `submit-${lens.id}`,
    });
    await f.app.ctx.sessions.releaseAgentAssignment(secret, execution.id);
    await f.app.ctx.domainEvents.drain();
  }
  wave = await f.app.ctx.reflections.get(f.owner, wave.id);
  assert.equal(wave.workflow.state, 'synthesizing');
  const synthesisToken = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Synthesis',
    runnerId: 'external',
    requestId: 'synthesis-agent',
    secret: synthesisToken,
  });
  const execution = await f.app.ctx.sessions.assignAgent(synthesisToken, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'synthesis-work',
  });
  const caller = await f.app.ctx.sessions.authenticate(synthesisToken);
  const outputs: Artifact[] = [];
  for (const title of ['Report', 'Change specification'])
    outputs.push(
      (await f.app.ctx.tools.call('artifact.create', caller, {
        title,
        content: `# Summary\n${title}: grounded in the exact corpus and all five lens reports.`,
      })) as Artifact,
    );
  const paperChanges = (await f.app.ctx.tools.call('artifact.create', caller, {
    title: 'Paper proposal',
    mediaType: 'application/json',
    content: JSON.stringify({
      documents: [
        {
          kind: 'results',
          expectedRevision: 0,
          changes: [
            {
              id: 'synthesis',
              title: 'Synthesis',
              content: 'No empirical conclusion is supported.',
            },
          ],
        },
      ],
    }),
  })) as Artifact;
  const submission = {
    reflectionId: wave.id,
    expectedRevision: wave.workflow.revision,
    reportArtifactId: outputs[0]!.id,
    changeSpecArtifactId: outputs[1]!.id,
    paperChangesArtifactId: paperChanges.id,
    requestId: 'submit-synthesis',
  };
  await assert.rejects(
    async () =>
      await f.app.ctx.tools.call('reflection.submit', caller, {
        ...submission,
        graphArtifactId: outputs[0]!.id,
      }),
    { code: 'invalid_input' },
    'the retired project graph is refused as an unexpected field',
  );
  wave = (await f.app.ctx.tools.call('reflection.submit', caller, submission)) as Reflection;
  await f.app.ctx.sessions.releaseAgentAssignment(synthesisToken, execution.id);
  await f.app.ctx.domainEvents.drain();
  assert.deepEqual(new Set(wave.review!.excludedActorIds), new Set(actors));
  const reviewToken = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Independent review',
    runnerId: 'external',
    requestId: 'independent-review',
    secret: reviewToken,
  });
  const reviewing = await f.app.ctx.sessions.assignAgent(reviewToken, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'review-work',
  });
  const reviewer = await f.app.ctx.sessions.authenticate(reviewToken);
  const review = await f.app.ctx.reviews.get(f.owner, wave.review!.id);
  const repaired = (await f.app.ctx.tools.call('review.submit', reviewer, {
    reviewId: review.id,
    claimId: review.claimId!,
    expectedRevision: wave.workflow.revision,
    verdict: 'needs_changes',
    returnTo: 'reflecting',
    notes: 'Fresh lenses must examine the identified missing evidence.',
    synopsis: 'A new independent lens attempt is required to repair the identified coverage gap.',
    findings: review.criteria.map((_, i) => ({
      criterionNumber: i + 1,
      status: 'not_met',
      evidenceIds: [outputs[0]!.id],
      notes: 'The documented coverage gap must be repaired.',
    })),
    requestId: 'return-lenses',
  })) as Reflection;
  assert.equal((await f.app.ctx.paper.read(f.owner)).documents.results.current.revision, 0);
  assert.equal(repaired.attempt, 2);
  assert.equal(repaired.lenses.length, 5);
  assert.ok(repaired.lenses.every((lens) => lens.workflow.revision === 0));
  await f.app.ctx.sessions.releaseAgentAssignment(reviewToken, reviewing.id);
  await f.app.ctx.domainEvents.drain();
});

test('synthesis admission matches review ownership for direct producers and source-bound workers', async (t) => {
  const f = await fixture(t);
  const owner = await f.actor('Wave owner');
  const outsider = await f.actor('Other producer');
  const wave = await f.lenses(
    await f.app.ctx.research.startReflection(owner, { requestId: 'owned-wave' }),
  );
  assert.equal(wave.ownerId, owner.actorId);
  assert.equal(wave.workflow.state, 'synthesizing');
  assert.equal(
    (await f.app.ctx.workflows.dispatchCandidates(outsider)).some(
      (candidate) => candidate.instanceId === wave.id,
    ),
    false,
  );
  assert.ok(
    (await f.app.ctx.workflows.dispatchCandidates(owner)).some(
      (candidate) => candidate.instanceId === wave.id,
    ),
  );
  assert.ok(
    (await f.app.ctx.workflows.dispatchCandidates(f.owner)).some(
      (candidate) => candidate.instanceId === wave.id,
    ),
    'An operator can administer another producer’s wave',
  );
  await assert.rejects(async () => await f.app.ctx.workflows.assignment(outsider, wave.id), {
    code: 'forbidden',
  });
  assert.equal((await f.app.ctx.workflows.assignment(owner, wave.id)).role, 'producer');
  const outputs = await mapAsync(
    ['Report', 'Changes'],
    async (title) => await f.create(outsider, title),
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.reflections.submit(outsider, {
        reflectionId: wave.id,
        expectedRevision: wave.workflow.revision,
        reportArtifactId: outputs[0]!.id,
        changeSpecArtifactId: outputs[1]!.id,
        requestId: 'outsider-submit',
      }),
    { code: 'forbidden' },
  );
  assert.equal((await f.app.ctx.reflections.get(owner, wave.id)).review, null);
  const blockedToken = token();
  await f.app.ctx.sessions.registerAgent(outsider, {
    name: 'Other producer’s agent',
    runnerId: 'external',
    requestId: 'blocked-agent',
    secret: blockedToken,
  });
  await assert.rejects(
    async () =>
      await f.app.ctx.sessions.assignAgent(blockedToken, {
        instanceId: wave.id,
        expectedRevision: wave.workflow.revision,
        requestId: 'blocked-synthesis',
      }),
    { code: 'forbidden' },
  );
  assert.equal((await f.app.ctx.sessions.agentSelf(blockedToken)).current, null);
  const secret = token();
  await f.app.ctx.sessions.registerAgent(owner, {
    name: 'Owner’s synthesis agent',
    runnerId: 'external',
    requestId: 'owner-agent',
    secret,
  });
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: wave.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'owned-synthesis',
  });
  const worker = await f.app.ctx.sessions.authenticate(secret);
  assert.equal((await f.app.ctx.scope.authorityActor(worker)).id, owner.actorId);
  const evidence: Artifact[] = [];
  for (const title of ['Report', 'Change specification'])
    evidence.push(
      (await f.app.ctx.tools.call('artifact.create', worker, {
        title,
        content:
          '# Summary\nThe frozen evidence and five independent perspectives support these observations.',
      })) as Artifact,
    );
  const submitted = (await f.app.ctx.tools.call('reflection.submit', worker, {
    reflectionId: wave.id,
    expectedRevision: wave.workflow.revision,
    reportArtifactId: evidence[0]!.id,
    changeSpecArtifactId: evidence[1]!.id,
    requestId: 'worker-submit',
  })) as Reflection;
  assert.equal(submitted.workflow.state, 'in_review');
  assert.equal(submitted.review!.producerId, worker.actorId);
  assert.equal(submitted.review!.administrativeActorId, owner.actorId);
  await f.app.ctx.sessions.releaseAgentAssignment(secret, execution.id);
  await f.app.ctx.domainEvents.drain();
});

test('reflection synthesis and its existing review own paper changes atomically', async (t) => {
  const f = await fixture(t);
  let wave = await f.lenses(
    await f.app.ctx.research.startReflection(f.owner, { requestId: 'paper-reflection' }),
  );
  const changes = await f.app.ctx.artifacts.create(f.owner, {
    title: 'Cross-experiment paper edits',
    mediaType: 'application/json',
    content: JSON.stringify({
      documents: [
        {
          kind: 'results',
          expectedRevision: 0,
          changes: [
            {
              id: 'synthesis',
              title: 'Synthesis',
              content: 'No completed experiments; no empirical conclusion is supported.',
            },
          ],
        },
      ],
    }),
  });
  const input = {
    reflectionId: wave.id,
    reportArtifactId: (await f.create(f.owner, 'Report')).id,
    changeSpecArtifactId: (await f.create(f.owner, 'Change specification')).id,
    paperChangesArtifactId: changes.id,
    expectedRevision: wave.workflow.revision,
    requestId: 'paper-synthesis',
  };
  wave = await f.app.ctx.reflections.submit(f.owner, input);
  assert.deepEqual(await f.app.ctx.reflections.submit(f.owner, input), wave);
  assert.equal((await f.app.ctx.paper.read(f.owner)).documents.results.current.revision, 0);
  assert.ok(wave.review!.artifactIds.includes(changes.id));
  const reviewer = await f.actor('Scientific reviewer', 'reviewer');
  const assignment = await f.app.ctx.workflows.assignment(reviewer, wave.id);
  assert.ok(JSON.stringify(assignment).includes('reflection.get'));
  assert.ok((await f.app.ctx.reflections.get(f.owner, wave.id)).paperProposal);
  wave = await f.verdict(wave, reviewer, true);
  const published = (await f.app.ctx.paper.read(f.owner)).documents.results.published!;
  assert.equal(published.publication.source.id, wave.id);
  assert.equal(published.publication.reviewId, wave.review!.id);
  assert.equal(
    (await f.app.ctx.reflections.approved(f.owner, wave.id)).paperProposal!.artifact.id,
    changes.id,
  );
  assert.equal(
    await f.app.ctx.state.read(
      async (sql) =>
        (await sql.get<{ count: number }>(
          "SELECT COUNT(*) count FROM wf_instances WHERE workflow='living-paper'",
        ))!.count,
    ),
    0,
  );
});

test('a leased lens reads research added after assignment through existing tools without seeing peer reports', async (t) => {
  const f = await fixture(t);
  const taskInput = {
    title: 'Existing work',
    goal: 'Check feasibility',
    checks: ['Report outcome'],
    requestId: 'existing-task',
  };
  const task = await f.app.ctx.tasks.create(f.owner, taskInput);
  const experimentInput = {
    name: 'existing-experiment',
    intent: 'Test feasibility',
    requestId: 'existing-experiment',
  };
  const experiment = await f.app.ctx.experiments.create(f.owner, experimentInput);
  const tools = (await f.app.ctx.tools.list()).map((tool) => tool.name);
  assert.equal(tools.filter((name) => name === 'reflection.create').length, 1);
  const wave = (await f.app.ctx.tools.call('reflection.create', f.owner, {
    requestId: 'live-wave',
  })) as Reflection;
  const secret = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Live lens',
    runnerId: 'external',
    requestId: 'live-agent',
    secret,
  });
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: wave.lenses[0]!.id,
    expectedRevision: 0,
    requestId: 'live-assignment',
  });
  const caller = await f.app.ctx.sessions.authenticate(secret);
  const call = async (name: string, input: Record<string, unknown>) =>
    f.app.ctx.tools.call(name, caller, input);
  const evidence = await f.create(f.owner, 'New evidence after the lens started');
  // A session reads whatever its project holds, before and after its assignment.
  assert.ok(await call('artifact.read', { artifactId: evidence.id }));
  await f.app.ctx.experiments.attach(f.owner, {
    experimentId: experiment.id,
    artifactId: evidence.id,
    role: 'plan',
    path: 'plan.md',
    attemptIndex: 1,
    expectedRevision: 0,
    requestId: 'attach-later',
  });
  assert.match(
    JSON.stringify(await call('artifact.read', { artifactId: evidence.id })),
    /New evidence after the lens started/,
  );
  assert.ok(
    JSON.stringify(await call('experiment.get_state', { experimentId: experiment.id })).includes(
      evidence.id,
    ),
  );
  const delivery = await f.create(f.owner, 'Check feasibility: report outcome');
  const submitted = await f.app.ctx.tasks.submitDelivery(f.owner, {
    taskId: task.id,
    expectedRevision: task.workflow.revision,
    artifactIds: [delivery.id],
    confirmations: [
      {
        checkNumber: 1,
        status: 'met',
        evidenceIds: [delivery.id],
        notes: 'Reported the feasibility outcome.',
      },
    ],
    requestId: 'submit-existing',
  });
  assert.ok(
    JSON.stringify(await call('review.get', { reviewId: submitted.reviewId! })).includes(
      delivery.id,
    ),
  );
  assert.match(
    JSON.stringify(await call('artifact.read', { artifactId: delivery.id })),
    /report outcome/,
  );
  const taskNow = await f.app.ctx.tasks.markFailed(f.owner, {
    taskId: task.id,
    expectedRevision: submitted.workflow.revision,
    reason: 'The initial feasibility check ruled out this approach.',
    requestId: 'finish-existing',
  });
  assert.equal(taskNow.workflow.state, 'failed');
  assert.match(JSON.stringify(await call('task.get', { taskId: task.id })), /failed/);
  const claim = await f.app.ctx.claims.create(f.owner, {
    statement: 'A live observation',
    requestId: 'new-observation',
  });
  await f.app.ctx.claims.update(f.owner, {
    claimId: claim.id,
    expectedRevision: 0,
    status: 'weakened',
    requestId: 'update-observation',
  });
  assert.match(JSON.stringify(await call('project.records', {})), /weakened/);
  assert.ok(await call('paper.read', {}));
  const peer = await f.actor('Other lens');
  const peerReport = await f.create(peer, 'Private independent lens report');
  await f.app.ctx.reflections.submitLens(peer, {
    lensId: wave.lenses[1]!.id,
    artifactId: peerReport.id,
    expectedRevision: 0,
    requestId: 'peer-report',
  });
  // A peer's report is readable too (no read constraints); lens independence is asked of
  // the agent, not enforced here.
  assert.ok(await call('artifact.read', { artifactId: peerReport.id }));
  await assert.rejects(
    call('claim.update', {
      claimId: claim.id,
      expectedRevision: 1,
      status: 'supported',
      requestId: 'not-allowed',
    }),
    { code: 'execution_tool_forbidden' },
  );
  const boot = await f.app.ctx.scope.bootstrap({
    projectName: 'Other project',
    actorName: 'Other owner',
  });
  const other = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const foreignTask = await f.app.ctx.tasks.create(other, {
    ...taskInput,
    requestId: 'other-task',
  });
  await assert.rejects(call('task.get', { taskId: foreignTask.id }), { code: 'not_found' });
  const foreignArtifact = await f.create(other, 'Other project evidence');
  await assert.rejects(call('artifact.read', { artifactId: foreignArtifact.id }), {
    code: 'not_found',
  });
  assert.equal(
    (await f.app.ctx.tasks.create(f.owner, taskInput)).id,
    task.id,
    'a committed create can still replay',
  );
  assert.equal((await f.app.ctx.experiments.create(f.owner, experimentInput)).id, experiment.id);

  const provider = f.app.ctx.reflections;
  await f.app.setEnabled('knowledge', false);
  assert.equal(f.app.status().find((plugin) => plugin.id === 'reflections')!.state, 'active');
  assert.equal(f.app.status().find((plugin) => plugin.id === 'research')!.state, 'active');
  assert.equal(f.app.ctx.reflections, provider);
  assert.ok((await f.app.ctx.tools.list()).some((tool) => tool.name === 'reflection.create'));
  for (const [name, input] of [
    ['artifact.read', { artifactId: evidence.id }],
    ['artifact.get', { artifactId: delivery.id }],
    ['review.get', { reviewId: submitted.reviewId! }],
  ] as const)
    assert.ok(await call(name, input), name);
  const ownReport = (await call('artifact.create', {
    title: 'Independent report while research access is unavailable',
    content:
      '# Summary\nThe observed feasibility outcome is retained.\n# Evidence\nResearch inputs read before the outage support this observation.',
  })) as Artifact;
  assert.match(
    JSON.stringify(await call('artifact.read', { artifactId: ownReport.id })),
    /observed feasibility outcome/,
  );
  assert.equal((await f.app.ctx.sessions.agentSelf(secret)).current!.id, execution.id);
  assert.ok((await f.app.ctx.workflows.assignment(f.owner, wave.lenses[2]!.id)).context);
  assert.equal(
    (await f.app.ctx.sessions.heartbeat(f.owner, { sessionId: execution.id, runnerId: 'external' }))
      .id,
    execution.id,
  );
  assert.ok(await call('reflection.lens', { lensId: wave.lenses[0]!.id }));

  await f.app.setEnabled('knowledge', true);
  assert.equal(f.app.ctx.reflections, provider);
  assert.equal((await f.app.ctx.sessions.agentSelf(secret)).current!.id, execution.id);
  assert.equal(
    (await f.app.ctx.tools.list()).filter((tool) => tool.name === 'reflection.create').length,
    1,
  );
  assert.match(
    JSON.stringify(await call('artifact.read', { artifactId: evidence.id })),
    /New evidence/,
  );
  assert.ok(await call('review.get', { reviewId: submitted.reviewId! }));
  assert.ok(await call('artifact.read', { artifactId: peerReport.id }));

  const blocked = async () =>
    await f.app.ctx.experiments.create(f.owner, {
      ...experimentInput,
      name: 'new-experiment',
      requestId: 'blocked',
    });
  await assert.rejects(blocked, { code: 'workflow_creation_paused' });
  await f.app.setEnabled('reflections', false);
  await assert.rejects(
    blocked,
    { code: 'workflow_creation_paused' },
    'unloading the owner cannot bypass the durable pause',
  );
  await f.app.setEnabled('reflections', true);
  assert.match(
    JSON.stringify(await call('artifact.read', { artifactId: evidence.id })),
    /New evidence/,
  );
  await f.app.setEnabled('knowledge', false);
  const completed = (await call('reflection.submit_lens', {
    lensId: wave.lenses[0]!.id,
    artifactId: ownReport.id,
    expectedRevision: 0,
    requestId: 'submit-without-knowledge',
  })) as { workflow: { state: string } };
  assert.equal(completed.workflow.state, 'complete');
  await f.app.ctx.sessions.releaseAgentAssignment(secret, execution.id);
  await f.app.setEnabled('knowledge', true);
  assert.deepEqual(
    (await f.app.ctx.tools.list()).map((tool) => tool.name),
    tools,
    'no new tools',
  );
  assert.equal(
    await f.app.ctx.state.read(
      async (sql) =>
        (await sql.get<{ count: number }>('SELECT COUNT(*) count FROM knowledge_snapshots'))!.count,
    ),
    0,
  );
});

test('large research stays outside the assignment and live source permissions do not inflate its packet', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++)
    await f.app.ctx.claims.create(f.owner, {
      statement: `Claim ${i}: ${'long research context '.repeat(500)}`,
      requestId: `large-${i}`,
    });
  assert.ok(JSON.stringify(await f.app.ctx.knowledge.records(f.owner)).length > 100_000);
  const wave = await f.app.ctx.research.startReflection(f.owner, { requestId: 'large-wave' });
  const secret = token();
  await f.app.ctx.sessions.registerAgent(f.owner, {
    name: 'Compact lens',
    runnerId: 'external',
    requestId: 'compact-agent',
    secret,
  });
  const execution = await f.app.ctx.sessions.assignAgent(secret, {
    instanceId: wave.lenses[0]!.id,
    expectedRevision: 0,
    requestId: 'compact-assignment',
  });
  assert.ok(Buffer.byteLength(JSON.stringify(execution.assignment)) < 16_000);
  assert.ok(!execution.assignment.context!.prompt.includes('long research context'));
  assert.equal(wave.corpus, null);
  assert.equal(wave.paper, null);
});

test('standalone Reflections can create and complete its own work without Research or Knowledge', async (t) => {
  const f = await fixture(t);
  await f.app.setEnabled('knowledge', false);
  assert.equal(f.app.status().find((plugin) => plugin.id === 'reflections')!.state, 'active');
  const wave = await f.app.ctx.reflections.create(f.owner, { requestId: 'standalone-wave' });
  assert.ok((await f.app.ctx.workflows.assignment(f.owner, wave.lenses[0]!.id)).context);
  const submitted = await f.synthesize(await f.lenses(wave));
  const approved = await f.verdict(
    submitted,
    await f.actor('Standalone reviewer', 'reviewer'),
    true,
  );
  assert.equal(approved.workflow.state, 'approved');
  assert.deepEqual((await f.app.ctx.reflections.approved(f.owner, wave.id)).experimentIds, []);
});
