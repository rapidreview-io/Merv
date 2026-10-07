/**
 * On a wave sent back to its lenses, a lens worker of attempt 2 reads neither the other lenses'
 * reports nor the attempt-1 synthesis, which reconciles them all: not through reflection.get,
 * and not through artifact.read.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Caller, ReviewApplication } from '@merv/contracts';
import type { Reflection } from '@merv/reflections/types';
import type { Session } from '../packages/sessions/src/types.js';
import type { ApplicationConfig } from '../src/config.js';
import { createApp } from './fixtures/app.js';
import { s3Blobs } from './fixtures/s3-blobs.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;

test('an attempt-2 lens worker reads no synthesis of an earlier round either', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'merv-c11b-lens2-'));
  const env = `MERV_LENS_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = randomBytes(48).toString('hex');
  const s3 = await s3Blobs(t);
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins = config.plugins.map((plugin) =>
    plugin.id === 'sessions'
      ? { ...plugin, config: { managedSecretEnv: env, sweepIntervalMs: 60_000 } }
      : plugin.id === 'blobs'
        ? s3.entry
        : plugin,
  );
  const app = await createApp({ directory, config, port: 0 });
  t.after(async () => {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
    delete process.env[env];
  });
  const scope = app.ctx.scope;
  const boot = await scope.credentials.bootstrap({ projectName: 'Lens 2', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const actor = async (name: string, role: 'producer' | 'reviewer') => {
    const issued = await scope.credentials.issueActor(owner, { name, role });
    return {
      projectId: owner.projectId,
      actorId: issued.actor.id,
      credentialId: issued.credential.id,
    } as Caller;
  };
  let wave: Reflection = await app.ctx.reflections.create(owner, { requestId: 'wave' });
  let lensB = '';
  for (const lens of wave.lenses) {
    const author = await actor(`Lens ${lens.perspective}`, 'producer');
    const report = await app.ctx.artifacts.create(author, {
      title: `Lens ${lens.perspective}`,
      content: `# Summary\nLENS-${lens.perspective}-SECRET.`,
    });
    if (!lensB && lens !== wave.lenses[0]) lensB = report.id;
    await app.ctx.reflections.submitLens(author, {
      lensId: lens.id,
      artifactId: report.id,
      expectedRevision: 0,
      requestId: `lens-${lens.id}`,
    });
  }
  wave = await app.ctx.reflections.get(owner, wave.id);
  const reviewer = await actor('Reviewer', 'reviewer');
  // Synthesis S1, sent back to synthesis; then S2, sent back to the lenses.
  const synthesize = async (marker: string, returnTo: 'synthesizing' | 'reflecting') => {
    const synthesis = await app.ctx.artifacts.create(owner, {
      title: `Synthesis ${marker}`,
      content: `# Summary\n${marker} quotes LENS-B-SECRET and every other lens.`,
    });
    wave = await app.ctx.reflections.submit(owner, {
      reflectionId: wave.id,
      reportArtifactId: synthesis.id,
      changeSpecArtifactId: (
        await app.ctx.artifacts.create(owner, { title: `C ${marker}`, content: marker })
      ).id,
      expectedRevision: wave.workflow.revision,
      requestId: `synthesis-${marker}`,
    });
    const review = await app.ctx.reviews.start(reviewer, wave.review!.id);
    const input: ReviewApplication = {
      reviewId: review.id,
      claimId: review.claimId!,
      expectedRevision: wave.workflow.revision,
      verdict: 'needs_changes',
      returnTo,
      notes: 'Look again.',
      synopsis: 'The synthesis must look again at the documented coverage problems.',
      findings: review.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: 'not_met' as const,
        evidenceIds: [review.artifactIds[0]!],
        notes: 'Checked.',
      })),
      requestId: `verdict-${marker}`,
    };
    wave = (await app.ctx.reviews.apply(reviewer, input)) as Reflection;
    return synthesis;
  };
  const first = await synthesize('S1', 'synthesizing');
  assert.equal(wave.workflow.state, 'synthesizing');
  await synthesize('S2', 'reflecting');
  assert.equal(wave.attempt, 2);
  assert.equal(wave.workflow.state, 'reflecting');

  // A lens worker of attempt 2.
  const lensA2 = wave.lenses[0]!;
  const workSecret = secret();
  const session = (await app.ctx.sessions.offer(owner, {
    instanceId: lensA2.id,
    expectedRevision: 0,
    runnerId: 'runner-a',
    requestId: randomUUID(),
    secret: workSecret,
  })) as Session;
  const response = await fetch(`${app.ctx.api.url}/sessions/${session.id}/attach`, {
    method: 'POST',
    headers: { authorization: `Bearer ${boot.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ runnerId: 'runner-a', hostRef: `launch-${randomUUID()}` }),
  });
  assert.equal(response.status, 200, await response.text());
  const worker = await app.ctx.sessions.authenticate(workSecret);
  const got = (await app.ctx.tools.invoke('reflection.get', worker, { reflectionId: wave.id }))
    .value as any;
  const lensBRead = await app.ctx.tools.invoke('artifact.read', worker, { artifactId: lensB }).then(
    () => 'read',
    (e: any) => `refused ${e.code}`,
  );
  const synthRead = await app.ctx.tools
    .invoke('artifact.read', worker, { artifactId: first.id })
    .then(
      (r: any) => JSON.stringify(r.value).includes('LENS-B-SECRET'),
      (e: any) => `refused ${e.code}`,
    );
  assert.equal(got.workflow.state, 'reflecting');
  assert.equal(lensBRead, 'refused not_found', 'the earlier lens B report is withheld');
  assert.equal(got.report, null, 'reflection.get withholds the earlier synthesis');
  assert.equal(got.changeSpec, null);
  assert.equal(synthRead, 'refused not_found', 'the first-round synthesis is withheld too');
  // The owner still reads it.
  const owned = await app.ctx.reflections.get(owner, wave.id);
  assert.ok(owned.report);
});
