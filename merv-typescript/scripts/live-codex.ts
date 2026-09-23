import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { finished } from 'node:stream/promises';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { loadConfiguration } from '../src/config.js';
import type {
  Actor,
  ActorCredential,
  Caller,
  HumanPrincipal,
  Project,
  Role,
  UserKey,
} from '@merv/contracts';
import type {} from '@merv/identity/types';
import { useRunSchema } from './database.js';
import { verifyLiveEvidence } from './live-evidence.js';
import { startProtocolProxy } from './protocol-proxy.js';

// Real model calls: this is intentionally separate from the deterministic test suite.
const runDirectory = resolve(
  process.argv[2] ?? join('live-runs', new Date().toISOString().replaceAll(':', '-')),
);
const schema = useRunSchema(runDirectory);
mkdirSync(dirname(runDirectory), { recursive: true });
// Never overwrite or mistake a previous attempt's report for this run.
mkdirSync(runDirectory, { mode: 0o700 });
const workingDirectory = join(runDirectory, 'agent-workspace');
mkdirSync(workingDirectory, { recursive: true });
const userKeys = process.argv.includes('--user-keys');
const sharedIdentity = userKeys || process.argv.includes('--shared-identity');
let selectedProject: string | undefined;
type Phase = 'producer' | 'reviewer' | 'observer';
interface ObservedCall {
  tool: string;
  status: string;
  errorCode?: string;
  transportError?: string;
}
const summary: {
  phase: Phase;
  threadId: string;
  exitCode: number;
  toolCalls: number;
  calls: ObservedCall[];
}[] = [];
const readTools = [
  'workflow.status_and_next',
  'workflow.assignment',
  'actor.whoami',
  'project.get',
  'task.get',
  'task.list',
  'review.get',
  'review.list',
  'artifact.get',
  'artifact.read',
  'artifact.list',
];
const phaseWrites: Record<Phase, string[]> = {
  producer: [
    'workflow.begin',
    'artifact.create',
    'task.create',
    'task.context',
    'task.submit_delivery',
    'review.start',
  ],
  reviewer: ['workflow.begin', 'review.start', 'task.context', 'review.submit', 'artifact.create'],
  observer: ['actor.create'],
};

const protocolObservations: {
  phase: Phase;
  observations: Awaited<ReturnType<typeof startProtocolProxy>>['observations'];
}[] = [];

async function codex(phase: Phase, token: string, url: string, prompt: string) {
  const proxy = await startProtocolProxy(url);
  try {
    await codexViaProxy(phase, token, proxy.url, prompt);
  } finally {
    await proxy.close();
    protocolObservations.push({ phase, observations: proxy.observations });
    writeFileSync(
      join(runDirectory, 'protocol.json'),
      JSON.stringify(protocolObservations, null, 2) + '\n',
    );
  }
}

