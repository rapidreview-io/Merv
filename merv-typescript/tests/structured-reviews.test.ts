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
import { digest, type ReviewInput, type ReviewRequest, type ReviewSubmit } from '@merv/contracts';

async function fixture(schemaVersion = Infinity) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-review-findings-'));
  const state = new SqliteState(join(directory, 'state.db'));
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
  const input = (formatVersion: 1 | 2 = 2): ReviewInput => ({
    subjectId: `subject-${++sequence}`,
    subjectRevision: 2,
    producerId: producer.actorId,
    criteria: ['Adds positive inputs.', 'Handles negative inputs.'],
    artifactIds: [proof.id],
    formatVersion,
    requestId: `request-${sequence}`,
  });
  const request = async (formatVersion: 1 | 2 = 2) =>
    await reviews.request(producer, input(formatVersion));
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
        /immutable/,
      );
    }
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) => await tx.run('DELETE FROM reviews WHERE id=?', result.id),
        ),
      /durable/,
    );
    assert.deepEqual(await f.durable(), before);
    await f.state.close();
    const state = new SqliteState(join(f.directory, 'state.db'));
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

test('legacy review requests keep their snapshot hashes and optional assessment fields, while v2 is explicit and immutable', async () => {
  const f = await fixture();
  try {
    const input = f.input(1);
    delete input.formatVersion;
    const legacy = await f.reviews.request(f.producer, input);
    const explicit = await f.reviews.request(f.producer, {
      ...input,
      formatVersion: 1,
      requestId: 'explicit-1',
    });
    const structured = await f.reviews.request(f.producer, {
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
    assert.equal(legacy.snapshotHash, digest(snapshot));
    assert.equal(explicit.snapshotHash, legacy.snapshotHash);
    assert.equal(structured.snapshotHash, digest({ ...snapshot, formatVersion: 2 }));
    assert.notEqual(structured.snapshotHash, legacy.snapshotHash);
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) =>
            await tx.run('UPDATE reviews SET format_version=1 WHERE id=?', structured.id),
        ),
      /immutable/,
    );
    const before = await f.durable();
    for (const formatVersion of [null, 0, 3, '2']) {
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
    const claim = await f.reviews.start(f.reviewer, legacy.id);
    const result = await f.reviews.submit(f.reviewer, {
      reviewId: claim.id,
      claimId: claim.claimId!,
      verdict: 'pass',
      notes: 'Legacy assessment.',
      requestId: 'legacy-submit',
    });
    assert.equal(result.formatVersion, 1);
    assert.equal(result.synopsis, null);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.evidence, {});
    const optionalClaim = await f.reviews.start(f.reviewer, explicit.id),
      optionalInput = f.submit(optionalClaim);
    await assert.rejects(
      async () => await f.reviews.submit(f.reviewer, { ...optionalInput, findings: [] }),
      {
        code: 'invalid_findings',
      },
    );
    await assert.rejects(
      async () => await f.reviews.submit(f.reviewer, { ...optionalInput, synopsis: 'Short.' }),
      {
        code: 'invalid_synopsis',
      },
    );
    assert.equal((await f.reviews.submit(f.reviewer, optionalInput)).findings.length, 2);
  } finally {
    await f.close();
  }
});

