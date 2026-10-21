import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import { CodeRepositories } from '@merv/code/store/repository';
import type { CodeService } from '@merv/code-work/service';
import type { Caller, ReviewRequest } from '@merv/contracts';
import type { Experiment } from '@merv/experiments/types';
import type { WorkSession } from '@merv/sessions/types';
import { createApp, quietApiConfig } from './fixtures/app.js';
import { git } from './fixtures/code-store.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { citedEvidence, feasibilityStatement } from './feasibility-fixture.js';
import { s3Blobs } from './fixtures/s3-blobs.js';

/** Real app, PostgreSQL, managed authentication, metadata HTTP and native Git HTTP.
 * Scripted worker actions replace a model. The optional Docker phase verifies the actual
 * fetched submission through the production mount/identity boundary, not a fake review service.
 * Fleet provisioning and report rendering are outside this test (the ordinary app fixture
 * supplies its documented report adapter). This is not deployed hosted-image acceptance.
 */
test(
  'managed HTTP lifecycle freezes dirty planning and results, approves exact commits, and acknowledges teardown',
  { timeout: 90_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'merv-http-lifecycle-'));
    const managedEnv = `MERV_LIFECYCLE_${randomBytes(8).toString('hex').toUpperCase()}`;
    process.env[managedEnv] = randomBytes(48).toString('hex');
    const s3 = await s3Blobs(t);
    const config = quietApiConfig();
    config.plugins = config.plugins.map((entry) =>
      entry.id === 'sessions'
        ? { ...entry, config: { managedSecretEnv: managedEnv, sweepIntervalMs: 60_000 } }
        : entry.id === 'blobs'
          ? s3.entry
          : entry,
    );
    const app = await createApp({ directory: join(root, 'server'), config, port: 0 });
    const code = app.ctx.codeWork as CodeService;
    const drivers: CodeWorkspaceDriver[] = [];
    const clients = new Map<string, Client>();
    t.after(async () => {
      await Promise.all([...clients.values()].map((client) => client.close()));
      for (const driver of drivers) driver.dispose();
      await app.stop();
      delete process.env[managedEnv];
      rmSync(root, { recursive: true, force: true });
    });
    const boot = await app.ctx.scope.credentials.bootstrap({
      projectName: 'HTTP lifecycle',
      actorName: 'Owner',
    });
    const owner: Caller = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const base = app.ctx.api.url!;
    let sequence = 0;
    const request = () => `lifecycle-${++sequence}`;
    const http = async <T>(
      path: string,
      token: string,
      body?: unknown,
      method = body === undefined ? 'GET' : 'POST',
    ): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-merv-project-id': owner.projectId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok)
        throw Object.assign(new Error(`${path}: ${JSON.stringify(result)}`), {
          status: response.status,
        });
      return result as T;
    };
    const tool = async <T>(name: string, token: string, input: unknown): Promise<T> => {
      if (!token.startsWith('ms_'))
        return (await http<{ result: T }>(`/tools/${name}`, token, input)).result;
      let client = clients.get(token);
      if (!client) {
        client = new Client({ name: 'scripted-lifecycle-worker', version: '1' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }),
        );
        clients.set(token, client);
      }
      const response = await client.callTool({ name, arguments: input as Record<string, unknown> });
      const content = response.content as { type: string; text?: string }[];
      const result = JSON.parse(content.find((item) => item.type === 'text')!.text!);
      assert.equal(response.isError ?? false, false, `${name}: ${JSON.stringify(result)}`);
      return result as T;
    };
    await waitForManagedCode(code, owner);
    const repository = new CodeRepositories({
      root: join(root, 'server', 'code'),
      quotaBytes: 0,
      reservedFreeBytes: 0,
    }).paths(owner.projectId).repository;
    const commitCount = () => Number(git(repository, ['rev-list', '--all', '--count']));
    const initialCount = commitCount();
    let experiment = await tool<Experiment>('experiment.create', boot.token, {
      name: 'exact-dirty-code',
      intent: 'Verify add(2,3) using retained code.',
      requestId: request(),
    });
    const independent = await app.ctx.scope.credentials.issueActor(owner, {
      name: 'Independent review authority',
      role: 'operator',
    });
    const reviewerSource: Caller = {
      ...owner,
      actorId: independent.actor.id,
      credentialId: independent.credential.id,
    };
    const current = new Set<string>();
    app.ctx.sessions.managed.registerValidator({
      current: async (binding) => current.has(binding.allocationId),
      admits: async (allocationId) => current.has(allocationId),
      serves: () => false,
      retired: async () => false,
      assignmentSources: async (binding) => [binding.source],
    });
    const platform = {
      name: 'local-scripted',
      harness: 'codex' as const,
      enabled: true,
      parallelism: 1,
    };
    const capabilities = ['code.git.1', 'workflow.workhost.1'];
    const machine = async (name: string, source: Caller) => {
      const allocationId = `allocation_${name}`;
      current.add(allocationId);
      const enrollment = await app.ctx.sessions.managed.ensure({
        allocationId,
        epoch: 1,
        source: await app.ctx.scope.delegationSource(source),
        runtimeProfileId: 'local-lifecycle',
        platform,
        capabilities,
        workInstanceId: experiment.id,
        stepSeconds: 600,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const { controlToken } = await http<{ controlToken: string }>(
        '/sessions/runners/enroll',
        enrollment.enrollmentToken,
        { workerNonce: randomBytes(32).toString('hex') },
      );
      const runnerId = `runner_${name}`;
      await http('/sessions/runners/heartbeat', controlToken, {
        runnerId,
        machine: { hostname: name, system: process.platform, architecture: process.arch },
        platforms: [platform],
        capabilities,
        capacity: 1,
      });
      const directory = join(root, name);
      mkdirSync(directory);
      const assignmentRoot = join(directory, 'assignments');
      mkdirSync(assignmentRoot, { mode: 0o700 });
      const stopped = new Set<string>();
      const driver = new CodeWorkspaceDriver(
        {
          directory,
          path: join(directory, 'ledger.sqlite'),
          terminal: (id) => stopped.has(id),
          assignmentWorkspaceDirectory: realpathSync(assignmentRoot),
          workInstanceId: experiment.id,
          assignmentUser: {
            uid: process.getuid!() || 12001,
            gid: process.getgid!() || 12001,
            git: '/usr/bin/git',
          },
        },
        {
          remoteUrl: (path) => `${base}${path}`,
          call: (route, body) => http(`/code/v2/${route}`, controlToken, body),
        },
      );
      drivers.push(driver);
      return { allocationId, controlToken, runnerId, driver, stopped };
    };
    const writer = await machine('writer', owner);
    const reviewer = await machine('reviewer', reviewerSource);
    await http('/sessions/dispatch', boot.token, { enabled: true }, 'PUT');
    const lease = async (host: Awaited<ReturnType<typeof machine>>) => {
      const secret = `ms_${randomBytes(32).toString('base64url')}`;
      const answer = await http<{ session: WorkSession | null; reason: string }>(
        '/sessions/lease',
        host.controlToken,
        {
          runnerId: host.runnerId,
          platform: { name: platform.name, harness: platform.harness },
          requestId: request(),
          secret,
        },
      );
      assert.ok(answer.session, `expected ${host.runnerId} lease, got ${answer.reason}`);
      const session = answer.session;
      assert.equal(session.instanceId, experiment.id);
      const launch = { id: request(), sessionId: session.id, runDirectory: join(root, request()) };
      mkdirSync(launch.runDirectory);
      const workspace = await host.driver.prepare(launch, session);
      const control = { runnerId: host.runnerId, hostRef: launch.id };
      await http(`/sessions/${session.id}/attach`, host.controlToken, {
        ...control,
        workspace: workspace.snapshot,
      });
      return { host, session, launch, workspace, secret, control };
    };
    const settle = async (held: Awaited<ReturnType<typeof lease>>) => {
      held.host.stopped.add(held.launch.id);
      const workspace = await held.host.driver.capture(held.launch);
      await http(`/sessions/${held.session.id}/release`, held.host.controlToken, {
        runnerId: held.host.runnerId,
      });
      if (workspace)
        await http(`/sessions/${held.session.id}/workspace-result`, held.host.controlToken, {
          ...held.control,
          workspace,
        });
      await held.host.driver.close(held.launch);
      await app.ctx.domainEvents.drain();
    };
    const attach = async (
      held: Awaited<ReturnType<typeof lease>>,
      role: string,
      content: string,
    ) => {
      const artifact = await tool<{ id: string }>('artifact.create', held.secret, {
        title: role,
        content,
        mediaType: role === 'plan' || role === 'report' ? 'text/markdown' : 'application/json',
      });
      await tool('experiment.attach', held.secret, {
        artifactId: artifact.id,
        role,
        path: `${role}.${role === 'plan' || role === 'report' ? 'md' : 'json'}`,
        attemptIndex: experiment.attempt.index,
        requestId: request(),
      });
    };
    const keepConversation = async (held: Awaited<ReturnType<typeof lease>>) => {
      if (!held.session.continuity) return;
      const bytes = Buffer.from(
        JSON.stringify({ type: 'user', text: `Retained scripted visit ${held.session.id}` }) + '\n',
      );
      const facts = {
        ...held.control,
        harness: 'codex',
        conversationId: '0199a0b2-1111-7222-8333-944445555666',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      };
      const path = `/sessions/${held.session.id}/conversation`;
      await http(path, held.host.controlToken, facts);
      const { conversation } = await http<{
        conversation: { upload: { url: string; headers: Record<string, string> } };
      }>(path, held.host.controlToken, { ...facts, deliver: true });
      const put = await fetch(conversation.upload.url, {
        method: 'PUT',
        headers: conversation.upload.headers,
        body: new Uint8Array(bytes),
      });
      assert.equal(put.status, 200);
      const confirmed = await http<{ conversation: { uploadedAt: string | null } }>(
        path,
        held.host.controlToken,
        { ...facts, deliver: true },
      );
      assert.ok(confirmed.conversation.uploadedAt);
    };
    const submit = async (held: Awaited<ReturnType<typeof lease>>, transition: string) => {
      await keepConversation(held);
      experiment = await tool<Experiment>('experiment.transition', held.secret, {
        transition,
        requestId: request(),
      });
      await settle(held);
      const frozen = await code.capture(owner, experiment.submissions.at(-1)!.codeCaptureRef!);
      assert.equal(frozen.status, 'ready');
      assert.equal(
        git(held.workspace.path, ['rev-parse', 'HEAD']),
        frozen.workspace!.submission!.parentOid,
        'submission created no commit',
      );
      return frozen.workspace!.submission!;
    };
    const inspect = async (
      held: Awaited<ReturnType<typeof lease>>,
      frozen: { parentOid: string; treeOid: string },
      files: Record<string, string>,
    ) => {
      assert.equal(held.workspace.readOnly, true);
      assert.equal(git(held.workspace.path, ['rev-parse', 'HEAD']), frozen.parentOid);
      assert.equal(git(held.workspace.path, ['write-tree']), frozen.treeOid);
      for (const [path, content] of Object.entries(files))
        assert.equal(readFileSync(join(held.workspace.path, path), 'utf8'), content);
      const access = held.host.driver.agentGit(held.launch.id);
      const denied = await promisify(execFile)(
        'git',
        [
          '-c',
          `http.${access.url}.extraHeader=Authorization: Basic ${Buffer.from(`merv:${access.token}`).toString('base64')}`,
          'push',
          access.url,
          `HEAD:refs/heads/merv/work/${experiment.id}`,
        ],
        { cwd: held.workspace.path },
      ).then(
        () => false,
        () => true,
      );
      assert.equal(denied, true, 'review credentials cannot push');
      if (process.env.MERV_LINUX_REVIEW_IMAGE) {
        const facts = join(root, `${request()}.json`);
        writeFileSync(
          facts,
          JSON.stringify({ parent: frozen.parentOid, tree: frozen.treeOid, files }),
        );
        const project = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
        const result = await promisify(execFile)(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--cap-add',
            'SYS_ADMIN',
            '--security-opt',
            'seccomp=unconfined',
            '--mount',
            `type=bind,src=${held.workspace.path},dst=/input,readonly`,
            '--mount',
            `type=bind,src=${facts},dst=/facts.json,readonly`,
            '--mount',
            `type=bind,src=${join(project, 'scripts/hosted-runner')},dst=/opt/merv/runtime,readonly`,
            '--mount',
            `type=bind,src=${join(project, 'vendor/merv-sandboxes/typescript/packages/runtimes/assets/python')},dst=/opt/merv/python,readonly`,
            '--entrypoint',
            'python3',
            process.env.MERV_LINUX_REVIEW_IMAGE,
            '/opt/merv/runtime/linux-submission-review.py',
          ],
          { timeout: 30_000, maxBuffer: 1024 * 1024 },
        );
        assert.equal(JSON.parse(result.stdout.trim()).tree, frozen.treeOid);
      }
    };
    const approve = async (held: Awaited<ReturnType<typeof lease>>) => {
      const review = await tool<ReviewRequest>('review.get', held.secret, {
        reviewId: experiment.reviewId!,
      });
      await keepConversation(held);
      experiment = await tool<Experiment>('review.submit', held.secret, {
        reviewId: review.id,
        claimId: review.claimId,
        expectedRevision: experiment.workflow.revision,
        verdict: 'pass',
        notes: 'Verified exact retained files and tested add(2,3).',
        synopsis: 'The submitted code and retained evidence satisfy the planned verification.',
        findings: review.criteria.map((_, index) => ({
          criterionNumber: index + 1,
          status: 'met',
          evidenceIds: citedEvidence(experiment, review, index + 1),
          notes: 'Inspected retained evidence against this criterion.',
        })),
        requestId: request(),
      });
      await settle(held);
      await code.submissions.reconcile();
    };
    const planCode = 'def add(a, b): return a + b\nprint(add(2, 3))\n';
    const planner = await lease(writer);
    assert.equal(planner.workspace.readOnly, false);
    writeFileSync(join(planner.workspace.path, 'plan.py'), planCode);
    await attach(
      planner,
      'plan',
      '# Summary\nTest addition.\n# Objective & hypothesis\nThe function adds numbers.\n# Evaluation\nEvaluate 2 plus 3 against 5.',
    );
    await attach(planner, 'feasibility', feasibilityStatement());
    const design = await submit(planner, 'submit_design');
    assert.equal(commitCount(), initialCount, 'dirty planning submission retains no commit');
    const designReview = await lease(reviewer);
    await inspect(designReview, design, { 'plan.py': planCode });
    await approve(designReview);
    assert.equal(commitCount(), initialCount + 1, 'plan approval adds exactly one milestone');
    assert.equal(experiment.workflow.state, 'running');
    const execution = await lease(writer);
    const planCommit = git(execution.workspace.path, ['rev-parse', 'HEAD']);
    assert.notEqual(planCommit, design.parentOid);
    assert.equal(git(execution.workspace.path, ['rev-parse', 'HEAD^{tree}']), design.treeOid);
    assert.equal(
      execution.workspace.path,
      planner.workspace.path,
      'same work host continues its checkout',
    );
    writeFileSync(join(execution.workspace.path, 'result.txt'), '2 + 3 = 5\n');
    await attach(execution, 'result', '{"observed":5,"expected":5}');
    await attach(
      execution,
      'report',
      '# Summary\nThe check passed.\n# Results\nThe retained observation equals 5.\n# Deviations from plan\nNone.\n# Conclusion\nAddition returned the expected value.',
    );
    const result = await submit(execution, 'submit_results');
    assert.equal(commitCount(), initialCount + 1, 'dirty result submission retains no commit');
    assert.equal(result.parentOid, planCommit);
    const resultsReview = await lease(reviewer);
    await inspect(resultsReview, result, { 'plan.py': planCode, 'result.txt': '2 + 3 = 5\n' });
    await approve(resultsReview);
    const accepted = (await code.unit(owner, experiment.id)).acceptance;
    assert.ok(accepted?.reference);
    assert.notEqual(accepted.reference, planCommit);
    assert.equal(git(repository, ['rev-parse', `${accepted.reference}^`]), planCommit);
    assert.equal(git(repository, ['rev-parse', `${accepted.reference}^{tree}`]), result.treeOid);
    assert.equal(commitCount(), initialCount + 2, 'results approval adds exactly one milestone');
    const again = await code.unit(owner, experiment.id);
    assert.equal(again.acceptance?.reference, accepted.reference);
    // Teardown occurs after approval. It must reuse the exact already durable tree, not
    // create an extra capture commit or mutate the reviewed acceptance.
    await http('/sessions/runners/shutdown', writer.controlToken, { request: true });
    current.delete(writer.allocationId);
    const captures = await writer.driver.shutdownCapture();
    assert.equal(captures.length, 1);
    assert.equal(captures[0]!.headOid, accepted.reference);
    assert.equal(captures[0]!.treeOid, result.treeOid);
    const receipt = { captures, empty: false };
    assert.deepEqual(await http('/sessions/runners/shutdown', writer.controlToken, { receipt }), {
      requested: true,
      acknowledged: true,
    });
    assert.deepEqual(await http('/sessions/runners/shutdown', writer.controlToken, { receipt }), {
      requested: true,
      acknowledged: true,
    });
    assert.equal((await code.unit(owner, experiment.id)).acceptance?.reference, accepted.reference);
    assert.equal(commitCount(), initialCount + 2, 'shutdown adds no duplicate of accepted code');
    assert.equal(await app.ctx.sessions.managed.requestShutdown(writer.allocationId, 1), true);
    await http('/sessions/runners/shutdown', reviewer.controlToken, { request: true });
    current.delete(reviewer.allocationId);
    assert.deepEqual(await reviewer.driver.shutdownCapture(), []);
    assert.deepEqual(
      await http('/sessions/runners/shutdown', reviewer.controlToken, {
        receipt: { captures: [], empty: true },
      }),
      { requested: true, acknowledged: true },
    );
    assert.equal(await app.ctx.sessions.managed.requestShutdown(reviewer.allocationId, 1), true);
    if (!process.env.MERV_LINUX_REVIEW_IMAGE)
      t.diagnostic(
        'Linux mount gate not run; set MERV_LINUX_REVIEW_IMAGE to an image with Python, Git, mount and identities 1000/12001.',
      );
  },
);