async function codexViaProxy(phase: Phase, token: string, url: string, prompt: string) {
  const output = createWriteStream(join(runDirectory, `${phase}.jsonl`), { mode: 0o600 });
  const errors = createWriteStream(join(runDirectory, `${phase}.stderr.log`), { mode: 0o600 });
  const args = [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--json',
    '--color',
    'never',
    '-C',
    workingDirectory,
    '-c',
    'approval_policy="never"',
    '-c',
    'features.apps=false',
    '-c',
    'features.shell_tool=false',
    '-c',
    `mcp_servers.merv_typescript.url=${JSON.stringify(url + '/mcp')}`,
    '-c',
    'mcp_servers.merv_typescript.bearer_token_env_var="MERV_TEST_TOKEN"',
    '-c',
    'mcp_servers.merv_typescript.required=true',
    '-c',
    `mcp_servers.merv_typescript.enabled_tools=${JSON.stringify([...readTools, ...phaseWrites[phase]])}`,
    ...(selectedProject
      ? [
          '-c',
          `mcp_servers.merv_typescript.http_headers={"X-Merv-Project-Id"=${JSON.stringify(selectedProject)}}`,
        ]
      : []),
    // These writes are the expressly requested synthetic acceptance scenario.
    // This per-process policy never changes the user's persistent CLI settings;
    // server-side role checks still reject the negative permission probes.
    '-c',
    `mcp_servers.merv_typescript.tools={${phaseWrites[phase].map((name) => `${JSON.stringify(name)}={approval_mode="approve"}`).join(',')}}`,
    '-o',
    join(runDirectory, `${phase}.final.txt`),
    '-',
  ];
  // Keep account discovery and executable lookup, but do not inherit arbitrary
  // API keys, application secrets, or endpoint overrides from the parent shell.
  const childEnv: NodeJS.ProcessEnv = { MERV_TEST_TOKEN: token };
  for (const key of ['PATH', 'HOME', 'USER', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME']) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  const child = spawn(process.env.MERV_CODEX_BIN ?? 'codex', args, {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(JSON.stringify({ phase, status: 'started', pid: child.pid }));
  let buffer = '',
    threadId = '';
  const calls: ObservedCall[] = [];
  child.stdout.on('data', (chunk) => {
    output.write(chunk);
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started') threadId = event.thread_id;
        if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
          const item = event.item;
          let errorCode: string | undefined;
          for (const content of item.result?.content ?? []) {
            if (content.type === 'text')
              try {
                errorCode = JSON.parse(content.text)?.error?.code ?? errorCode;
              } catch {
                /* Text output need not be JSON. */
              }
          }
          calls.push({
            tool: item.tool,
            status: item.status,
            ...(errorCode ? { errorCode } : {}),
            ...(item.error ? { transportError: item.error.message } : {}),
          });
          console.log(JSON.stringify({ phase, ...calls.at(-1) }));
        }
      } catch {
        /* Keep raw output for debugging. */
      }
    }
  });
  child.stderr.pipe(errors);
  child.stdin.end(
    `You are testing the new Merv TypeScript application. Use ONLY the merv_typescript MCP tools to interact with it. Do not inspect the database or server source, do not edit any files, and do not invoke shell commands. Treat tool failures as test observations; report them accurately. Call workflow.status_and_next for orientation, then for the assigned task ID once known, and refresh it after any handoff or claim. Follow its caller-specific guidance.\n\n${prompt}\n\nEnd with a concise account of what you actually verified and the task/review IDs.`,
  );
  const timeout = setTimeout(() => child.kill('SIGTERM'), 600_000);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  }).finally(async () => {
    clearTimeout(timeout);
    output.end();
    errors.end();
    await Promise.all([finished(output), finished(errors)]);
  });
  summary.push({ phase, threadId, exitCode, toolCalls: calls.length, calls });
  console.log(JSON.stringify({ phase, status: 'finished', exitCode, toolCalls: calls.length }));
  assert.equal(exitCode, 0, `${phase}: Codex exited unsuccessfully; inspect ${runDirectory}`);
  assert.ok(threadId, `${phase}: no fresh Codex session observed`);
  const required: Record<Phase, string[]> = {
    producer: [
      'workflow.assignment',
      'workflow.begin',
      'artifact.create',
      'artifact.read',
      'task.create',
      'task.context',
      'task.submit_delivery',
      'task.get',
    ],
    reviewer: [
      'workflow.assignment',
      'workflow.begin',
      'task.get',
      'review.get',
      'artifact.read',
      'review.start',
      'task.context',
      'review.submit',
    ],
    observer: ['task.get', 'review.get', 'artifact.read'],
  };
  for (const tool of ['workflow.status_and_next', ...required[phase]])
    assert.ok(
      calls.some(
        (call) =>
          call.tool === tool &&
          call.status === 'completed' &&
          !call.errorCode &&
          !call.transportError,
      ),
      `${phase}: missing successful ${tool}`,
    );
  const refused: Record<Phase, string> = {
    producer: 'review.start',
    reviewer: 'artifact.create',
    observer: 'actor.create',
  };
  assert.ok(
    calls.some((call) => call.tool === refused[phase] && call.errorCode === 'forbidden'),
    `${phase}: missing server-enforced permission denial for ${refused[phase]}`,
  );
}

