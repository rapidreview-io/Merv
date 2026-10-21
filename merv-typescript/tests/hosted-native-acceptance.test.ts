import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { twoStepWorkflow } from './fixtures/session-workflow.js';
const { operator, request, collect } = await import(
  new URL('../deploy/hosted-native-acceptance.mjs', import.meta.url).href
);

// Real local HTTP/Tools/Postgres contract test. This does not establish public TLS,
// model execution, protected launcher isolation or Cloudflare acceptance.
test('hosted operator request creates idempotently and collects through actual noun HTTP APIs', async (t) => {
  const f = await twoStepWorkflow(t, 'hostedacceptance');
  const paths: string[] = [];
  const api = operator(
    'https://acceptance.invalid',
    f.owner.projectId,
    f.token,
    async (url: URL, options: RequestInit) => {
      paths.push(url.pathname);
      const response = await fetch(new URL(url.pathname + url.search, f.app.ctx.api.url!), options);
      assert.ok(
        response.ok,
        `${url.pathname}: ${JSON.stringify(await response.clone().json()).slice(0, 1500)}`,
      );
      return response;
    },
  );
  const probe = await readFile(
    new URL('../scripts/hosted-runner/native-acceptance-probe.py', import.meta.url),
  );
  const payload = request('http-contract', probe);
  await api.get('/sessions/status');
  const experiment = await api.tool('experiment.write', payload);
  assert.equal(experiment.workflow.state, 'planned');
  assert.equal((await api.tool('experiment.write', payload)).id, experiment.id);
  const evidence = await collect(api, { instanceId: experiment.id, runId: 'http-contract' }, {});
  assert.equal(evidence.experiment.id, experiment.id);
  assert.equal(evidence.acceptanceComplete, false);
  assert.deepEqual(evidence.proofs, []);
  assert.equal(evidence.submissions.items.length, 0);
  assert.ok(paths.includes('/tools/code.read'));
  assert.ok(paths.includes('/sessions/threads'));
  assert.deepEqual(evidence.threads, []);
});
