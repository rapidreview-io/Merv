import { createService } from '@merv/contracts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { ReviewService } from '@merv/reviews';
import { digest, type ReviewInput, type ReviewRequest, type ReviewSubmit } from '@merv/contracts';
import { openState } from './fixtures/state.js';

async function fixture(schemaVersion = Infinity) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-findings-'));
  const state = await openState(directory);
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({
    projectName: 'Structured assessment',
    actorName: 'Operator',
  });
  const operator = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => ({
    actorId: (await scope.issueActor(operator, { name: role, role })).actor.id,
    projectId: operator.projectId,
  });
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reader = await issue('reader');
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const proof = await artifacts.create(producer, {
    title: 'Receipt',
    content: 'Two execution cases passed.',
  });
  const extra = await artifacts.create(producer, {
    title: 'Unsubmitted receipt',
    content: 'Not in the snapshot.',
  });
  const migrate = state.migrate.bind(state);
  state.migrate = async (component, migrations) =>
    await migrate(
      component,
      component === 'reviews'
        ? migrations.filter((migration) => migration.version <= schemaVersion)
        : migrations,
    );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  state.migrate = migrate;
  let sequence = 0;
  const input = (): ReviewInput => ({
    subjectId: `subject-${++sequence}`,
    subjectRevision: 2,
    producerId: producer.actorId,
    criteria: ['Adds positive inputs.', 'Handles negative inputs.'],
    artifactIds: [proof.id],
    formatVersion: 2,
    requestId: `request-${sequence}`,
  });
  const request = async () => await reviews.request(producer, input());
  const submit = (review: ReviewRequest): ReviewSubmit => ({
    reviewId: review.id,
    claimId: review.claimId!,
    verdict: 'pass',
    notes: 'Independent evidence inspection is complete.',
    synopsis: 'Both retained execution cases passed and the requested addition goal is achieved.',
    findings: [
      {
        criterionNumber: 2,
        status: 'met',
        evidenceIds: [proof.id],
        notes: ' Negative inputs produced the expected result. ',
      },
      {
        criterionNumber: 1,
        status: 'met',
        evidenceIds: [proof.id],
        notes: 'Positive inputs produced the expected result.',
      },
    ],
    evidence: {
      outcome: 'Adder validated independently.',
      metrics: { passing: 2, total: 2 },
      observations: ['positive', 'negative'],
      accepted: true,
    },
    requestId: `submit-${++sequence}`,
  });
  const durable = async () =>
    await state.read(async (sql) => ({
      reviews: await sql.all('SELECT * FROM reviews ORDER BY id'),
      commands: await sql.all('SELECT * FROM review_commands ORDER BY actor_id,request_id'),
      events: await state.events(operator.projectId),
    }));
  return {
    directory,
    state,
    scope,
    artifacts,
    reviews,
    operator,
    producer,
    reviewer,
    reader,
    proof,
    extra,
    issue,
    input,
    request,
    submit,
    durable,
    async close() {
      await state.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('structured reviews pin versioned evidence and retain canonical per-criterion findings for each verdict', async () => {
  const f = await fixture();
  try {
    for (const verdict of ['pass', 'needs_changes', 'fail'] as const) {
      const requested = await f.request();
      assert.equal(requested.formatVersion, 2);
      assert.deepEqual(requested.findings, []);
      assert.deepEqual(requested.evidence, {});
      assert.equal(requested.synopsis, null);
      const claimed = await f.reviews.start(f.reviewer, requested.id);
      const input = { ...f.submit(claimed), verdict };
      if (verdict !== 'pass') {
        input.findings![0].status = verdict === 'fail' ? 'not_met' : 'not_verified';
        input.findings![0].evidenceIds = [];
        input.findings![0].notes = 'The negative case cannot establish the required behavior.';
        input.synopsis =
          'The negative case is unresolved, so this delivery does not establish the overall goal.';
      }
      const before = await f.durable();
      assert.equal((await f.reviews.checkSubmit(f.reviewer, claimed.id, input)).status, 'started');
      assert.deepEqual(
        await f.durable(),
        before,
        'Preflight must not change claims, verdicts, commands or events',
      );
      const result = await f.reviews.submit(f.reviewer, input);
      assert.equal(result.verdict, verdict);
      assert.equal(result.snapshotHash, requested.snapshotHash);
      assert.equal(result.synopsis, input.synopsis);
      assert.deepEqual(result.evidence, input.evidence);
      assert.deepEqual(
        result.findings.map((finding) => finding.criterionNumber),
        [1, 2],
      );
      assert.deepEqual(
        result.findings.map((finding) => finding.notes),
        [...input.findings!]
          .sort((a, b) => a.criterionNumber - b.criterionNumber)
          .map((finding) => finding.notes.trim()),
      );
      assert.deepEqual(await f.reviews.get(f.reader, result.id), result);
      // A listing adds only whose move each review is; the stored review is unchanged.
      assert.deepEqual(
        (await f.reviews.list(f.reader)).find((review) => review.id === result.id),
        { ...result, claimable: false },
      );
      assert.equal((await f.state.events(f.operator.projectId)).at(-1)?.type, 'review.submitted');
    }
    for (const verdict of ['needs_changes', 'fail'] as const) {
      const claim = await f.reviews.start(f.reviewer, (await f.request()).id);
      const result = await f.reviews.submit(f.reviewer, {
        ...f.submit(claim),
        verdict,
        synopsis:
          'Each individual check passed, but the integrated program still fails the requested goal.',
      });
      assert.ok(
        result.findings.every((finding) => finding.status === 'met'),
        'Overall goal judgement is separate from per-check success',
      );
    }
  } finally {
    await f.close();
  }
});

test('structured review preflights reject incomplete, contradictory or unpinned findings without durable writes', async () => {
  const f = await fixture();
  try {
    const claimed = await f.reviews.start(f.reviewer, (await f.request()).id);
    const valid = f.submit(claimed);
    const finding = valid.findings![1];
    const wrong = [
      undefined,
      null,
      [],
      [finding],
      [finding, finding],
      [{ ...finding, criterionNumber: 0 }, valid.findings![0]],
      [{ ...finding, criterionNumber: 3 }, valid.findings![0]],
      [{ ...finding, criterionNumber: 1.5 }, valid.findings![0]],
      [{ ...finding, status: 'unknown' }, valid.findings![0]],
      [{ ...finding, evidenceIds: [] }, valid.findings![0]],
      [{ ...finding, evidenceIds: [f.extra.id] }, valid.findings![0]],
      [{ ...finding, evidenceIds: [f.proof.id, f.proof.id] }, valid.findings![0]],
      [{ ...finding, evidenceIds: [42] }, valid.findings![0]],
      [{ ...finding, evidenceIds: 'not-an-array' }, valid.findings![0]],
      [{ ...finding, notes: ' ' }, valid.findings![0]],
      [{ ...finding, notes: 'x'.repeat(16001) }, valid.findings![0]],
      [{ ...finding, unknown: true }, valid.findings![0]],
      [{ ...finding, status: 'not_met', evidenceIds: [] }, valid.findings![0]],
      [{ ...finding, status: 'not_verified', evidenceIds: [] }, valid.findings![0]],
    ];
    const before = await f.durable();
    for (const findings of wrong) {
      const input = { ...valid, findings } as ReviewSubmit;
      await assert.rejects(async () => await f.reviews.checkSubmit(f.reviewer, claimed.id, input), {
        code: 'invalid_findings',
      });
      await assert.rejects(async () => await f.reviews.submit(f.reviewer, input), {
        code: 'invalid_findings',
      });
      assert.deepEqual(await f.durable(), before);
    }
    const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
    const foreign = await f.artifacts.create(
      { actorId: other.actor.id, projectId: other.project.id },
      { title: 'Foreign', content: 'Not authorized.' },
    );
    await assert.rejects(
      async () =>
        await f.reviews.submit(f.reviewer, {
          ...valid,
          findings: [{ ...finding, evidenceIds: [foreign.id] }, valid.findings![0]],
        }),
      { code: 'invalid_findings' },
    );
    assert.deepEqual(await f.durable(), before);
  } finally {
    await f.close();
  }
});

test('synopses must be bounded plain prose and generic review observations must be finite bounded JSON', async () => {
  const f = await fixture();
  try {
    const claimed = await f.reviews.start(f.reviewer, (await f.request()).id);
    const valid = f.submit(claimed),
      before = await f.durable();
    for (const synopsis of [
      'The retained result art_abc establishes the requested arithmetic behavior.',
      'The completed task_abc establishes the requested arithmetic behavior.',
      'The completed wf_abc establishes the requested arithmetic behavior.',
      undefined,
      null,
      5,
      ' '.repeat(40),
      'x'.repeat(39),
      'x'.repeat(421),
      `valid words ${'x'.repeat(40)}\nsecond line`,
      `# ${'x'.repeat(40)}`,
      `Use \`code\` ${'x'.repeat(40)}`,
      `new\u2028line ${'x'.repeat(40)}`,
      `**The note** names the learning rate but cites no source ${'x'.repeat(20)}`,
      `- a bullet that ${'x'.repeat(40)}`,
      `1. a numbered item that ${'x'.repeat(40)}`,
      `see [the plan](art_1) for ${'x'.repeat(40)}`,
    ]) {
      const input = { ...valid, synopsis } as ReviewSubmit;
      await assert.rejects(async () => await f.reviews.checkSubmit(f.reviewer, claimed.id, input), {
        code: 'invalid_synopsis',
      });
      await assert.rejects(async () => await f.reviews.submit(f.reviewer, input), {
        code: 'invalid_synopsis',
      });
      assert.deepEqual(await f.durable(), before);
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let deep: unknown = {};
    for (let index = 0; index < 34; index++) deep = { next: deep };
    for (const evidence of [
      null,
      [],
      'text',
      { value: undefined },
      { value: NaN },
      { value: Infinity },
      { value: 2n },
      { value: () => 1 },
      { value: new Date() },
      circular,
      deep,
      { value: 'x'.repeat(64000) },
      { outcome: '' },
      { outcome: 5 },
      { value: [undefined] },
      { value: new Array(3) },
      { [Symbol('secret')]: true },
    ]) {
      const input = { ...valid, evidence } as ReviewSubmit;
      await assert.rejects(async () => await f.reviews.checkSubmit(f.reviewer, claimed.id, input), {
        code: 'invalid_evidence',
      });
      await assert.rejects(async () => await f.reviews.submit(f.reviewer, input), {
        code: 'invalid_evidence',
      });
      assert.deepEqual(await f.durable(), before);
    }
    const accepted = await f.reviews.submit(f.reviewer, {
      ...valid,
      synopsis: `  ${'a'.repeat(40)}  `,
      evidence: { nested: [{ valid: null }, false, 3.25] },
    });
    assert.equal(accepted.synopsis, 'a'.repeat(40));
    assert.deepEqual(accepted.evidence, { nested: [{ valid: null }, false, 3.25] });
  } finally {
    await f.close();
  }
});

test('structured verdicts replay exact inputs, forbid later mutation, and survive reopening', async () => {
  const f = await fixture();
  try {
    const claim = await f.reviews.start(f.reviewer, (await f.request()).id),
      input = f.submit(claim);
    const result = await f.reviews.submit(f.reviewer, input),
      before = await f.durable();
    assert.deepEqual(await f.reviews.submit(f.reviewer, input), result);
    assert.deepEqual(await f.durable(), before);
    for (const changed of [
      { ...input, evidence: { ...input.evidence, changed: true } },
      { ...input, synopsis: `${input.synopsis} Changed.` },
      { ...input, findings: [...input.findings!].reverse() },
    ])
      await assert.rejects(async () => await f.reviews.submit(f.reviewer, changed), {
        code: 'request_conflict',
      });
    for (const [column, value] of [
      ['synopsis', 'Changed.'],
      ['findings_json', '[]'],
      ['evidence_json', '{}'],
      ['format_version', 1],
    ] as const) {
      await assert.rejects(
        async () =>
          await f.state.transaction(
            async (tx) =>
              await tx.run(`UPDATE reviews SET ${column}=? WHERE id=?`, value, result.id),
          ),
        { code: 'state_constraint' },
      );
    }
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) => await tx.run('DELETE FROM reviews WHERE id=?', result.id),
        ),
      { code: 'state_constraint' },
    );
    assert.deepEqual(await f.durable(), before);
    await f.state.close();
    const state = await openState(f.directory);
    try {
      const scope = await createService(new ProjectScope(state)),
        artifacts = await createService(
          new ArtifactStore(state, scope, new DiskBlobs(join(f.directory, 'blobs'))),
        );
      const reviews = await createService(new ReviewService(state, scope, artifacts));
      assert.deepEqual(await reviews.get(f.reader, result.id), result);
      assert.deepEqual(await reviews.submit(f.reviewer, input), result);
    } finally {
      await state.close();
    }
  } finally {
    await f.close();
  }
});