async function run() {
  const directory = join(runDirectory, 'data');
  const secretName = 'MERV_LIVE_SHARED_IDENTITY_SECRET';
  const previousSecret = process.env[secretName];
  const secret = randomBytes(48).toString('base64url');
  if (sharedIdentity) process.env[secretName] = secret;
  const openApp = () => {
    if (!sharedIdentity) return createApp({ directory, api: true, port: 0 });
    const config = loadConfiguration({ directory, api: true, port: 0 });
    config.entries.find((entry) => entry.id === 'identity')!.config = {
      supabaseUrl: 'https://live-identity.example.test',
      mode: 'hs256',
      secretEnv: secretName,
    };
    return createApp({ directory, config: { plugins: config.entries } });
  };
  let app = await openApp();
  try {
    type TestActor = { actor: Actor; token: string; credential?: ActorCredential; key?: UserKey };
    const owners = new Map<string, { principal: HumanPrincipal; token: string }>();
    const originalKeys = new Map<string, UserKey>();
    const memberEpochs = new Map<string, string>();
    const human = async (subject: string) => {
      const token = await new SignJWT({ role: 'authenticated' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('https://live-identity.example.test/auth/v1')
        .setAudience('authenticated')
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret));
      const principal = await app.ctx.scope.acceptVerifiedIdentity(
        await app.ctx.identity.verify(token),
      );
      return { token, principal };
    };
    let operator: TestActor & { project: Project };
    let operatorPrincipal: HumanPrincipal | undefined;
    let caller: Caller;
    if (sharedIdentity) {
      const verified = await human('test-operator');
      operatorPrincipal = verified.principal;
      const project = await app.ctx.scope.createProject(operatorPrincipal, {
        name: 'Shared identity live acceptance',
        requestId: 'live-project',
      });
      selectedProject = project.id;
      caller = await app.ctx.scope.caller(operatorPrincipal, project.id);
      operator = {
        actor: await app.ctx.scope.require(caller, 'admin'),
        project,
        token: verified.token,
      };
    } else {
      operator = await app.ctx.scope.bootstrap({
        projectName: 'Codex live acceptance',
        actorName: 'Test operator',
      });
      caller = { actorId: operator.actor.id, projectId: operator.project.id };
    }
    const participant = async (name: string, role: Role): Promise<TestActor> => {
      if (!sharedIdentity)
        return await app.ctx.scope.issueActor(caller, {
          name,
          role,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      const verified = await human(`test-${role}`);
      await app.ctx.scope.addMember(operatorPrincipal!, caller.projectId, {
        subject: verified.principal.user.subject,
        role,
      });
      const memberActor = await app.ctx.scope.require(
        await app.ctx.scope.caller(verified.principal, caller.projectId),
        'read',
      );
      owners.set(memberActor.id, verified);
      if (userKeys) {
        const response = await fetch(`${app.ctx.api.url}/account/keys`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${verified.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            projectId: caller.projectId,
            grantScope: role === 'producer' ? 'account' : 'project',
            label: name,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        });
        assert.equal(response.status, 200);
        const issued = (await response.json()) as { key: UserKey; token: string };
        assert.equal(issued.key.grantScope, role === 'producer' ? 'account' : 'project');
        originalKeys.set(memberActor.id, issued.key);
        const keyCaller = await app.ctx.scope.caller(
          { kind: 'key', key: await app.ctx.scope.authenticateKey(issued.token) },
          caller.projectId,
        );
        assert.equal(keyCaller.actorId, memberActor.id);
        memberEpochs.set(memberActor.id, keyCaller.key!.membershipId);
        return { actor: memberActor, ...issued };
      }
      return {
        token: verified.token,
        actor: memberActor,
      };
    };
    let producer = await participant('Fresh Codex producer', 'producer');
    let reviewer = await participant('Fresh Codex reviewer', 'reviewer');
    const observer = await participant('Fresh Codex observer', 'reader');
    writeFileSync(
      join(runDirectory, 'credentials.json'),
      JSON.stringify({ operator, producer, reviewer, observer }, null, 2) + '\n',
      { mode: 0o600 },
    );
    await codex(
      'producer',
      producer.token,
      app.ctx.api.url!,
      'You are the producer. Create one task titled "Verify arithmetic evidence". Its goal is "Verify the sum and mean of 2, 4, 6, 8." Its two Done-when checks are exactly "Sum equals 20" and "Mean equals 5". Create the task without briefId so the server renders its immutable numbered brief; read the returned brief through artifact.read. Before doing the work, call workflow.assignment for the task and inspect its complete context preview. Follow guidance by calling workflow.begin with instanceId and expectedRevision; use the returned context, then repeat workflow.begin with identical inputs to verify the same first-start identity and unchanged revision. Also call task.context with purpose work, this taskId, expectedRevision and a stable requestId, and use the returned starting context. Compute the result yourself. Store a separate immutable Markdown delivery explaining the calculation. Submit it for independent review with one structured confirmation per numbered acceptance check. Each confirmation must include checkNumber, status "met" only if verified, the delivery artifact ID in evidenceIds, and nonblank notes explaining how you verified that check. Use artifactIds for your evidence; the server appends its generated assessment. After submission, call task.get explicitly to verify the persisted task is in_review, then refresh workflow.status_and_next. Attempt review.start as this producer, confirm access is refused, and leave the task awaiting a separate reviewer. Use stable unique request IDs and the current task revision. Do not create actor credentials.',
    );
    let task = (await app.ctx.tasks.list(caller))[0];
    assert.ok(task, 'Producer did not create a task');
    assert.equal(task.workflow.state, 'in_review');
    assert.ok(task.reviewId);
    const firstTaskId = task.id,
      firstReviewId = task.reviewId;
    assert.equal((await app.ctx.reviews.get(caller, firstReviewId)).status, 'requested');
    // Rotation changes the bearer generation, not attribution or pending workflow state.
    for (const phase of sharedIdentity ? [] : (['producer', 'reviewer'] as const)) {
      const previous = phase === 'producer' ? producer : reviewer;
      const replacement = await app.ctx.scope.rotateCredential(caller, {
        credentialId: previous.credential!.id,
      });
      assert.equal(replacement.actor.id, previous.actor.id);
      assert.equal(replacement.credential.projectId, previous.credential!.projectId);
      assert.equal(replacement.credential.expiresAt, previous.credential!.expiresAt);
      assert.equal(replacement.credential.previousId, previous.credential!.id);
      const denied = await fetch(`${app.ctx.api.url}/tools`, {
        headers: { authorization: `Bearer ${previous.token}` },
      });
      assert.equal(denied.status, 401, 'Old bearer must lose access immediately after rotation');
      await denied.arrayBuffer();
      if (phase === 'producer') producer = replacement;
      else reviewer = replacement;
    }
    if (userKeys) {
      for (const previous of [producer, reviewer]) {
        const owner = owners.get(previous.actor.id)!;
        const response = await fetch(`${app.ctx.api.url}/account/keys/${previous.key!.id}/rotate`, {
          method: 'POST',
          headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(response.status, 200);
        const replacement = (await response.json()) as { key: UserKey; token: string };
        assert.equal(replacement.key.previousId, previous.key!.id);
        assert.equal(replacement.key.grantScope, previous.key!.grantScope);
        assert.equal(replacement.key.projectId, previous.key!.projectId);
        assert.equal(replacement.key.expiresAt, previous.key!.expiresAt);
        assert.deepEqual(replacement.key.owner, previous.key!.owner);
        const principal = {
          kind: 'key' as const,
          key: await app.ctx.scope.authenticateKey(replacement.token),
        };
        assert.equal(
          (await app.ctx.scope.caller(principal, caller.projectId)).actorId,
          previous.actor.id,
        );
        const denied = await fetch(`${app.ctx.api.url}/tools`, {
          headers: {
            authorization: `Bearer ${previous.token}`,
            'x-merv-project-id': caller.projectId,
          },
        });
        assert.equal(denied.status, 401);
        await denied.arrayBuffer();
        if (previous.actor.id === producer.actor.id)
          producer = { actor: previous.actor, ...replacement };
        else reviewer = { actor: previous.actor, ...replacement };
      }
    }
    if (sharedIdentity) {
      const other = await app.ctx.scope.createProject(operatorPrincipal!, {
        name: 'Read-only second project',
        requestId: 'other-project',
      });
      await app.ctx.scope.addMember(operatorPrincipal!, other.id, {
        subject: 'test-producer',
        role: 'reader',
      });
      if (userKeys) {
        await app.ctx.scope.addMember(operatorPrincipal!, other.id, {
          subject: 'test-reviewer',
          role: 'reader',
        });
        const confined = await fetch(`${app.ctx.api.url}/tools`, {
          headers: { authorization: `Bearer ${reviewer.token}`, 'x-merv-project-id': other.id },
        });
        assert.equal(
          confined.status,
          403,
          'Project key cannot reach another valid owner membership',
        );
        await confined.arrayBuffer();
      }
      const headers = {
        authorization: `Bearer ${producer.token}`,
        'x-merv-project-id': other.id,
        'content-type': 'application/json',
      };
      const identity = await fetch(`${app.ctx.api.url}/tools/actor.whoami`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      assert.equal(identity.status, 200);
      const otherActor = (await identity.json()).result;
      assert.equal(otherActor.role, 'reader');
      assert.notEqual(otherActor.id, producer.actor.id);
      const denied = await fetch(`${app.ctx.api.url}/tools/artifact.create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Must not exist', content: 'Denied role probe' }),
      });
      assert.equal(denied.status, 403);
      await denied.arrayBuffer();
      const isolated = await fetch(`${app.ctx.api.url}/tools/artifact.read`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ artifactId: task.deliveryIds[0] }),
      });
      assert.equal(isolated.status, 404);
      await isolated.arrayBuffer();
    }
    writeFileSync(
      join(runDirectory, 'credentials.json'),
      JSON.stringify({ operator, producer, reviewer, observer }, null, 2) + '\n',
      { mode: 0o600 },
    );

    await app.stop();
    app = await openApp();
    assert.equal((await app.ctx.tasks.get(caller, firstTaskId)).reviewId, firstReviewId);
    console.log(
      JSON.stringify({ phase: 'restart-before-review', status: 'verified', taskId: firstTaskId }),
    );
    await codex(
      'reviewer',
      reviewer.token,
      app.ctx.api.url!,
      `You are an independent reviewer of task ${firstTaskId}, review ${firstReviewId}. The server has restarted since submission. Before claiming the review, call workflow.assignment to inspect the open review packet; verify its handoff asks you to claim. Call task.get and review.get explicitly to read the task and pinned review criteria, then read the brief and every delivery artifact, including the generated structured assessment, through artifact.read. Check both numbered confirmations against their cited evidence and verify the arithmetic independently. Claim the review with review.start, retain its claimId and include it in review.submit. After claiming, follow the guidance to call workflow.begin with instanceId and current expectedRevision; use the returned full review context and verify its claimId. Repeat workflow.begin to confirm the same first-start identity and unchanged revision. Before deciding the verdict, also call task.context with purpose review, this taskId, the claimId, current expectedRevision and a stable requestId; use the returned context for the assignment. Submit pass only if the evidence meets both checks. Supply a plain single-paragraph synopsis of 40–420 characters summarizing your independent verdict, plus exactly one finding for each pinned criterion: criterionNumber 1 or 2, status met only if independently verified, evidenceIds citing the actual delivery you read, and notes explaining your calculation for that check. Include overall verification notes as well. Do not copy the producer confirmations as a substitute for checking them yourself. Use the task workflow revision for expectedRevision. Verify the task reaches done. Attempt to create a task artifact as this reviewer and confirm permission is denied. Do not create actor credentials.`,
    );
    task = await app.ctx.tasks.get(caller, firstTaskId);
    assert.equal(task.workflow.state, 'done');
    assert.equal(task.workflow.revision, 2);
    const review = await app.ctx.reviews.get(caller, firstReviewId);
    assert.equal(review.verdict, 'pass');
    assert.equal(review.reviewerId, reviewer.actor.id);
    assert.notEqual(review.reviewerId, review.producerId);
    await app.stop();
    app = await openApp();
    await codex(
      'observer',
      observer.token,
      app.ctx.api.url!,
      `You are a read-only observer after a second server restart. Call task.get for ${firstTaskId}, review.get for ${firstReviewId}, and artifact.read for every retained delivery artifact, including the generated assessment. Verify the task is done at revision 2 and the passing verdict is from a different actor than the producer. Attempt actor.create with role operator and confirm access is denied. Do not perform any successful mutations.`,
    );
    const finalTask = await app.ctx.tasks.get(caller, firstTaskId);
    assert.equal(finalTask.workflow.state, 'done');
    assert.equal(
      (await app.ctx.tasks.list(caller)).length,
      1,
      'Expected exactly one synthetic task',
    );
    assert.equal(
      new Set(summary.map((phase) => phase.threadId)).size,
      3,
      'Expected three distinct Codex instances',
    );
    const evidenceChecks = verifyLiveEvidence(
      finalTask,
      await app.ctx.reviews.get(caller, firstReviewId),
      {
        reviewer: readFileSync(join(runDirectory, 'reviewer.jsonl'), 'utf8'),
        observer: readFileSync(join(runDirectory, 'observer.jsonl'), 'utf8'),
      },
    );
    if (userKeys) {
      const owner = owners.get(producer.actor.id)!;
      const account = {
        kind: 'key' as const,
        key: await app.ctx.scope.authenticateKey(producer.token),
      };
      const second = (await app.ctx.scope.projects(account)).find(
        (project) => project.id !== caller.projectId,
      )!;
      assert.ok(second, 'The account key reaches a membership added after issuance');
      const captured = await app.ctx.scope.caller(account, caller.projectId);
      await app.ctx.scope.removeMember(
        operatorPrincipal!,
        caller.projectId,
        owner.principal.user.subject,
      );
      await assert.rejects(async () => await app.ctx.scope.require(captured, 'read'), {
        code: 'membership_required',
      });
      assert.equal(
        (await app.ctx.scope.require(await app.ctx.scope.caller(account, second.id), 'read')).role,
        'reader',
      );
      const owned = await fetch(`${app.ctx.api.url}/account/keys`, {
        headers: { authorization: `Bearer ${owner.token}` },
      });
      assert.equal(owned.status, 200);
      assert.ok(
        ((await owned.json()).keys as UserKey[]).some((key) => key.id === producer.key!.id),
      );
      const rotated = await fetch(`${app.ctx.api.url}/account/keys/${producer.key!.id}/rotate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(
        rotated.status,
        200,
        'An account key can rotate using another current membership',
      );
      const successor = (await rotated.json()) as { key: UserKey; token: string };
      assert.equal(successor.key.projectId, caller.projectId, 'Issuance provenance does not move');
      assert.equal(
        (
          await app.ctx.scope.caller(
            { kind: 'key', key: await app.ctx.scope.authenticateKey(successor.token) },
            second.id,
          )
        ).projectId,
        second.id,
      );
      const revoked = await fetch(
        `${app.ctx.api.url}/account/keys/${originalKeys.get(producer.actor.id)!.id}`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${owner.token}` },
        },
      );
      assert.equal(revoked.status, 200);
      await revoked.arrayBuffer();
      await assert.rejects(async () => await app.ctx.scope.authenticateKey(successor.token), {
        code: 'unauthorized',
      });
      assert.ok(
        await app.ctx.scope.authenticateKey(reviewer.token),
        'Revocation leaves independent keys intact',
      );
      assert.equal(
        (
          await app.ctx.scope.require(
            await app.ctx.scope.caller(owner.principal, second.id),
            'read',
          )
        ).role,
        'reader',
      );
    }
    const events = await app.ctx.state.events(caller.projectId);
    if (userKeys) {
      for (const [actorId, key] of [
        [producer.actor.id, originalKeys.get(producer.actor.id)!],
        [reviewer.actor.id, reviewer.key!],
      ] as const) {
        const writes = events.filter(
          (event) => event.actorId === actorId && !event.type.startsWith('actor.'),
        );
        assert.ok(writes.length > 0);
        for (const event of writes)
          assert.deepEqual(event.data.source, {
            kind: 'user-key',
            keyId: key.id,
            membershipId: memberEpochs.get(actorId),
          });
      }
    }
    const starts = await app.ctx.workflows.workStarts(caller, firstTaskId);
    assert.deepEqual(
      starts.map((start) => [start.revision, start.actorId]),
      [
        [0, producer.actor.id],
        [1, reviewer.actor.id],
      ],
      'Both fresh agents must begin their own revision and retain attribution across restarts',
    );
    assert.deepEqual(finalTask.workStarts, starts);
    const startEvents = events.filter((event) => event.type === 'workflow.work_started');
    assert.deepEqual(
      startEvents.map((event) => event.id),
      starts.map((start) => start.eventId),
    );
    for (const phase of ['producer', 'reviewer'] as const) {
      assert.ok(
        summary
          .find((run) => run.phase === phase)!
          .calls.filter(
            (call) =>
              call.tool === 'workflow.begin' &&
              call.status === 'completed' &&
              !call.errorCode &&
              !call.transportError,
          ).length >= 2,
        `${phase} must actually repeat begin without duplicating the activation`,
      );
    }
    const assignmentChecks = {
      bothAgentsReadAssignments: true,
      bothAgentsRepeatedBegin: true,
      exactlyTwoStartEvents: true,
      startsSurvivedTwoRestarts: true,
      startAttributionMatchesActors: true,
    };
    const report = {
      status: 'passed',
      directory: runDirectory,
      schema,
      evidenceChecks,
      assignmentChecks,
      ...(userKeys
        ? {
            userKeyChecks: {
              humanOwnerHttpIssuance: true,
              accountAndProjectGrants: true,
              explicitMcpProjectSelection: true,
              twoWorkerKeyRotations: true,
              oldBearersRefusedOverHttp: true,
              attributionGrantAndExpiryPreserved: true,
              rotatedReviewerAuthenticatedAfterRestart: true,
              currentAndFutureMembershipRoles: true,
              crossProjectArtifactRefused: true,
              ownerCanManageAfterLeavingIssuanceProject: true,
              accountRotationUsingAnotherMembership: true,
              ancestorRevocationKillsLaterSuccessor: true,
              independentKeyAndHumanLoginPreserved: true,
              domainWritesRetainKeyAndMembershipProvenance: true,
            },
          }
        : sharedIdentity
          ? {
              sharedIdentityChecks: {
                signedJwtAuthentication: true,
                independentMemberActors: true,
                explicitMcpProjectSelection: true,
                sameUserHasDifferentRoleInSecondProject: true,
                crossProjectArtifactRefused: true,
                memberReviewerAuthenticatedAfterRestart: true,
              },
            }
          : {
              credentialChecks: {
                projectBoundCredentials: true,
                expiringWorkerCredentials: true,
                twoCredentialRotations: true,
                oldBearersRefusedOverHttp: true,
                attributionPreserved: true,
                expiryPreserved: true,
                rotatedReviewerAuthenticatedAfterRestart: true,
              },
            }),
      phases: summary,
      protocolObservations,
      task: finalTask,
      review: await app.ctx.reviews.get(caller, firstReviewId),
      history: await app.ctx.workflows.history(caller, firstTaskId),
      events,
    };
    await app.stop();
    writeFileSync(join(runDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(
      JSON.stringify({
        status: 'passed',
        report: join(runDirectory, 'report.json'),
        phases: summary,
        taskId: firstTaskId,
      }),
    );
  } finally {
    await app.stop();
    if (sharedIdentity) {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
    }
  }
}
run().catch((error) => {
  writeFileSync(
    join(runDirectory, 'failure.json'),
    JSON.stringify(
      { message: error.message, stack: error.stack, schema, phases: summary },
      null,
      2,
    ) + '\n',
  );
  console.error(error);
  process.exitCode = 1;
});
