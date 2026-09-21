import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';
import { seedArchivedClaim } from './fixtures/archived-claim.js';

test('research claims are read-only history; experiments, reviewer claims and paper links remain independent', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-claim-archive-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Retained science',
    actorName: 'Owner',
  });
  const owner = { actorId: boot.actor.id, projectId: boot.project.id };
  const old = await seedArchivedClaim(app.ctx.state, owner, {
    statement: 'Retrieval improves accuracy.',
    status: 'weakened',
  });
  const foreign = await app.ctx.scope.bootstrap({
    projectName: 'Private science',
    actorName: 'Other',
  });
  const other = { actorId: foreign.actor.id, projectId: foreign.project.id };
  assert.equal('create' in app.ctx.claims, false);
  assert.equal('update' in app.ctx.claims, false);
  const tools = (await app.ctx.tools.list()).map((tool) => tool.name);
  assert.equal(
    tools.some((name) => name.startsWith('claim.')),
    false,
  );
  assert.ok(tools.includes('review.start'), 'review ownership is still available');
  assert.deepEqual((await app.ctx.knowledge.records(owner)).archivedClaims, [old]);
  assert.equal('claims' in (await app.ctx.knowledge.records(owner)), false);
  assert.deepEqual((await app.ctx.knowledge.records(other)).archivedClaims, []);
  const [ownRef] = await app.ctx.knowledge.resolve(owner, [`claim:${old.id}`]);
  assert.equal(ownRef.label, old.statement);
  assert.equal((await app.ctx.knowledge.resolve(other, [`claim:${old.id}`]))[0].status, 'missing');
  const experiment = await app.ctx.experiments.create(owner, {
    name: 'retrieval-check',
    intent: 'Does retrieval improve accuracy?',
    requestId: 'experiment',
  });
  assert.equal(experiment.testedClaimIds, undefined);
  await assert.rejects(
    app.ctx.experiments.create(owner, {
      name: 'retired-field',
      intent: 'Invalid old input',
      testedClaimIds: [old.id],
      requestId: 'old-input',
    } as never),
    { code: 'invalid_experiment_input' },
  );
  const source = `We are investigating retrieval in [${experiment.name}](/experiments/${experiment.id}).`;
  await app.ctx.paper.patch(owner, {
    kind: 'methods',
    expectedRevision: 0,
    requestId: 'paper',
    changes: [{ id: 'retrieval', title: 'Retrieval', content: source }],
  });
  assert.equal(
    (await app.ctx.paper.read(owner)).documents.methods.current.sections[0].content,
    source,
  );
  assert.deepEqual(await app.ctx.claims.get(owner, old.id), old);
  await app.setEnabled('claims', false);
  assert.ok(
    await app.ctx.experiments.get(owner, experiment.id),
    'the archive is not an experiment dependency',
  );
  await app.setEnabled('claims', true);
  assert.deepEqual(await app.ctx.claims.get(owner, old.id), old);
});
