import { mapAsync } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import type { Caller } from '@merv/contracts';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-experiments-api-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  config.plugins.find((entry) => entry.id === 'ui')!.config = {
    assets: join(directory, 'unused-assets'),
  };
  const app = await createApp({ directory, config, port: 0 });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Experiment transport acceptance',
    actorName: 'Operator',
  });
  const source: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const producer = await app.ctx.scope.issueActor(source, {
    name: 'Experiment producer',
    role: 'producer',
  });
  const reviewer = await app.ctx.scope.issueActor(source, {
    name: 'Independent reviewer',
    role: 'reviewer',
  });
  const reader = await app.ctx.scope.issueActor(source, { name: 'Project reader', role: 'reader' });
  const http = async (tool: string, input: unknown = {}, token: string | null = producer.token) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${tool}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const connect = async (token: string) => {
    const client = new Client({ name: 'Experiments acceptance', version: '1' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.ctx.api.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response.content)}`);
    return JSON.parse((response.content as { text: string }[])[0].text);
  };
  return { app, source, boot, producer, reviewer, reader, http, connect, call };
}

const plan =
  '# Comparison plan\n\n## Summary\nCompare two fixed classifiers on one retained held-out test set.\n\n## Objective & hypothesis\nA improves accuracy over B on the same 100 held-out examples.\n\n## Evaluation\nRun both fixed methods on the same held-out examples. Retain all predictions, including errors. Compute correct predictions divided by 100 for each method and report the paired difference without changing the evaluation set.\n';

test('Experiments strict transport keeps scoped records, replay, attempts and current revision authority', async (t) => {
  const f = await fixture(t);
  const input = {
    name: 'scoped-comparison',
    intent: 'Evaluate a held-out comparison.',
    requestId: 'create',
  };
  const created = await f.http('experiment.create', input);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const e = created.body.result;
  assert.equal(e.workflow.state, 'planned');
  assert.equal(e.attempt.index, 1);
  assert.deepEqual((await f.http('experiment.create', input)).body.result, e);
  assert.equal(
    (await f.http('experiment.create', { ...input, intent: 'Different intent.' })).status,
    409,
  );
  assert.deepEqual((await f.http('experiment.list', {}, f.reader.token)).body.result, [e]);
  assert.equal((await f.http('experiment.list', {}, null)).status, 401);
  assert.equal(
    (await f.http('experiment.create', { ...input, requestId: 'reader' }, f.reader.token)).status,
    403,
  );
  for (const [tool, args] of [
    ['experiment.create', { ...input, ownerId: f.boot.actor.id }],
    ['experiment.create', { ...input, name: '../escape' }],
    ['experiment.list', { invented: true }],
    ['experiment.get_state', { experimentId: e.id, includeBytes: true }],
    [
      'experiment.transition',
      {
        experimentId: e.id,
        transition: 'approve_design',
        expectedRevision: 0,
        requestId: 'approval',
      },
    ],
    [
      'experiment.attach',
      {
        experimentId: e.id,
        artifactId: 'art_missing',
        role: 'exhibit',
        path: 'metrics.json',
        attemptIndex: 1,
        expectedRevision: 0,
        requestId: 'fake-exhibit',
      },
    ],
  ] as const)
    assert.equal((await f.http(tool, args)).status, 400, tool);
  const other = await f.app.ctx.scope.bootstrap({
    projectName: 'Another project',
    actorName: 'Operator',
  });
  assert.equal(
    (await f.http('experiment.get_state', { experimentId: e.id }, other.token)).status,
    404,
  );
  const artifact = (
    await f.http('artifact.create', {
      title: 'Draft plan',
      content: plan,
      mediaType: 'text/markdown',
    })
  ).body.result;
  const attach = {
    experimentId: e.id,
    artifactId: artifact.id,
    role: 'plan',
    path: 'plan.md',
    attemptIndex: 1,
    expectedRevision: 0,
    requestId: 'attach',
  };
  assert.equal((await f.http('experiment.attach', { ...attach, expectedRevision: 1 })).status, 409);
  assert.equal((await f.http('experiment.attach', { ...attach, attemptIndex: 2 })).status, 409);
  assert.equal((await f.http('experiment.attach', attach)).status, 200);
  const state = (await f.http('experiment.get_state', { experimentId: e.id })).body.result;
  assert.equal(
    JSON.stringify(state).includes('Retain all predictions'),
    false,
    'get_state does not smuggle artifact content',
  );
  await f.app.ctx.scope.revokeCredential(f.source, f.producer.credential.id);
  assert.equal(
    (await f.http('experiment.create', input)).status,
    401,
    'replay still requires current authentication',
  );
});

test('Production Experiment MCP completes both reviews, pins exact evidence and survives provider unload', async (t) => {
  const f = await fixture(t),
    producer = await f.connect(f.producer.token),
    reviewer = await f.connect(f.reviewer.token);
  const descriptions = (await producer.listTools()).tools.filter((tool) =>
    tool.name.startsWith('experiment.'),
  );
  assert.deepEqual(descriptions.map((tool) => tool.name).sort(), [
    'experiment.attach',
    'experiment.create',
    'experiment.exhibit',
    'experiment.get_state',
    'experiment.graph',
    'experiment.list',
    'experiment.transition',
  ]);
  assert.equal(
    descriptions.find((tool) => tool.name === 'experiment.get_state')?.annotations?.readOnlyHint,
    true,
  );
  const claim = await f.call(producer, 'claim.create', {
    statement: 'A improves held-out accuracy over B.',
    requestId: 'claim',
  });
  const create = {
    name: 'held-out-comparison',
    intent: claim.statement,
    testedClaimIds: [claim.id],
    requestId: 'experiment',
  };
  let e = await f.call(producer, 'experiment.create', create);
  const original = structuredClone(e);
  const attach = async (role: string, path: string, content: string, resultFormat?: string) => {
    const artifact = await f.call(producer, 'artifact.create', {
      title: path,
      content,
      mediaType: path.endsWith('.json') ? 'application/json' : 'text/markdown',
    });
    await f.call(producer, 'experiment.attach', {
      experimentId: e.id,
      artifactId: artifact.id,
      role,
      path,
      attemptIndex: e.attempt.index,
      expectedRevision: e.workflow.revision,
      requestId: `attach-${path}`,
      ...(resultFormat ? { resultFormat } : {}),
    });
    return artifact;
  };
  const planArtifact = await attach('plan', 'plan.md', plan);
  e = await f.call(producer, 'experiment.transition', {
    experimentId: e.id,
    transition: 'submit_design',
    expectedRevision: e.workflow.revision,
    requestId: 'design',
  });
  assert.equal(e.workflow.state, 'design_review');
  const old = f.app.ctx.experiments;
  await f.app.setEnabled('experiments', false);
  assert.equal(
    (await producer.listTools()).tools.some((tool) => tool.name.startsWith('experiment.')),
    false,
  );
  assert.equal(
    (await f.http('ui.shell', {}, f.reader.token)).body.result.rows.some(
      (row: any) => row.id === 'experiments',
    ),
    false,
  );
  await assert.rejects(async () => await old.list(f.source), { status: 503 });
  assert.equal((await f.http('task.list')).status, 200);
  await f.app.setEnabled('experiments', true);
  assert.deepEqual(await f.call(producer, 'experiment.get_state', { experimentId: e.id }), e);
  assert.deepEqual(await f.call(producer, 'experiment.create', create), original);
  const grade = async (requestId: string) => {
    const review = await f.call(reviewer, 'review.get', { reviewId: e.reviewId });
    for (const artifactId of review.artifactIds)
      await f.call(reviewer, 'artifact.read', { artifactId });
    const claimed = await f.call(reviewer, 'review.start', { reviewId: review.id });
    const input = {
      reviewId: review.id,
      claimId: claimed.claimId,
      expectedRevision: e.workflow.revision,
      verdict: 'pass',
      notes:
        'Independently checked the controlled fixture evidence against every pinned criterion and verified the comparison arithmetic.',
      synopsis:
        'The retained fixture evidence satisfies the independent review criteria and preserves the matched held-out comparison.',
      findings: review.criteria.map((_: string, index: number) => ({
        criterionNumber: index + 1,
        status: 'met',
        evidenceIds: [...review.artifactIds],
        notes:
          'Checked the retained plan and available result evidence directly against this criterion.',
      })),
      requestId,
    };
    const applied = await f.call(reviewer, 'review.submit', input);
    assert.deepEqual(await f.call(reviewer, 'review.submit', input), applied);
    return applied;
  };
  e = await grade('approve-design');
  assert.equal(e.workflow.state, 'running');
  const approved = e.submissions.find(
    (submission: any) => submission.id === e.attempt.approvedSubmissionId,
  );
  assert.equal(
    approved.evidence.find((item: any) => item.role === 'plan').artifactId,
    planArtifact.id,
  );
  await f.call(producer, 'workflow.begin', {
    instanceId: e.id,
    expectedRevision: e.workflow.revision,
  });
  await attach(
    'result',
    'results.json',
    JSON.stringify({
      a: { correct: 80, total: 100, accuracy: 0.8 },
      b: { correct: 75, total: 100, accuracy: 0.75 },
      difference: 0.05,
    }),
    'json',
  );
  await attach(
    'graph',
    'graph.json',
    JSON.stringify({
      version: 1,
      nodes: [
        { id: 'hypothesis', label: 'A improves held-out accuracy' },
        { id: 'measurement', label: '80/100 versus 75/100' },
      ],
      edges: [{ from: 'measurement', to: 'hypothesis' }],
    }),
  );
  const preview = await f.call(producer, 'experiment.exhibit', { experimentId: e.id });
  assert.equal(preview.willPin, true);
  assert.ok(preview.startedAt);
  await attach(
    'report',
    'report.md',
    `# Report\n\n## Summary\nA exceeds B on the fixed held-out fixture.\n\n## Results\nA: 80/100 = 80%; B: 75/100 = 75%; difference 5 percentage points. See ${preview.path} for retained source counts.\n\n## Deviations from plan\nNone; both methods use every held-out example and the same denominator.\n\n## Conclusion\nThe controlled fixture supports a five-percentage-point advantage without establishing generalization beyond this fixed test set.\n`,
  );
  e = await f.call(producer, 'experiment.transition', {
    experimentId: e.id,
    transition: 'submit_results',
    expectedRevision: e.workflow.revision,
    requestId: 'results',
  });
  assert.equal(e.workflow.state, 'experiment_review');
  const results = e.submissions.find((submission: any) => submission.stage === 'results');
  assert.equal(results.evidence.find((item: any) => item.role === 'exhibit').hash, preview.hash);
  e = await grade('approve-results');
  assert.equal(e.workflow.state, 'complete');
  assert.equal(e.attempts.length, 1);
  assert.equal(e.submissions.length, 2);
  const savedClaim = (await f.call(producer, 'claim.list')).find(
    (item: any) => item.id === claim.id,
  );
  assert.equal(savedClaim.status, 'active');
  assert.equal(savedClaim.revision, 0);
  assert.equal(
    (await f.call(producer, 'experiment.graph', { experimentId: e.id })).attemptIndex,
    1,
  );
  const shell = (await f.http('ui.shell', {}, f.reader.token)).body.result;
  assert.equal(
    shell.rows.find((row: any) => row.id === 'experiments').status.count,
    0,
    'the row counts open experiments; this one is complete',
  );
  const events = await f.call(producer, 'feed.activity');
  assert.ok(events.some((event: any) => event.type.startsWith('experiment.')));
});
