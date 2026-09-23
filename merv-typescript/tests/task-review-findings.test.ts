import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from './fixtures/app.js';
import type { Caller, TaskReview } from '@merv/contracts';
import { confirmedDelivery } from './fixtures/task-evidence.js';

const synopsis =
  'The independent checks establish the arithmetic result and its handling of negative inputs.';
async function fixture(api = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-review-findings-'));
  const app = await createApp({ directory, api, port: 0 });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Review findings',
    actorName: 'Operator',
  });
  const operator: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
  const issue = async (role: 'producer' | 'reviewer' | 'reader') => {
    const result = await app.ctx.scope.issueActor(operator, { role, name: role });
    return {
      caller: { projectId: operator.projectId, actorId: result.actor.id },
      token: result.token,
    };
  };
  const producer = await issue('producer'),
    reviewer = await issue('reviewer'),
    reviewer2 = await issue('reviewer');
  let sequence = 0;
  const pending = async () => {
    const task = await app.ctx.tasks.create(producer.caller, {
      title: 'Check adder',
      goal: 'Verify addition.',
      checks: ['Positive inputs work.', 'Negative inputs work.'],
      requestId: `create-${++sequence}`,
    });
    const proof = await app.ctx.artifacts.create(producer.caller, {
      title: 'Execution receipts',
      mediaType: 'application/json',
      content: '{"positive":5,"negative":-1}',
    });
    const submitted = await app.ctx.tasks.submitDelivery(
      producer.caller,
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [proof.id],
          expectedRevision: 0,
          requestId: `delivery-${sequence}`,
        },
        2,
      ),
    );
    return {
      task: submitted,
      proof,
      review: await app.ctx.reviews.get(operator, submitted.reviewId!),
    };
  };
  const claim = async (reviewId: string, taskRevision: number): Promise<TaskReview> => {
    const review = await app.ctx.reviews.start(reviewer.caller, reviewId);
    return {
      reviewId,
      claimId: review.claimId!,
      expectedRevision: taskRevision,
      verdict: 'pass',
      notes: 'Checked both retained cases independently.',
      synopsis,
      findings: review.criteria.map((_, index) => ({
        criterionNumber: index + 1,
        status: 'met',
        evidenceIds: [review.artifactIds[1]],
        notes: `Recomputed case ${index + 1} independently from the retained receipt.`,
      })),
      evidence: {
        outcome: 'Verified arithmetic behavior.',
        observed: { positive: 5, negative: -1 },
      },
      requestId: `review-${++sequence}`,
    };
  };
  const durable = async () =>
    await app.ctx.state.read(async (sql) => ({
      tasks: await sql.all('SELECT * FROM tasks ORDER BY id'),
      reviews: await sql.all('SELECT * FROM reviews ORDER BY id'),
      workflows: await sql.all('SELECT * FROM wf_instances ORDER BY id'),
      history: await sql.all('SELECT * FROM wf_history ORDER BY instance_id,revision'),
      commands: await sql.all('SELECT * FROM task_commands ORDER BY request_id'),
      verdictCommands: await sql.all('SELECT * FROM review_commands ORDER BY request_id'),
      events: await app.ctx.state.events(operator.projectId),
    }));
  return {
    directory,
    app,
    operator,
    producer,
    reviewer,
    reviewer2,
    issue,
    pending,
    claim,
    durable,
    close: async () => {
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('structured task review routes verdicts, prioritizes outcome and carries exact findings into revision context', async () => {
  const f = await fixture();
  try {
    for (const verdict of ['needs_changes', 'fail', 'pass'] as const) {
      const { task, review, proof } = await f.pending();
      assert.equal(review.formatVersion, 2);
      const input = { ...(await f.claim(review.id, task.workflow.revision)), verdict };
      if (verdict !== 'pass')
        input.findings![1] = {
          criterionNumber: 2,
          status: 'not_met',
          evidenceIds: [proof.id],
          notes:
            'Negative inputs produce the wrong sign. Correct the sign and rerun the negative case.',
        };
      const evaluated = await f.app.ctx.workflows.evaluate(f.reviewer.caller, task.id);
      assert.deepEqual(
        evaluated.actions.find((action) => action.action === 'submit_review')?.requiredInput,
        ['verdict', 'notes', 'synopsis', 'findings'],
      );
      const saved = await f.app.ctx.tasks.submitReview(f.reviewer.caller, input);
      assert.equal(
        saved.workflow.state,
        { pass: 'done', needs_changes: 'in_progress', fail: 'failed' }[verdict],
      );
      const result = await f.app.ctx.reviews.get(f.operator, review.id);
      assert.deepEqual(result.findings, input.findings);
      assert.deepEqual(result.evidence, input.evidence);
      assert.equal(result.synopsis, synopsis);
      assert.deepEqual(await f.app.ctx.tasks.submitReview(f.reviewer.caller, input), saved);
      await assert.rejects(
        async () =>
          await f.app.ctx.tasks.submitReview(f.reviewer.caller, {
            ...input,
            evidence: { outcome: 'Changed' },
          }),
        { code: 'request_conflict' },
      );
      if (verdict === 'pass') assert.equal(saved.workflow.data.outcome, input.evidence!.outcome);
      if (verdict === 'needs_changes') {
        const context = await f.app.ctx.tasks.context(f.producer.caller, {
          taskId: task.id,
          purpose: 'work',
          expectedRevision: saved.workflow.revision,
          requestId: `revision-context-${task.id}`,
        });
        assert.ok(context.prompt.includes(result.snapshotHash));
        assert.ok(context.prompt.includes('Correct the sign'));
        assert.ok(context.prompt.includes(synopsis));
        assert.ok(context.prompt.includes('"negative":-1'));
        const next = await f.app.ctx.tasks.submitDelivery(
          f.producer.caller,
          confirmedDelivery(
            {
              taskId: task.id,
              artifactIds: [proof.id],
              expectedRevision: saved.workflow.revision,
              requestId: `delivery-again-${task.id}`,
            },
            2,
          ),
        );
        assert.notEqual(next.reviewId, review.id);
        assert.deepEqual(await f.app.ctx.reviews.get(f.operator, review.id), result);
        assert.deepEqual((await f.app.ctx.reviews.get(f.operator, next.reviewId!)).findings, []);
      }
    }
    for (const useSynopsis of [true, false]) {
      const { task, review } = await f.pending();
      const input = await f.claim(review.id, task.workflow.revision);
      delete input.evidence;
      if (!useSynopsis) {
        // A v2 review always requires a synopsis; its absence must not silently use notes.
        delete input.synopsis;
        await assert.rejects(
          async () => await f.app.ctx.tasks.submitReview(f.reviewer.caller, input),
          {
            code: 'invalid_synopsis',
          },
        );
      } else
        assert.equal(
          (await f.app.ctx.tasks.submitReview(f.reviewer.caller, input)).workflow.data.outcome,
          synopsis,
        );
    }
  } finally {
    await f.close();
  }
});

test('task review preflight and commit reject inconsistent findings without changing either service', async () => {
  const f = await fixture();
  try {
    const { task, review } = await f.pending();
    const input = await f.claim(review.id, task.workflow.revision);
    const other = await f.app.ctx.artifacts.create(f.producer.caller, {
      title: 'Unsubmitted receipt',
      content: 'No review pin.',
    });
    const cases = [
      { ...input, findings: [] },
      { ...input, findings: input.findings!.slice(0, 1) },
      { ...input, findings: [input.findings![0], input.findings![0]] },
      {
        ...input,
        findings: input.findings!.map((x) => ({
          ...x,
          status: 'not_verified' as const,
          evidenceIds: [],
        })),
      },
      { ...input, findings: input.findings!.map((x) => ({ ...x, evidenceIds: [other.id] })) },
    ];
    for (const invalid of cases) {
      const before = await f.durable();
      const decision = await f.app.ctx.workflows.evaluate(f.reviewer.caller, task.id, {
        action: 'submit_review',
        input: { ...invalid },
      });
      assert.ok(decision.blockers.some((x) => x.code === 'invalid_findings'));
      await assert.rejects(
        async () => await f.app.ctx.tasks.submitReview(f.reviewer.caller, invalid),
        {
          code: 'invalid_findings',
        },
      );
      assert.deepEqual(await f.durable(), before);
    }
    await assert.rejects(
      async () => await f.app.ctx.tasks.submitReview(f.reviewer2.caller, input),
      {
        code: 'review_independence',
      },
    );
    const stale = { ...input, expectedRevision: task.workflow.revision - 1 };
    const staleBefore = await f.durable();
    await assert.rejects(
      async () =>
        await f.app.ctx.workflows.evaluate(f.reviewer.caller, task.id, {
          action: 'submit_review',
          input: { ...stale },
        }),
      { code: 'revision_conflict' },
    );
    await assert.rejects(async () => await f.app.ctx.tasks.submitReview(f.reviewer.caller, stale), {
      code: 'revision_conflict',
    });
    assert.deepEqual(await f.durable(), staleBefore);
    const before = await f.durable();
    const append = f.app.ctx.state.appendEvent.bind(f.app.ctx.state);
    f.app.ctx.state.appendEvent = async (tx, event) => {
      if (event.type === 'task.review_applied') throw new Error('injected final event failure');
      return await append(tx, event);
    };
    await assert.rejects(
      async () => await f.app.ctx.tasks.submitReview(f.reviewer.caller, input),
      /injected final event failure/,
    );
    f.app.ctx.state.appendEvent = append;
    assert.deepEqual(await f.durable(), before);
    assert.equal(
      (await f.app.ctx.tasks.submitReview(f.reviewer.caller, input)).workflow.state,
      'done',
    );
  } finally {
    await f.close();
  }
});

test('reissue and revoked-review recovery preserve the pinned verdict format and fence old claims', async () => {
  const f = await fixture();
  try {
    for (const version of [1, 2] as const) {
      const request = f.app.ctx.reviews.request.bind(f.app.ctx.reviews);
      // Simulate the previous Task release's generic request contract, without rewriting stored rows.
      f.app.ctx.reviews.request = async (caller, input, tx) =>
        await request(caller, { ...input, formatVersion: version }, tx);
      const { task, review } = await f.pending();
      f.app.ctx.reviews.request = request;
      const input = await f.claim(review.id, task.workflow.revision);
      const next = await f.app.ctx.tasks.reissueReview(f.producer.caller, {
        taskId: task.id,
        expectedRevision: task.workflow.revision,
        reason: 'Replacement reviewer needed.',
        requestId: `reissue-${version}`,
      });
      const replacement = await f.app.ctx.reviews.get(f.operator, next.reviewId!);
      assert.equal(replacement.formatVersion, version);
      assert.deepEqual(replacement.artifactIds, review.artifactIds);
      await assert.rejects(
        async () => await f.app.ctx.tasks.submitReview(f.reviewer.caller, input),
        {
          code: 'stale_review',
        },
      );
      const nextInput = await f.claim(replacement.id, next.workflow.revision);
      if (version === 1) {
        delete nextInput.synopsis;
        delete nextInput.findings;
        delete nextInput.evidence;
        const guidance = await f.app.ctx.workflows.evaluate(f.reviewer.caller, task.id);
        assert.deepEqual(
          guidance.actions.find((action) => action.action === 'submit_review')?.requiredInput,
          ['verdict', 'notes'],
        );
        assert.equal(
          (await f.app.ctx.tasks.submitReview(f.reviewer.caller, nextInput)).workflow.data.outcome,
          nextInput.notes,
        );
      } else {
        await f.app.ctx.scope.revokeActor(f.operator, f.reviewer.caller.actorId);
        await f.app.ctx.domainEvents.drain();
        const recovered = await f.app.ctx.reviews.get(f.operator, replacement.id);
        assert.equal(recovered.formatVersion, 2);
        assert.equal(recovered.status, 'requested');
        assert.equal(recovered.snapshotHash, replacement.snapshotHash);
        const newClaim = await f.app.ctx.reviews.start(f.reviewer2.caller, replacement.id);
        assert.notEqual(newClaim.claimId, nextInput.claimId);
        const withNewClaim = {
          ...nextInput,
          claimId: newClaim.claimId!,
          requestId: 'recovered-verdict',
        };
        await assert.rejects(
          async () =>
            await f.app.ctx.tasks.submitReview(f.reviewer2.caller, {
              ...withNewClaim,
              claimId: nextInput.claimId,
            }),
          { code: 'stale_claim' },
        );
        assert.equal(
          (await f.app.ctx.tasks.submitReview(f.reviewer2.caller, withNewClaim)).workflow.state,
          'done',
        );
      }
    }
  } finally {
    await f.close();
  }
});

test('HTTP/MCP publishes and enforces structured review schema and returns one canonical assessment', async () => {
  const f = await fixture(true);
  const client = new Client({ name: 'task-review-findings-test', version: '1' });
  try {
    const { task, review } = await f.pending();
    const input = await f.claim(review.id, task.workflow.revision);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.app.ctx.api.url + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${f.reviewer.token}` } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text: string }[];
      return { result, data: JSON.parse(content.find((x) => x.type === 'text')!.text) };
    };
    const catalog = await client.listTools();
    const submit = catalog.tools.find((x) => x.name === 'review.submit')!;
    assert.ok(submit.inputSchema.properties?.findings);
    assert.ok(submit.inputSchema.properties?.synopsis);
    assert.ok(submit.inputSchema.properties?.evidence);
    assert.equal(
      (
        await call('review.submit', {
          ...input,
          findings: input.findings!.map((x) => ({ ...x, unexpected: true })),
        })
      ).result.isError,
      true,
    );
    assert.equal(
      (await call('review.submit', { ...input, claimId: 'old-claim' })).data.error.code,
      'stale_claim',
    );
    const submitted = await call('review.submit', { ...input });
    assert.equal(submitted.result.isError, undefined);
    assert.equal(submitted.data.workflow.state, 'done');
    const throughMcp = await call('review.get', { reviewId: review.id });
    assert.deepEqual(throughMcp.data, await f.app.ctx.reviews.get(f.operator, review.id));
    assert.deepEqual(throughMcp.data.evidence, input.evidence);
    assert.deepEqual((await call('review.submit', { ...input })).data, submitted.data);
  } finally {
    await client.close();
    await f.close();
  }
});

test('independent review can explicitly waive a criterion with a recorded reason when the goal holds', async () => {
  const f = await fixture();
  try {
    const { task, review } = await f.pending();
    const input = await f.claim(review.id, task.workflow.revision);
    input.findings![1] = {
      criterionNumber: 2,
      status: 'waived',
      evidenceIds: [],
      notes:
        'The accepted input contract is positive integers only; negative input support is unnecessary for this goal.',
    };
    input.synopsis =
      'Positive-input behavior is verified; negative-input coverage is explicitly waived because it falls outside the agreed input contract.';
    const bad = {
      ...input,
      findings: input.findings!.map((item) =>
        item.status === 'waived' ? { ...item, notes: '   ' } : item,
      ),
    };
    const before = await f.durable();
    await assert.rejects(async () => await f.app.ctx.tasks.submitReview(f.reviewer.caller, bad), {
      code: 'invalid_findings',
    });
    assert.deepEqual(await f.durable(), before);
    assert.equal(
      (
        await f.app.ctx.workflows.evaluate(f.reviewer.caller, task.id, {
          action: 'submit_review',
          input: { ...input },
        })
      ).nextAction?.status,
      'ready',
    );
    const result = await f.app.ctx.tasks.submitReview(f.reviewer.caller, input);
    assert.equal(result.workflow.state, 'done');
    const saved = await f.app.ctx.reviews.get(f.operator, review.id);
    assert.equal(saved.findings[1].status, 'waived');
    assert.equal(saved.findings[1].notes, input.findings![1].notes);
    assert.equal(saved.synopsis, input.synopsis);
  } finally {
    await f.close();
  }
});
