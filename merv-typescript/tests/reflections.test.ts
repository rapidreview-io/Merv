import type { Caller, ReviewApplication } from '@merv/contracts';

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { Reflection } from '../packages/reflections/src/types.js';
import { createApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
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
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Reflection integration',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const actor = async (name: string, role: 'producer' | 'reviewer' | 'operator' = 'producer') => {
    const issued = await app.ctx.scope.credentials.issueActor(owner, { name, role });
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
    for (const [i, lens] of wave.lenses.entries()) {
      const caller = await actor(`Lens ${wave.attempt}-${i}`);
      const artifact = await create(caller, lens.perspective);
      await app.ctx.reflections.submitLens(caller, {
        lensId: lens.id,
        artifactId: artifact.id,
        expectedRevision: 0,
        requestId: `lens-${lens.id}`,
      });
    }
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
  let agents = 0;
  /** What a session offered this step is granted, read by a fresh agent that lets it go. */
  const granted = async (instanceId: string, expectedRevision: number) => {
    const session = await app.ctx.sessions.offer(owner, {
      instanceId,
      expectedRevision,
      runnerId: 'external',
      requestId: `read-${++agents}`,
      secret: token(),
    });
    await app.ctx.sessions.release(owner, { sessionId: session.id, runnerId: 'external' });
    await app.ctx.domainEvents.drain();
    return session.execution.references;
  };
  return { app, owner, actor, create, lenses, synthesize, verdict, granted };
}

test('reflection uses live research, joins five independent ordinary workflows, reviews and retains exact approval', async (t) => {
  const f = await fixture(t);
  let wave = await f.app.ctx.reflections.create(f.owner, { requestId: 'wave' });
  assert.equal(wave.workflow.workflow, 'reflection');
  assert.equal(wave.lenses.length, 5);
  assert.ok(wave.lenses.every((l) => l.workflow.workflow === 'reflection.lens'));
  assert.equal((await f.app.ctx.reflections.create(f.owner, { requestId: 'wave' })).id, wave.id);
  await assert.rejects(
    async () => await f.app.ctx.reflections.create(f.owner, { requestId: 'other' }),
    {
      code: 'reflection_open',
    },
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.reflections.create(f.owner, { requestId: 'wave', title: 'Different' }),
    { code: 'request_conflict' },
  );
  assert.equal(await f.app.ctx.reflections.approved(f.owner, wave.id), null);
  // The frozen corpus, paper snapshot and experiment list of retired waves are no longer shown.
  for (const retired of ['corpus', 'paper', 'experimentIds', 'paperProposal'])
    assert.ok(!(retired in wave), retired);
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
    // And asking whether that submission is ready gives the same answer the call would.
    assert.ok(
      (
        await f.app.ctx.workflows.evaluate(lensWorker, wave.lenses[0]!.id, {
          action: 'submit',
          input: { artifactId: emptySummary.id, expectedRevision: 0 },
        })
      ).blockers.some((blocker) => blocker.code === 'reflection_summary_required'),
    );
  }
  const artifact = await f.create(lensWorker, 'First');
  const replacementWorker = await f.actor('Replacement lens worker');
  const replacement = await f.create(replacementWorker, 'Replacement');
  const caller = { ...lensWorker };
  const input = {
    lensId: wave.lenses[0]!.id,
    artifactId: artifact.id,
    expectedRevision: 0,
    requestId: 'first',
  };
  const original = { ...input };
  const submitting = f.app.ctx.reflections.submitLens(caller, input);
  Object.assign(caller, replacementWorker);
  Object.assign(input, { artifactId: replacement.id, requestId: 'replacement' });
  const submitted = await submitting;
  assert.equal(submitted.producerId, lensWorker.actorId);
  assert.equal(submitted.artifact!.id, artifact.id);
  assert.deepEqual(await f.app.ctx.reflections.submitLens(lensWorker, original), submitted);
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
  const approved = (await f.app.ctx.reflections.approved(f.owner, wave.id))!;
  assert.equal(approved.report.id, wave.report!.id);
  // A text change specification is never parsed: no plan, and no criterion to judge one.
  assert.equal(wave.plan, null);
  assert.equal(approved.plan, undefined);
  assert.equal(wave.review!.criteria.length, 4);
  assert.equal(approved.reviewerId, reviewer.actorId);
  for (const retired of ['corpus', 'paper', 'experimentIds', 'paperProposal', 'graph'])
    assert.ok(!(retired in approved), retired);
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
    { code: 'state_constraint' },
  );
  assert.ok((await f.app.ctx.reflections.create(f.owner, { requestId: 'next-wave' })).id);
});

test('a lens worker cannot read the other lenses of its reflecting wave', async (t) => {
  const f = await fixture(t);
  const wave = await f.app.ctx.reflections.create(f.owner, { requestId: 'independent-wave' });
  const [first, mine] = wave.lenses;
  const producer = await f.actor('First lens');
  const report = await f.create(producer, first!.perspective);
  await f.app.ctx.reflections.submitLens(producer, {
    lensId: first!.id,
    artifactId: report.id,
    expectedRevision: 0,
    requestId: 'first-lens',
  });
  const secret = token();
  const execution = await f.app.ctx.sessions.offer(f.owner, {
    instanceId: mine!.id,
    expectedRevision: 0,
    runnerId: 'external',
    requestId: `assign-${mine!.id}`,
    secret,
  });
  const worker = await f.app.ctx.sessions.authenticate(secret);
  const read = (await f.app.ctx.tools.call('reflection.get', worker, {
    reflectionId: wave.id,
  })) as Reflection;
  assert.equal(read.workflow.state, 'reflecting');
  assert.deepEqual(
    read.lenses.map((lens) => lens.artifact),
    [null, null, null, null, null],
  );
  assert.ok(!JSON.stringify(read).includes(report.id), 'no other lens output reaches the worker');
  const other = (await f.app.ctx.tools.call('reflection.lens', worker, {
    lensId: first!.id,
  })) as Reflection['lenses'][number];
  assert.equal(other.artifact, null);
  assert.ok(!JSON.stringify(other).includes(report.id));
  // Anyone outside the wave's lens sessions still reads every submitted lens.
  const shown = await f.app.ctx.reflections.get(f.owner, wave.id);
  assert.equal(shown.lenses[0]!.artifact!.id, report.id);
  assert.equal((await f.app.ctx.reflections.lens(f.owner, first!.id)).artifact!.id, report.id);
  await f.app.ctx.sessions.release(f.owner, { sessionId: execution.id, runnerId: 'external' });
});