test('late review failures roll back findings, verdict, command receipt and event with the owning transaction', async () => {
  const f = await fixture();
  try {
    const claim = await f.reviews.start(f.reviewer, (await f.request()).id),
      input = f.submit(claim),
      before = await f.durable();
    await assert.rejects(
      async () =>
        await f.state.transaction(async (tx) => {
          await f.reviews.submit(f.reviewer, input, tx);
          throw new Error('Owner transition failed after review submission');
        }),
      /Owner transition failed/,
    );
    assert.deepEqual(await f.durable(), before);
    const append = f.state.appendEvent;
    f.state.appendEvent = function (tx, event) {
      const result = append.call(this, tx, event);
      if (event.type === 'review.submitted') throw new Error('After append failure');
      return result;
    };
    try {
      await assert.rejects(
        async () => await f.reviews.submit(f.reviewer, input),
        /After append failure/,
      );
    } finally {
      f.state.appendEvent = append;
    }
    assert.deepEqual(await f.durable(), before);
    assert.equal((await f.reviews.submit(f.reviewer, input)).status, 'submitted');
  } finally {
    await f.close();
  }
});

test('revoking a reviewer preserves the v2 snapshot while replacement claims fence stale structured submissions', async () => {
  const f = await fixture();
  try {
    const requested = await f.request(),
      oldClaim = await f.reviews.start(f.reviewer, requested.id),
      oldInput = f.submit(oldClaim);
    const replacement = await f.issue('reviewer');
    await f.scope.revokeActor(f.operator, f.reviewer.actorId);
    const event = (await f.state.events(f.operator.projectId)).findLast(
      (item) => item.type === 'actor.revoked',
    )!;
    await f.state.transaction(async (tx) => await f.reviews.actorRevoked(event, tx));
    const recovered = await f.reviews.get(replacement, requested.id);
    assert.equal(recovered.formatVersion, 2);
    assert.equal(recovered.snapshotHash, requested.snapshotHash);
    assert.deepEqual(recovered.findings, []);
    assert.equal(recovered.synopsis, null);
    assert.equal(recovered.recovery?.previousClaimId, oldClaim.claimId);
    const claim = await f.reviews.start(replacement, requested.id),
      before = await f.durable();
    await assert.rejects(async () => await f.reviews.submit(f.reviewer, oldInput), {
      code: 'forbidden',
    });
    await assert.rejects(async () => await f.reviews.submit(replacement, oldInput), {
      code: 'stale_claim',
    });
    assert.deepEqual(await f.durable(), before);
    const submitted = await f.reviews.submit(replacement, {
      ...oldInput,
      claimId: claim.claimId!,
      requestId: 'replacement',
    });
    assert.equal(submitted.claimGeneration, 2);
    assert.equal(submitted.reviewerId, replacement.actorId);
    assert.equal(submitted.verdict, 'pass');
  } finally {
    await f.close();
  }
});

