/**
 * A wave sent back to its lenses keeps every earlier attempt's lenses in its sidebar: they are
 * read together, so the sidebar costs the same at every attempt, and Sessions lists the threads
 * of all of them in one read.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Caller, ReviewApplication } from '@merv/contracts';
import type { Reflection } from '@merv/reflections/types';
import { createApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { counter } from './fixtures/statements.js';

test('a wave’s sidebar costs the same at every attempt, and its threads are one read', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-wave-panel-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins = config.plugins.filter(
    (entry: { id: string }) =>
      !['api', 'identity', 'ui'].includes(entry.id) &&
      !entry.id.endsWith('-api') &&
      !entry.id.endsWith('-ui'),
  );
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Wave panel',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const actor = async (name: string, role: 'producer' | 'reviewer') => {
    const issued = await app.ctx.scope.credentials.issueActor(owner, { name, role });
    return {
      projectId: owner.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    } as Caller;
  };
  const report = async (caller: Caller, label: string) =>
    await app.ctx.artifacts.create(caller, { title: label, content: `# Summary\n${label}.` });
  // Every lens reports, the synthesis is submitted, and its review sends the wave back to them.
  const returned = async (wave: Reflection, round: number) => {
    for (const lens of wave.lenses) {
      const author = await actor(`Lens ${round} ${lens.perspective}`, 'producer');
      await app.ctx.reflections.submitLens(author, {
        lensId: lens.id,
        artifactId: (await report(author, lens.perspective)).id,
        expectedRevision: 0,
        requestId: `lens-${lens.id}`,
      });
    }
    wave = await app.ctx.reflections.get(owner, wave.id);
    wave = await app.ctx.reflections.submit(owner, {
      reflectionId: wave.id,
      reportArtifactId: (await report(owner, 'Synthesis')).id,
      changeSpecArtifactId: (await report(owner, 'Changes')).id,
      expectedRevision: wave.workflow.revision,
      requestId: `synthesis-${round}`,
    });
    const reviewer = await actor(`Reviewer ${round}`, 'reviewer');
    const review = await app.ctx.reviews.start(reviewer, wave.review!.id);
    const input: ReviewApplication = {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: wave.workflow.revision,
      verdict: 'needs_changes',
      returnTo: 'reflecting',
      notes: 'The lenses missed the corpus.',
      synopsis: 'The lenses must look again at the documented coverage problems.',
      findings: review.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: 'not_met' as const,
        evidenceIds: [review.artifactIds[0]!],
        notes: 'Checked against the corpus.',
      })),
      requestId: `verdict-${round}`,
    };
    return (await app.ctx.reviews.apply(reviewer, input)) as Reflection;
  };
  const measure = counter(app.ctx.state);
  const panel = async (wave: Reflection) => {
    let instances: string[] = [];
    const statements = await measure(async () => {
      instances = (await app.ctx.reflections.runningPanel(owner, wave.id))!.unit!.instances!;
    });
    return { statements, instances };
  };
  let wave = await app.ctx.reflections.create(owner, { requestId: 'wave' });
  wave = await returned(wave, 1);
  const second = await panel(wave);
  wave = await returned(wave, 2);
  const third = await panel(wave);
  assert.equal(wave.attempt, 3);
  assert.equal(second.instances.length, 10);
  assert.equal(third.instances.length, 15);
  assert.equal(
    third.statements,
    second.statements,
    `the sidebar took ${second.statements} statements at attempt 2 and ${third.statements} at 3`,
  );

  // Two lenses' agents: one read of every record inside the wave lists both threads.
  const offered = [];
  for (const [index, instanceId] of [third.instances[10]!, third.instances[11]!].entries())
    offered.push(
      await app.ctx.sessions.offer(owner, {
        instanceId,
        expectedRevision: 0,
        runnerId: 'external',
        requestId: `visit-${index}`,
        secret: `ms_${String(index).padStart(43, 'x')}`,
      }),
    );
  const listed = await app.ctx.sessions.threads.list(owner, [wave.id, ...third.instances]);
  assert.deepEqual(
    listed.map((thread) => thread.id).sort(),
    offered.map((session) => session.threadId).sort(),
  );
  assert.deepEqual(
    await app.ctx.sessions.threads.list(owner, third.instances[10]!),
    listed.filter((thread) => thread.instanceId === third.instances[10]),
  );
});