test('a real pre-v4 database gains format defaults without rewriting immutable submitted records or legacy receipts', async () => {
  const f = await fixture(3);
  try {
    const input = f.input(1);
    delete input.formatVersion;
    const snapshotHash = digest({
      subjectId: input.subjectId,
      subjectRevision: input.subjectRevision,
      producerId: input.producerId,
      criteria: input.criteria,
      manifest: [f.proof],
    });
    const createdAt = '2026-01-01T00:00:00.000Z';
    const ids = ['legacy-requested', 'legacy-started', 'legacy-submitted'];
    const oldResults = ids.map((id, index) => ({
      id,
      projectId: f.producer.projectId,
      subjectId: input.subjectId,
      subjectRevision: input.subjectRevision,
      producerId: f.producer.actorId,
      artifactIds: input.artifactIds,
      criteria: input.criteria,
      snapshotHash,
      status: ['requested', 'started', 'submitted'][index],
      reviewerId: index > 0 ? f.reviewer.actorId : null,
      claimId: index > 0 ? `claim-${id}` : null,
      claimGeneration: index > 0 ? 1 : 0,
      recovery: null,
      verdict: index === 2 ? 'pass' : null,
      notes: index === 2 ? 'Historical review.' : null,
      createdAt,
    }));
    await f.state.transaction(async (tx) => {
      for (const row of oldResults) {
        await tx.run(
          `INSERT INTO reviews(id,project_id,subject_id,subject_revision,producer_id,artifact_ids,criteria,manifest,snapshot_hash,status,reviewer_id,claim_id,claim_generation,verdict,notes,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          row.id,
          row.projectId,
          row.subjectId,
          row.subjectRevision,
          row.producerId,
          JSON.stringify(row.artifactIds),
          JSON.stringify(row.criteria),
          JSON.stringify([f.proof]),
          row.snapshotHash,
          row.status,
          row.reviewerId,
          row.claimId,
          row.claimGeneration,
          row.verdict,
          row.notes,
          row.createdAt,
        );
      }
      await tx.run(
        'INSERT INTO review_commands VALUES(?,?,?,?,?,?)',
        f.producer.projectId,
        f.producer.actorId,
        input.requestId,
        'request',
        digest(input),
        JSON.stringify(oldResults[0]),
      );
    });
    const oldRows = await f.state.read(
      async (sql) => await sql.all('SELECT * FROM reviews ORDER BY id'),
    );
    const oldCommands = await f.state.read(
      async (sql) => await sql.all('SELECT * FROM review_commands'),
    );
    const reviews = await createService(new ReviewService(f.state, f.scope, f.artifacts));
    const records = await reviews.list(f.reader);
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.equal(record.formatVersion, 1);
      assert.equal(record.synopsis, null);
      assert.deepEqual(record.findings, []);
      assert.deepEqual(record.evidence, {});
      assert.equal(record.administrativeActorId, f.producer.actorId);
      assert.deepEqual(record.pinnedInputIds, []);
      assert.equal(record.snapshotHash, snapshotHash);
    }
    const after = await f.state.read(
      async (sql) => await sql.all('SELECT * FROM reviews ORDER BY id'),
    );
    assert.deepEqual(
      after.map(
        ({
          format_version: _format,
          synopsis: _synopsis,
          findings_json: _findings,
          evidence_json: _evidence,
          administrative_actor_id: administrator,
          pinned_input_ids: inputs,
          return_to: returnTo,
          excluded_actor_ids: exclusions,
          ...row
        }) => {
          assert.equal(administrator, null);
          assert.equal(inputs, '[]');
          assert.equal(returnTo, null);
          assert.equal(exclusions, null);
          return row;
        },
      ),
      oldRows.map((row) => ({ ...row })),
    );
    assert.deepEqual(
      await f.state.read(async (sql) => await sql.all('SELECT * FROM review_commands')),
      oldCommands,
    );
    assert.deepEqual(await reviews.request(f.producer, input), {
      ...oldResults[0],
      formatVersion: 1,
      synopsis: null,
      findings: [],
      evidence: {},
      administrativeActorId: f.producer.actorId,
      pinnedInputIds: [],
    });
    await assert.rejects(
      async () =>
        await f.state.transaction(
          async (tx) =>
            await tx.run(
              'UPDATE reviews SET synopsis=? WHERE id=?',
              'Changed.',
              'legacy-submitted',
            ),
        ),
      /immutable/,
    );
    for (const id of ['legacy-requested', 'legacy-started']) {
      const claim = await reviews.start(f.reviewer, id);
      const result = await reviews.submit(f.reviewer, {
        reviewId: id,
        claimId: claim.claimId!,
        verdict: 'pass',
        notes: 'Completing the existing legacy contract.',
        requestId: `submit-${id}`,
      });
      assert.equal(result.formatVersion, 1);
      assert.equal(result.status, 'submitted');
    }
  } finally {
    await f.close();
  }
});