test('a request that omits formatVersion is format 2, pinned in its snapshot, and no other format is accepted', async () => {
  const f = await fixture();
  try {
    const input = f.input();
    delete input.formatVersion;
    const omitted = await f.reviews.request(f.producer, input);
    const explicit = await f.reviews.request(f.producer, {
      ...input,
      formatVersion: 2,
      requestId: 'explicit-2',
    });
    const snapshot = {
      subjectId: input.subjectId,
      subjectRevision: input.subjectRevision,
      producerId: input.producerId,
      criteria: input.criteria,
      manifest: [f.proof],
    };
    assert.equal(omitted.formatVersion, 2);
    assert.equal(omitted.snapshotHash, digest({ ...snapshot, formatVersion: 2 }));
    assert.equal(explicit.snapshotHash, omitted.snapshotHash);
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) => await tx.run('UPDATE reviews SET format_version=1 WHERE id=?', omitted.id),
        ),
      { code: 'state_constraint' },
    );
    const before = await f.durable();
    for (const formatVersion of [null, 0, 1, 3, '2']) {
      await assert.rejects(
        async () =>
          await f.reviews.request(f.producer, {
            ...input,
            formatVersion,
            requestId: 'bad-format',
          } as ReviewInput),
        { code: 'invalid_review_format' },
      );
      assert.deepEqual(await f.durable(), before);
    }
    // Omission never meant an optional assessment: the synopsis and findings are required.
    const claim = await f.reviews.start(f.reviewer, omitted.id),
      complete = f.submit(claim);
    for (const [incomplete, code] of [
      [{ ...complete, findings: undefined }, 'invalid_findings'],
      [{ ...complete, synopsis: undefined }, 'invalid_synopsis'],
    ] as const)
      await assert.rejects(async () => await f.reviews.submit(f.reviewer, incomplete), { code });
    assert.equal((await f.reviews.submit(f.reviewer, complete)).findings.length, 2);
  } finally {
    await f.close();
  }
});

