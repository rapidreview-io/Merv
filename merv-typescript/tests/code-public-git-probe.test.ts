import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { CodeGitRemote } from '@merv/code/store/http';
import { MervError } from '@merv/contracts';
import { writerFixture } from './fixtures/code-writers.js';

test(
  'the public Git probe runs its full matrix against the real local service',
  { timeout: 90_000 },
  async (t) => {
    const { runProbe } = await import(
      new URL('../deploy/public-git-probe.mjs', import.meta.url).href
    );
    const f = await writerFixture(t);
    const remote = new CodeGitRemote(f.state, f.scope, f.core.repositories, f.core.writers);
    await remote.initialize();
    const credential = await f.scope.credentials.issueActorCredential(f.admin, {
      actorId: f.admin.actorId,
    });
    const server = createServer((req, res) => {
      void remote.handle(req, res, new URL(req.url!, 'http://localhost')).catch((error) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(error instanceof MervError ? error.status : 500);
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const tokenEnv = 'MERV_PUBLIC_GIT_PROBE_FIXTURE';
    process.env[tokenEnv] = credential.token;
    t.after(() => {
      delete process.env[tokenEnv];
    });
    const out = join(f.directory, 'public-probe');
    const report = await runProbe({
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      projectId: f.admin.projectId,
      tokenEnv,
      out,
      runId: 'local-fixture',
      largeMiB: 2,
      allowLocal: true,
    });
    assert.equal(report.complete, true);
    assert.equal(report.tests.length, 9);
    assert.ok(report.tests.every((check: { passed: boolean }) => check.passed));
    const saved = await readFile(join(out, 'report.json'), 'utf8');
    assert.ok(!saved.includes(credential.token));
    assert.ok(!saved.includes(Buffer.from(`merv:${credential.token}`).toString('base64')));
    assert.ok(
      !(await readFile(join(out, 'checkout/.git/config'), 'utf8')).includes(credential.token),
    );
  },
);
