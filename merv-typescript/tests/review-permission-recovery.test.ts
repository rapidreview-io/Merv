import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { ReviewService } from '@merv/reviews';
import type { Role, StoredEvent } from '@merv/contracts';
import { createApp } from '../src/app.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-permissions-'));
  const state = new SqliteState(join(directory, 'state.db'));
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Recovery', actorName: 'Operator' });
  const operator = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: Role) => ({
    actorId: (await scope.issueActor(operator, { name: role, role })).actor.id,
    projectId: operator.projectId,
  });
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    replacement = await issue('reviewer');
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const proof = await artifacts.create(producer, { title: 'Proof', content: 'Execution passed.' });
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  let sequence = 0;
  const request = async () =>
    await reviews.request(producer, {
      subjectId: `subject-${++sequence}`,
      subjectRevision: 1,
      producerId: producer.actorId,
      criteria: ['Execution passes.'],
      artifactIds: [proof.id],
      requestId: `request-${sequence}`,
    });
  // The fixture supplies the committed Scope event contract. Human membership behavior is
  // covered by Scope; recovery must also handle event delivery after permission restoration.
  const roleEvent = async (beforeRole: Role, role: Role) =>
    await state.transaction(async (tx) => {
      await tx.run('UPDATE actors SET role=? WHERE id=?', role, reviewer.actorId);
      return await state.appendEvent(tx, {
        projectId: operator.projectId,
        actorId: operator.actorId,
        type: 'actor.permissions_changed',
        subjectId: reviewer.actorId,
        data: {
          beforeRole,
          role,
          previousMembershipId: 'membership-before',
          membershipId: 'membership-after',
        },
      });
    });
  const deliver = async (event: StoredEvent) =>
    await state.transaction(async (tx) => {
      if (event.type === 'actor.revoked') await reviews.actorRevoked(event, tx);
      else await reviews.actorPermissionsChanged(event, tx);
    });
  const releases = async () =>
    (await state.events(operator.projectId)).filter(
      (event) => event.type === 'review.claim_released',
    );
  return {
    state,
    scope,
    reviews,
    operator,
    producer,
    reviewer,
    replacement,
    request,
    roleEvent,
    deliver,
    releases,
    async close() {
      await state.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('losing review permission releases unfinished claims without changing evidence and fences the old claim', async () => {
  const f = await fixture();
  try {
    const requested = await f.request(),
      claim = await f.reviews.start(f.reviewer, requested.id);
    const event = await f.roleEvent('reviewer', 'reader');
    assert.equal(await f.scope.eligible(f.operator.projectId, f.reviewer.actorId, 'read'), true);
    assert.equal(await f.scope.eligible(f.operator.projectId, f.reviewer.actorId, 'review'), false);
    await f.deliver(event);
    const recovered = await f.reviews.get(f.operator, claim.id);
    assert.equal(recovered.status, 'requested');
    assert.equal(recovered.snapshotHash, requested.snapshotHash);
    assert.deepEqual(recovered.artifactIds, requested.artifactIds);
    assert.deepEqual(recovered.criteria, requested.criteria);
    assert.deepEqual(recovered.recovery, {
      eventId: event.id,
      previousActorId: f.reviewer.actorId,
      previousClaimId: claim.claimId,
      reason: 'review_permission_lost',
    });
    await f.deliver(event);
    assert.equal((await f.releases()).length, 1);
    const replacement = await f.reviews.start(f.replacement, claim.id);
    assert.equal(replacement.claimGeneration, 2);
    assert.notEqual(replacement.claimId, claim.claimId);
    await assert.rejects(
      async () =>
        await f.reviews.submit(f.replacement, {
          reviewId: claim.id,
          claimId: claim.claimId!,
          verdict: 'pass',
          notes: 'Checked.',
          requestId: 'stale',
        }),
      { code: 'stale_claim' },
    );
  } finally {
    await f.close();
  }
});

test('role changes that retain or grant review permission do not release claims', async () => {
  const f = await fixture();
  try {
    const claim = await f.reviews.start(f.reviewer, (await f.request()).id);
    await f.deliver(await f.roleEvent('reviewer', 'operator'));
    await f.deliver(await f.roleEvent('operator', 'reviewer'));
    await f.deliver(await f.roleEvent('reader', 'reviewer'));
    assert.deepEqual(await f.reviews.get(f.operator, claim.id), claim);
    assert.equal((await f.releases()).length, 0);
  } finally {
    await f.close();
  }
});

test('restored permission does not cancel old-claim recovery, while replay cannot release a newer claim', async () => {
  const f = await fixture();
  try {
    const old = await f.reviews.start(f.reviewer, (await f.request()).id);
    const loss = await f.roleEvent('reviewer', 'producer');
    await f.roleEvent('producer', 'reviewer');
    assert.equal(await f.scope.eligible(f.operator.projectId, f.reviewer.actorId, 'review'), true);
    await f.deliver(loss);
    assert.equal((await f.reviews.get(f.operator, old.id)).status, 'requested');
    const fresh = await f.reviews.start(f.reviewer, old.id);
    await f.deliver(loss);
    assert.deepEqual(await f.reviews.get(f.operator, old.id), fresh);
    const laterLoss = await f.roleEvent('reviewer', 'reader');
    await f.deliver(laterLoss);
    assert.equal((await f.reviews.get(f.operator, old.id)).status, 'requested');
    assert.equal((await f.releases()).length, 2);
  } finally {
    await f.close();
  }
});

test('delayed membership revocation releases old claims after rejoin but leaves post-event claims intact', async () => {
  const f = await fixture();
  try {
    const old = await f.reviews.start(f.reviewer, (await f.request()).id);
    const event = await f.state.transaction(
      async (tx) =>
        await f.state.appendEvent(tx, {
          projectId: f.operator.projectId,
          actorId: f.operator.actorId,
          type: 'actor.revoked',
          subjectId: f.reviewer.actorId,
          data: { membershipId: 'old-membership' },
        }),
    );
    // The actor is already eligible again by delivery time, as after a rejoin.
    const newer = await f.reviews.start(f.reviewer, (await f.request()).id);
    await f.deliver(event);
    assert.equal((await f.reviews.get(f.operator, old.id)).status, 'requested');
    assert.deepEqual(await f.reviews.get(f.operator, newer.id), newer);
    const replacement = await f.reviews.start(f.reviewer, old.id);
    await f.deliver(event);
    assert.deepEqual(await f.reviews.get(f.operator, old.id), replacement);
    assert.equal((await f.releases()).length, 1);
  } finally {
    await f.close();
  }
});

test('permission-loss recovery preserves submitted verdicts and rolls back its event and claim together', async () => {
  const f = await fixture();
  try {
    const closed = await f.reviews.start(f.reviewer, (await f.request()).id);
    const submitted = await f.reviews.submit(f.reviewer, {
      reviewId: closed.id,
      claimId: closed.claimId!,
      verdict: 'pass',
      notes: 'Verified.',
      requestId: 'verdict',
    });
    const unfinished = await f.reviews.start(f.reviewer, (await f.request()).id);
    const event = await f.roleEvent('reviewer', 'reader');
    await assert.rejects(
      async () =>
        await f.state.transaction(async (tx) => {
          await f.reviews.actorPermissionsChanged(event, tx);
          throw new Error('Consumer failed');
        }),
      /Consumer failed/,
    );
    assert.deepEqual(await f.reviews.get(f.operator, unfinished.id), unfinished);
    assert.equal((await f.releases()).length, 0);
    await f.deliver(event);
    assert.deepEqual(await f.reviews.get(f.operator, closed.id), submitted);
    assert.equal((await f.reviews.get(f.operator, unfinished.id)).status, 'requested');
  } finally {
    await f.close();
  }
});

test('Reviews adds a separate durable permission consumer and catches up after unload', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-permission-consumer-'));
  const app = await createApp({ directory, api: false });
  try {
    const boot = await app.ctx.scope.bootstrap({ projectName: 'Catch-up', actorName: 'Operator' });
    const operator = { actorId: boot.actor.id, projectId: boot.project.id };
    const reviewer = {
      actorId: (await app.ctx.scope.issueActor(operator, { name: 'Reviewer', role: 'reviewer' }))
        .actor.id,
      projectId: operator.projectId,
    };
    const proof = await app.ctx.artifacts.create(operator, { title: 'Proof', content: 'Passed.' });
    const request = await app.ctx.reviews.request(operator, {
      subjectId: 'subject',
      subjectRevision: 1,
      producerId: operator.actorId,
      criteria: ['Passed.'],
      artifactIds: [proof.id],
      requestId: 'request',
    });
    const claim = await app.ctx.reviews.start(reviewer, request.id);
    await app.ctx.domainEvents.drain();
    const oldCursor = (await app.ctx.domainEvents.status()).find(
      (item) => item.id === 'reviews.actor-revoked.v1',
    )!.cursor;
    await app.setEnabled('reviews', false);
    await app.ctx.state.transaction(
      async (tx) =>
        await app.ctx.state.appendEvent(tx, {
          projectId: operator.projectId,
          actorId: operator.actorId,
          type: 'actor.permissions_changed',
          subjectId: reviewer.actorId,
          data: { beforeRole: 'reviewer', role: 'reader' },
        }),
    );
    await app.setEnabled('reviews', true);
    await app.ctx.domainEvents.drain();
    const recovered = await app.ctx.reviews.get(operator, claim.id);
    assert.equal(recovered.status, 'requested');
    assert.equal(recovered.recovery?.previousClaimId, claim.claimId);
    const consumers = await app.ctx.domainEvents.status();
    assert.ok(
      consumers.some(
        (item) => item.id === 'reviews.actor-permissions-changed.v1' && item.active && !item.error,
      ),
    );
    assert.ok(
      consumers.find((item) => item.id === 'reviews.actor-revoked.v1')!.cursor >= oldCursor,
    );
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const loss of ['role-loss', 'remove-rejoin'] as const) {
  test(`restored human cannot reuse a ${loss} claim while recovery is paused`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-review-authority-'));
    const app = await createApp({ directory, api: false });
    try {
      const { scope, state, reviews, tasks, artifacts, workflows, domainEvents } = app.ctx;
      const login = async (subject: string) =>
        await scope.acceptVerifiedIdentity({
          issuer: 'https://identity.example/auth/v1',
          subject,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      const owner = await login('owner'),
        reviewerUser = await login('reviewer');
      const project = await scope.createProject(owner, { name: 'Recovery', requestId: 'project' });
      await scope.addMember(owner, project.id, { subject: 'reviewer', role: 'reviewer' });
      const operator = await scope.caller(owner, project.id);
      const reviewer = await scope.caller(reviewerUser, project.id);
      const task = await tasks.create(operator, {
        title: 'Review authority',
        goal: 'Verify the result.',
        checks: ['The result is reproducible.'],
        requestId: 'task',
      });
      const proof = await artifacts.create(operator, {
        title: 'Proof',
        content: 'The result is reproducible.',
      });
      const pending = await tasks.submitDelivery(
        operator,
        confirmedDelivery({
          taskId: task.id,
          artifactIds: [proof.id],
          expectedRevision: 0,
          requestId: 'delivery',
        }),
      );
      const claimed = await reviews.start(reviewer, pending.reviewId!);
      const assignment = {
        taskId: task.id,
        purpose: 'review' as const,
        expectedRevision: 1,
        claimId: claimed.claimId!,
        requestId: 'context',
      };
      await tasks.context(reviewer, assignment);
      await domainEvents.drain();
      // Put both recovery consumers in a retry delay, as after a transient failure.
      // Other services remain active; explicit drains cannot release this claim yet.
      await state.transaction(
        async (tx) =>
          await tx.run(
            "UPDATE event_consumers SET retry_at=? WHERE id IN ('reviews.actor-revoked.v1','reviews.actor-permissions-changed.v1')",
            Date.now() + 60_000,
          ),
      );
      if (loss === 'role-loss') {
        await scope.changeMemberRole(owner, project.id, { subject: 'reviewer', role: 'reader' });
        await scope.changeMemberRole(owner, project.id, { subject: 'reviewer', role: 'reviewer' });
      } else {
        await scope.removeMember(owner, project.id, 'reviewer');
        await scope.addMember(owner, project.id, { subject: 'reviewer', role: 'reviewer' });
      }
      const restored = await scope.caller(reviewerUser, project.id);
      assert.equal(restored.actorId, reviewer.actorId);
      assert.notEqual(restored.human?.membershipId, reviewer.human?.membershipId);
      assert.equal((await scope.require(restored, 'review')).id, reviewer.actorId);
      await domainEvents.drain();
      assert.equal((await reviews.get(operator, claimed.id)).status, 'started');
      const head = await state.eventHead();
      const verdict = {
        reviewId: claimed.id,
        claimId: claimed.claimId!,
        verdict: 'pass' as const,
        notes: 'Checked every pinned criterion.',
        requestId: 'verdict',
        ...reviewedFindings(claimed),
      };
      for (const operation of [
        async () => await reviews.checkStart(restored, claimed.id),
        async () => await reviews.start(restored, claimed.id),
        async () => await reviews.checkSubmit(restored, claimed.id),
        async () => await reviews.submit(restored, verdict),
        async () => await tasks.context(restored, assignment),
        async () => await tasks.context(restored, { ...assignment, requestId: 'new-context' }),
        async () =>
          await tasks.checkpoint(restored, {
            ...assignment,
            requestId: 'checkpoint',
            notes: 'Work',
          }),
        async () => await tasks.submitReview(restored, { ...verdict, expectedRevision: 1 }),
        async () => await workflows.begin(restored, { instanceId: task.id, expectedRevision: 1 }),
      ]) {
        await assert.rejects(operation, { code: 'stale_claim' });
      }
      for (const action of ['begin', 'start_review', 'submit_review']) {
        const preflight = await workflows.evaluate(restored, task.id, {
          action,
          ...(action === 'submit_review' ? { input: { ...verdict, expectedRevision: 1 } } : {}),
        });
        assert.equal(preflight.currentGate, 'stale_claim');
        assert.equal(preflight.nextAction, null);
      }
      assert.equal(await state.eventHead(), head, 'Rejected operations append no events');
      assert.deepEqual(await reviews.get(operator, claimed.id), claimed);
      assert.equal((await workflows.get(operator, task.id)).revision, 1);

      // A fresh post-loss claim is valid even before the old claim is cleaned up.
      const independent = await reviews.request(operator, {
        subjectId: 'another-subject',
        subjectRevision: 0,
        producerId: operator.actorId,
        artifactIds: [proof.id],
        criteria: ['The result is reproducible.'],
        requestId: 'another-request',
      });
      const fresh = await reviews.start(restored, independent.id);
      assert.equal((await reviews.checkSubmit(restored, fresh.id)).claimId, fresh.claimId);
      await state.transaction(async (tx) => await tx.run('UPDATE event_consumers SET retry_at=0'));
      await domainEvents.drain();
      assert.equal((await reviews.get(operator, claimed.id)).status, 'requested');
      assert.equal((await reviews.get(operator, fresh.id)).claimId, fresh.claimId);
      const replacement = await reviews.start(restored, claimed.id);
      assert.notEqual(replacement.claimId, claimed.claimId);
      assert.equal(
        (
          await tasks.context(restored, {
            ...assignment,
            claimId: replacement.claimId!,
            requestId: 'fresh-context',
          })
        ).actorId,
        restored.actorId,
      );
      assert.equal(
        (
          await tasks.submitReview(restored, {
            ...verdict,
            claimId: replacement.claimId!,
            expectedRevision: 1,
          })
        ).workflow.state,
        'done',
        'Rejected verdicts leave their request IDs reusable after a fresh claim',
      );
    } finally {
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('claim admission sees permission loss in its transaction but ignores a rolled-back loss', async () => {
  const f = await fixture();
  try {
    const claimed = await f.reviews.start(f.reviewer, (await f.request()).id);
    await assert.rejects(
      async () =>
        await f.state.transaction(async (tx) => {
          await f.state.appendEvent(tx, {
            projectId: f.operator.projectId,
            actorId: f.operator.actorId,
            type: 'actor.revoked',
            subjectId: f.reviewer.actorId,
            data: {},
          });
          await assert.rejects(
            async () => await f.reviews.checkSubmit(f.reviewer, claimed.id, undefined, tx),
            {
              code: 'stale_claim',
            },
          );
          throw new Error('Rollback loss');
        }),
      /Rollback loss/,
    );
    assert.equal((await f.reviews.checkSubmit(f.reviewer, claimed.id)).claimId, claimed.claimId);
  } finally {
    await f.close();
  }
});