test('retiring format 1 deletes a format 1 review on a retired subject and refuses to start past any other', async () => {
  for (const retired of [true, false]) {
    const f = await fixture(9);
    try {
      // No current request can write format 1: it was the default when the field was omitted.
      await f.state.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO reviews(id,project_id,subject_id,subject_revision,producer_id,artifact_ids,criteria,manifest,snapshot_hash,status,created_at,format_version)
           VALUES('format-1',?,'retired-subject',2,?,?,?,?,'hash','requested','2026-01-01T00:00:00.000Z',1)`,
          f.producer.projectId,
          f.producer.actorId,
          JSON.stringify([f.proof.id]),
          JSON.stringify(['Correct.']),
          JSON.stringify([f.proof]),
        );
        if (retired) {
          await tx.run(
            `CREATE TABLE wf_retired_instances (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow TEXT NOT NULL,
              version BIGINT NOT NULL, reason TEXT NOT NULL)`,
          );
          await tx.run(
            "INSERT INTO wf_retired_instances VALUES('retired-subject',?,'task',1,'retired_version')",
            f.producer.projectId,
          );
        }
      });
      const formatOne = async () =>
        await f.state.read(
          async (sql) => await sql.all("SELECT id FROM reviews WHERE id='format-1'"),
        );
      const opening = createService(new ReviewService(f.state, f.scope, f.artifacts));
      if (retired) {
        (await opening).close();
        assert.deepEqual(await formatOne(), []);
      } else {
        await assert.rejects(opening, { code: 'state_constraint' });
        assert.equal((await formatOne()).length, 1);
      }
    } finally {
      await f.close();
    }
  }
});

for (const shape of [
  'array getter',
  'array serializer',
  'array prototype',
  'nested proxy',
  'revoked proxy',
  'field getter',
] as const) {
  test(`review evidence refuses ${shape} without executing caller code`, async () => {
    const f = await fixture();
    try {
      const claim = await f.reviews.start(f.reviewer, (await f.request()).id);
      const valid = f.submit(claim);
      let effects = 0;
      let values: unknown = [1];
      if (shape === 'array getter') {
        values = Object.defineProperty([1], '0', {
          enumerable: true,
          get() {
            effects++;
            return effects === 1 ? 1 : NaN;
          },
        });
      } else if (shape === 'array serializer') {
        values = Object.defineProperty([1], 'toJSON', {
          value() {
            effects++;
            return { injected: 'not the validated evidence' };
          },
        });
      } else if (shape === 'array prototype') {
        const prototype = Object.create(Array.prototype);
        prototype[Symbol.iterator] = function* () {
          effects++;
          yield 1;
        };
        values = Object.setPrototypeOf([1], prototype);
      } else if (shape === 'nested proxy') {
        values = new Proxy(
          { score: 1 },
          {
            getPrototypeOf(target) {
              effects++;
              return Reflect.getPrototypeOf(target);
            },
            get(target, property, receiver) {
              effects++;
              return Reflect.get(target, property, receiver);
            },
          },
        );
      } else if (shape === 'revoked proxy') {
        const revoked = Proxy.revocable({ score: 1 }, {});
        revoked.revoke();
        values = revoked.proxy;
      }
      const input = { ...valid, evidence: { values } } as ReviewSubmit;
      if (shape === 'field getter')
        Object.defineProperty(input, 'evidence', {
          enumerable: true,
          get() {
            effects++;
            return { score: 1 };
          },
        });
      const before = await f.durable();
      await assert.rejects(f.reviews.checkSubmit(f.reviewer, claim.id, input), {
        code: 'invalid_evidence',
      });
      assert.equal(effects, 0);
      await assert.rejects(f.reviews.submit(f.reviewer, input), { code: 'invalid_evidence' });
      assert.equal(effects, 0);
      assert.deepEqual(await f.durable(), before);
      assert.equal((await f.reviews.submit(f.reviewer, valid)).status, 'submitted');
    } finally {
      await f.close();
    }
  });
}

test('review evidence keeps its exact encoded byte limit after safe copying', async () => {
  const f = await fixture();
  try {
    const claim = await f.reviews.start(f.reviewer, (await f.request()).id);
    const input = f.submit(claim);
    const room = 64000 - Buffer.byteLength(JSON.stringify({ value: '' }));
    const evidence = { value: 'x'.repeat(room) };
    await f.reviews.checkSubmit(f.reviewer, claim.id, { ...input, evidence });
    await assert.rejects(
      f.reviews.submit(f.reviewer, { ...input, evidence: { value: `${evidence.value}x` } }),
      { code: 'invalid_evidence' },
    );
    assert.deepEqual(
      (await f.reviews.submit(f.reviewer, { ...input, evidence })).evidence,
      evidence,
    );
  } finally {
    await f.close();
  }
});

test('required criteria are immutable sorted provenance in the snapshot, returned on reads and carried across reissue', async () => {
  const f = await fixture();
  try {
    const input = { ...f.input(), requiredCriteria: [2, 1] };
    const review = await f.reviews.request(f.producer, input);
    assert.deepEqual(review.requiredCriteria, [1, 2]);
    assert.equal(
      review.snapshotHash,
      digest({
        subjectId: input.subjectId,
        subjectRevision: input.subjectRevision,
        producerId: input.producerId,
        criteria: input.criteria,
        manifest: [f.proof],
        formatVersion: 2,
        requiredCriteria: [1, 2],
      }),
    );
    assert.deepEqual(
      await f.reviews.request(f.producer, { ...input, requiredCriteria: [1, 2] }),
      review,
      'Order does not change the pinned review or its replay',
    );
    const without = await f.reviews.request(f.producer, {
      ...input,
      requiredCriteria: undefined,
      requestId: 'without-required',
    });
    assert.equal('requiredCriteria' in without, false);
    assert.notEqual(without.snapshotHash, review.snapshotHash);
    assert.deepEqual(await f.reviews.get(f.reader, review.id), review);
    assert.deepEqual(
      (await f.reviews.list(f.reader)).find((item) => item.id === review.id)?.requiredCriteria,
      [1, 2],
    );
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) =>
            await tx.run('UPDATE reviews SET required_criteria=? WHERE id=?', '[1]', review.id),
        ),
      { code: 'state_constraint' },
    );
    const reissued = await f.reviews.reissue(f.producer, {
      reviewId: review.id,
      subjectRevision: 3,
      requestId: 'reissue-required',
    });
    assert.notEqual(reissued.id, review.id);
    assert.deepEqual(reissued.requiredCriteria, [1, 2]);
  } finally {
    await f.close();
  }
});

test('required criteria must be distinct numbers of the review criteria, supplied as ordinary data', async () => {
  const f = await fixture();
  try {
    const before = await f.durable();
    const accessor = f.input();
    Object.defineProperty(accessor, 'requiredCriteria', { enumerable: true, get: () => [1] });
    for (const input of [
      { ...f.input(), requiredCriteria: [] },
      { ...f.input(), requiredCriteria: [1, 1] },
      { ...f.input(), requiredCriteria: [3] },
      { ...f.input(), requiredCriteria: [0] },
      { ...f.input(), requiredCriteria: [1.5] },
      { ...f.input(), requiredCriteria: ['1'] as unknown as number[] },
      { ...f.input(), requiredCriteria: 1 as unknown as number[] },
      accessor,
    ])
      await assert.rejects(f.reviews.request(f.producer, input), {
        code: 'invalid_required_criteria',
      });
    assert.deepEqual(await f.durable(), before);
  } finally {
    await f.close();
  }
});

test('a pass can waive an ordinary criterion but never a required one, in preflight and in the commit', async () => {
  const f = await fixture();
  try {
    const request = async () =>
      await f.reviews.start(
        f.reviewer,
        (await f.reviews.request(f.producer, { ...f.input(), requiredCriteria: [2] })).id,
      );
    const finding = (input: ReviewSubmit, status: 'waived' | 'not_verified', number: number) => {
      const item = input.findings!.find((entry) => entry.criterionNumber === number)!;
      item.status = status;
      item.evidenceIds = [];
      item.notes = 'The reviewer did not establish this criterion.';
      return input;
    };

    const claimed = await request();
    const waived = finding(f.submit(claimed), 'waived', 2);
    const before = await f.durable();
    await assert.rejects(f.reviews.checkSubmit(f.reviewer, claimed.id, waived), {
      code: 'criterion_not_waivable',
      message: /Criterion 2 is required/,
    });
    await assert.rejects(f.reviews.submit(f.reviewer, waived), {
      code: 'criterion_not_waivable',
    });
    assert.deepEqual(await f.durable(), before, 'A refused pass leaves no verdict behind');
    await assert.rejects(
      f.reviews.submit(f.reviewer, finding(f.submit(claimed), 'not_verified', 2)),
      { code: 'invalid_findings' },
    );
    // The same review still passes when the waived criterion is the ordinary one.
    const passed = await f.reviews.submit(f.reviewer, finding(f.submit(claimed), 'waived', 1));
    assert.equal(passed.verdict, 'pass');
    assert.equal(passed.findings[1].status, 'met');

    const returned = await request();
    const result = await f.reviews.submit(f.reviewer, {
      ...finding(f.submit(returned), 'waived', 2),
      verdict: 'needs_changes',
      synopsis:
        'The required negative case was not established, so the delivery returns for changes.',
    });
    assert.equal(result.verdict, 'needs_changes');
  } finally {
    await f.close();
  }
});
