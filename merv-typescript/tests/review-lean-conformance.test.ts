import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createService, digest } from '@merv/contracts';
import type { Caller, ReviewRequest, StoredEvent, Transaction } from '@merv/contracts';
import { PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { ReviewService } from '@merv/reviews';
import { openState } from './fixtures/state.js';
import { assessment } from './fixtures/review-verdict.js';

type ModelCommand =
  | {
      kind: 'start';
      actor: string;
      claimId: string;
      eventId: number;
      permitted: boolean;
      independent: boolean;
      live: boolean;
    }
  | {
      kind: 'submit';
      actor: string;
      claimId: string;
      verdict: string;
      permitted: boolean;
      independent: boolean;
      live: boolean;
    }
  | { kind: 'revoke'; actor: string; eventId: number }
  | { kind: 'release'; actor: string; claimId: string };
type Observation = {
  outcome: string;
  status: string;
  generation: number;
  reviewer: string | null;
  claimId: string | null;
  verdict: string | null;
  pinned: string;
};

const modelDir = resolve(dirname(fileURLToPath(import.meta.url)), '../verification/lean');
const modelBinary = resolve(modelDir, '.lake/build/bin/review_claim_model');
const modelAvailable = existsSync(modelBinary);

function modelObservations(pinned: string, commands: ModelCommand[]): Observation[] {
  const result = spawnSync(modelBinary, [], {
    cwd: modelDir,
    input: JSON.stringify({ pinned, commands }),
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return (JSON.parse(result.stdout) as { observations: Observation[] }).observations;
}

test(
  'review claims agree with the Lean model across release, delayed revocation, reclaim, and submit',
  {
    skip:
      !modelAvailable && process.env.MERV_REQUIRE_LEAN !== '1'
        ? 'Build the Lean review claim model to run conformance'
        : undefined,
  },
  async (t) => {
    assert.ok(modelAvailable, `Lean review claim model is missing: ${modelBinary}`);
    const directory = mkdtempSync(join(tmpdir(), 'merv-review-lean-'));
    const state: PostgresState = await openState(directory);
    try {
      const scope = await createService(new ProjectScope(state));
      const boot = await scope.bootstrap({
        projectName: 'Lean claim conformance',
        actorName: 'Operator',
      });
      const operator: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
      const issue = async (name: string, role: 'producer' | 'reviewer'): Promise<Caller> => ({
        projectId: operator.projectId,
        actorId: (await scope.issueActor(operator, { name, role })).actor.id,
      });
      const producer = await issue('Producer', 'producer');
      const contributor = await issue('Contributor', 'producer');
      const reviewer = await issue('Reviewer', 'reviewer');
      const artifacts = await createService(
        new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
      );
      const artifact = await artifacts.create(producer, {
        title: 'Output',
        content: 'Retained evidence.',
      });
      const reviews = await createService(new ReviewService(state, scope, artifacts));
      const certificateBody = {
        formatVersion: 1 as const,
        provider: 'fixture',
        reference: 'subject',
        sourceHash: digest(artifact),
        excludedActorIds: [contributor.actorId],
      };
      reviews.provenance('fixture').register(async () => ({
        ...certificateBody,
        hash: digest(certificateBody),
      }));
      const requested = await reviews.request(producer, {
        subjectId: 'subject',
        subjectRevision: 3,
        producerId: producer.actorId,
        artifactIds: [artifact.id],
        criteria: ['The retained output satisfies the criterion.'],
        provenanceOwner: 'fixture',
        requestId: 'review-request',
      });
      let directing = operator;
      t.mock.method(scope, 'authorityActor', async (_caller: Caller, tx?: Transaction) =>
        scope.require(directing, 'read', tx),
      );
      const commands: ModelCommand[] = [];
      const actual: Observation[] = [];
      const capture = async (command: ModelCommand, outcome: string) => {
        const row = await reviews.get(operator, requested.id);
        assert.equal(row.snapshotHash, requested.snapshotHash);
        assert.equal(row.subjectRevision, requested.subjectRevision);
        assert.deepEqual(row.artifactIds, requested.artifactIds);
        assert.deepEqual(row.criteria, requested.criteria);
        assert.deepEqual(row.provenance, requested.provenance);
        commands.push(command);
        actual.push({
          outcome,
          status: row.status,
          generation: row.claimGeneration,
          reviewer: row.reviewerId,
          claimId: row.claimId,
          verdict: row.verdict,
          pinned: row.snapshotHash,
        });
      };
      const startedAt = async (claim: ReviewRequest) => {
        const event = (await state.events(operator.projectId)).find(
          (item) =>
            item.type === 'review.started' &&
            item.subjectId === requested.id &&
            item.data.claimId === claim.claimId,
        );
        assert.ok(event, 'claim start event is retained');
        return event.id;
      };
      const submit = async (claimId: string, requestId: string) =>
        await reviews.submit(reviewer, {
          reviewId: requested.id,
          claimId,
          verdict: 'pass',
          notes: 'I checked the retained output against the criterion.',
          ...assessment(requested),
          requestId,
        });
      const revokeEvent = async (): Promise<StoredEvent> =>
        await state.transaction(
          async (tx) =>
            await state.appendEvent(tx, {
              projectId: operator.projectId,
              actorId: operator.actorId,
              type: 'actor.revoked',
              subjectId: reviewer.actorId,
              data: { membershipId: 'old-membership' },
            }),
        );
      const release = async (claimId: string) =>
        await state.transaction(
          async (tx) =>
            await reviews.releaseClaim(
              {
                projectId: operator.projectId,
                reviewId: requested.id,
                claimId,
                actorId: reviewer.actorId,
                reason: 'fixture_release',
              },
              tx,
            ),
        );

      directing = contributor;
      await assert.rejects(reviews.start(reviewer, requested.id), { code: 'review_independence' });
      await capture(
        {
          kind: 'start',
          actor: reviewer.actorId,
          claimId: 'unused',
          eventId: 0,
          permitted: true,
          independent: false,
          live: true,
        },
        'independence',
      );
      directing = operator;
      const first = await reviews.start(reviewer, requested.id);
      await capture(
        {
          kind: 'start',
          actor: reviewer.actorId,
          claimId: first.claimId!,
          eventId: await startedAt(first),
          permitted: true,
          independent: true,
          live: true,
        },
        'claimed',
      );
      assert.deepEqual(await reviews.start(reviewer, requested.id), first);
      await capture(
        {
          kind: 'start',
          actor: reviewer.actorId,
          claimId: 'unused',
          eventId: 0,
          permitted: true,
          independent: true,
          live: true,
        },
        'existing',
      );
      await release('wrong-claim');
      await capture(
        { kind: 'release', actor: reviewer.actorId, claimId: 'wrong-claim' },
        'unchanged',
      );

      const oldLoss = await revokeEvent();
      await assert.rejects(submit(first.claimId!, 'loss-blocked'), { code: 'stale_claim' });
      await capture(
        {
          kind: 'submit',
          actor: reviewer.actorId,
          claimId: first.claimId!,
          verdict: 'pass',
          permitted: true,
          independent: true,
          live: false,
        },
        'stale_claim',
      );
      await release(first.claimId!);
      await capture(
        { kind: 'release', actor: reviewer.actorId, claimId: first.claimId! },
        'released',
      );
      const second = await reviews.start(reviewer, requested.id);
      await capture(
        {
          kind: 'start',
          actor: reviewer.actorId,
          claimId: second.claimId!,
          eventId: await startedAt(second),
          permitted: true,
          independent: true,
          live: true,
        },
        'claimed',
      );
      await state.transaction(async (tx) => await reviews.actorRevoked(oldLoss, tx));
      await capture({ kind: 'revoke', actor: reviewer.actorId, eventId: oldLoss.id }, 'unchanged');

      const laterLoss = await revokeEvent();
      await state.transaction(async (tx) => await reviews.actorRevoked(laterLoss, tx));
      await capture({ kind: 'revoke', actor: reviewer.actorId, eventId: laterLoss.id }, 'released');
      const third = await reviews.start(reviewer, requested.id);
      await capture(
        {
          kind: 'start',
          actor: reviewer.actorId,
          claimId: third.claimId!,
          eventId: await startedAt(third),
          permitted: true,
          independent: true,
          live: true,
        },
        'claimed',
      );
      await assert.rejects(submit(second.claimId!, 'stale-token'), { code: 'stale_claim' });
      await capture(
        {
          kind: 'submit',
          actor: reviewer.actorId,
          claimId: second.claimId!,
          verdict: 'pass',
          permitted: true,
          independent: true,
          live: true,
        },
        'stale_claim',
      );
      directing = contributor;
      await assert.rejects(submit(third.claimId!, 'changed-authority'), {
        code: 'review_independence',
      });
      await capture(
        {
          kind: 'submit',
          actor: reviewer.actorId,
          claimId: third.claimId!,
          verdict: 'pass',
          permitted: true,
          independent: false,
          live: true,
        },
        'independence',
      );
      directing = operator;
      const submitted = await submit(third.claimId!, 'final-verdict');
      await capture(
        {
          kind: 'submit',
          actor: reviewer.actorId,
          claimId: third.claimId!,
          verdict: 'pass',
          permitted: true,
          independent: true,
          live: true,
        },
        'submitted',
      );
      await state.transaction(async (tx) => await reviews.actorRevoked(laterLoss, tx));
      await capture(
        { kind: 'revoke', actor: reviewer.actorId, eventId: laterLoss.id },
        'unchanged',
      );
      await assert.rejects(reviews.supersede(operator, requested.id), { code: 'review_closed' });
      assert.deepEqual(await reviews.get(operator, requested.id), submitted);

      const expected = modelObservations(requested.snapshotHash, commands);
      assert.equal(expected.length, actual.length);
      actual.forEach((item, index) =>
        assert.deepEqual(
          item,
          expected[index],
          `claim step ${index}: ${JSON.stringify(commands[index])}`,
        ),
      );
    } finally {
      await state.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
