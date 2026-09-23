import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { check, type Data, type WorkflowAssignmentRule } from '@merv/contracts';
import type {} from '@merv/code-research/types';
import { MachineRunner } from '@merv/runner';
import { createApp } from '../src/app.js';
import { useRunSchema } from './database.js';

// Explicit native-model acceptance on synthetic data. This seals a commit for actual
// Reviews through production owner routing; it does not implement reflection consolidation or central publication.
const directory = resolve(process.argv[2] ?? `live-runs/code-proposals-${Date.now()}`);
const schema = useRunSchema(directory);
mkdirSync(directory, { recursive: false, mode: 0o700 });
const repository = join(directory, 'source');
mkdirSync(repository);
const gitEnv = {
  PATH: process.env.PATH,
  HOME: directory,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', env: gitEnv }).trim();
git('init', '-b', 'main');
writeFileSync(join(repository, 'answer.txt'), '0\n');
git('add', '.');
git(
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.test',
  'commit',
  '-m',
  'Initial input',
);
const initialOid = git('rev-parse', 'HEAD');
const app = await createApp({ directory: join(directory, 'server'), api: true, port: 0 });
const boot = await app.ctx.scope.bootstrap({
  projectName: 'Native proposal and review routing acceptance',
  actorName: 'Owner',
});
const source = {
  projectId: boot.project.id,
  actorId: boot.actor.id,
  credentialId: boot.credential.id,
};
const credentialEnv = 'MERV_NATIVE_CODE_SOURCE';
const previous = process.env[credentialEnv];
process.env[credentialEnv] = boot.token;
const criteria = [
  'The committed answer.txt contains exactly 42 followed by one newline; independently calculate 6*7 to verify it.',
  'The read-only checkout HEAD and its tree match the immutable producer commit receipt, with a clean worktree.',
];
const rule = (state: 'work' | 'review'): WorkflowAssignmentRule => {
  const readOnly = state === 'review';
  return {
    state,
    check: async ({ caller, tx }) => {
      await app.ctx.scope.require(caller, readOnly ? 'review' : 'write', tx);
    },
    references: async ({ caller, snapshot, tx }) => {
      if (!readOnly) return {};
      const review = await app.ctx.reviews.get(caller, String(snapshot.data.reviewId), tx);
      return {
        code: String(snapshot.data.code),
        reviewId: review.id,
        proposalArtifactId: String(snapshot.data.proposalArtifactId),
        artifacts: review.artifactIds,
        ...(review.claimId ? { claimId: review.claimId } : {}),
      };
    },
    build: async ({ caller, snapshot, tx }) => {
      const review = readOnly
        ? await app.ctx.reviews.get(caller, String(snapshot.data.reviewId), tx)
        : null;
      const tools = readOnly
        ? ['review.get', 'artifact.read', 'review.submit']
        : ['code.commit', 'code.operation', 'artifact.create', 'step.propose'];
      return {
        role: readOnly ? 'reviewer' : 'producer',
        label: readOnly
          ? 'Independently review the exact producer commit'
          : 'Implement and commit a small change',
        brief: readOnly
          ? `You are the independent reviewer. Your lease already owns review ${review!.id}, claim ${review!.claimId}. Call review.get for the criteria and artifact.read for every pinned review artifact, including proposal manifest ${snapshot.data.proposalArtifactId}. Use the local shell to independently calculate 6*7, inspect the exact bytes of answer.txt, and check git rev-parse HEAD, git rev-parse HEAD^{tree}, and git status --porcelain. The checkout must be pinned to ${snapshot.data.code}, and HEAD/tree must match the immutable receipt. Do not change files or run Git mutations. Submit review.submit with reviewId, claimId, expectedRevision:1, requestId:"verdict", verdict, notes, a plain one-paragraph synopsis of 40–420 characters with no entity IDs, and findings: one entry per numbered criterion with criterionNumber, status, evidenceIds:["${snapshot.data.proposalArtifactId}"], and notes explaining your actual checks. Only pass if both checks are met; use needs_changes or fail if not. Then stop.`
          : 'Use the local shell to replace answer.txt with exactly 42 followed by one newline, and verify it. Run git rev-parse HEAD to read the full current commit ID. Request code.commit with that expectedHead, message:"Set the verified answer to 42", and requestId:"answer-commit". Do not run git add, git commit, git merge or write Git metadata yourself. The owning runner executes this fixed commit request while you remain alive. Poll code.operation with the returned command.id until succeeded or failed. If queued or dispatched, briefly wait in the shell before polling again. If succeeded, create a text artifact describing your actual calculation, exact bytes check and the successful commit receipt. Call step.propose with that commandId and artifactIds containing your validation artifact ID; the production Code service seals an immutable proposal manifest and the fixture domain requests real independent review under your worker identity in one transaction. Do not modify files after requesting the commit. After step.propose succeeds, stop immediately.',
        references: [],
        handoff: {
          instruction: `Call ${readOnly ? 'review.submit' : 'step.propose'}, then stop.`,
          tools: [readOnly ? 'review.submit' : 'step.propose'],
        },
        execution: { readOnly, tools: tools.map((name) => ({ name, arguments: {} })) },
        context: null,
      };
    },
    execution: {
      readOnly,
      tools: readOnly
        ? [
            {
              name: 'review.get',
              alternatives: [{ reviewId: { kind: 'reference', name: 'reviewId' } }],
            },
            {
              name: 'artifact.read',
              alternatives: [{ artifactId: { kind: 'oneOf', name: 'artifacts' } }],
            },
            {
              name: 'review.submit',
              alternatives: [
                {
                  reviewId: { kind: 'reference', name: 'reviewId' },
                  claimId: { kind: 'reference', name: 'claimId' },
                  expectedRevision: { kind: 'target', field: 'revision' },
                },
              ],
            },
          ]
        : ['code.commit', 'code.operation', 'artifact.create', 'step.propose'].map((name) => ({
            name,
            alternatives: [{}],
          })),
      workspace: readOnly
        ? { mode: 'ephemeral', namespace: 'code-review', base: 'reference:code', retain: false }
        : {
            mode: 'persistent',
            namespace: 'code-work',
            base: 'central',
            retain: true,
            perBase: false,
            advancesCentral: false,
          },
    },
    lease: {
      role: async ({ caller, tx }): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => {
        await app.ctx.scope.require(caller, readOnly ? 'review' : 'write', tx);
        return readOnly ? 'reviewer' : 'producer';
      },
      acquire: async ({ caller, snapshot, tx }): Promise<Data> => {
        if (!readOnly) return {};
        const review = await app.ctx.reviews.start(caller, String(snapshot.data.reviewId), tx);
        return { reviewId: review.id, claimId: review.claimId!, actorId: caller.actorId };
      },
      check: async ({ caller, tx }, receipt) => {
        if (!readOnly) return;
        const review = await app.ctx.reviews.get(caller, String(receipt.reviewId), tx);
        check(
          review.status === 'started' &&
            review.reviewerId === caller.actorId &&
            review.claimId === receipt.claimId,
          'stale_claim',
          'The reviewer must still own the exact claim',
          409,
        );
      },
      release: async ({ lease, reason, tx }) => {
        if (!readOnly) return;
        await app.ctx.reviews.releaseClaim(
          {
            projectId: lease.projectId,
            reviewId: String(lease.receipt.reviewId),
            claimId: String(lease.receipt.claimId),
            actorId: lease.actorId,
            reason,
          },
          tx,
        );
      },
    },
  };
};
const program = await app.ctx.workflows.register(
  {
    name: 'native-code-proposals',
    version: 1,
    managed: true,
    initial: 'work',
    states: ['work', 'review', 'done', 'rejected'],
    terminal: ['done', 'rejected'],
    edges: [
      { from: 'work', action: 'propose', to: 'review' },
      { from: 'review', action: 'approve', to: 'done' },
      { from: 'review', action: 'reject', to: 'rejected' },
    ],
  },
  {
    successStates: ['done'],
    actions: [
      {
        name: 'propose',
        states: ['work'],
        transitions: ['propose'],
        tool: 'step.propose',
        instruction: 'Seal the successful commit for independent review.',
        check: async ({ caller, tx }) => {
          await app.ctx.scope.require(caller, 'write', tx);
        },
      },
      ...['approve', 'reject'].map((name) => ({
        name,
        states: ['review'],
        transitions: [name],
        tool: 'review.submit',
        instruction: 'Apply the independent review.',
        check: async ({ caller, tx }: Parameters<WorkflowAssignmentRule['check']>[0]) => {
          await app.ctx.scope.require(caller, 'review', tx);
        },
      })),
    ],
    assignments: [rule('work'), rule('review')],
  },
);
const target = await program.start(source, {
  workflow: 'native-code-proposals',
  requestId: 'start',
});
const handles = [
  app.ctx.tools.register({
    name: 'step.propose',
    description:
      'Seal your succeeded code operation into immutable evidence and request an independent review. No central publication occurs.',
    inputSchema: z
      .object({
        commandId: z.string().min(1),
        artifactIds: z.array(z.string().min(1)).min(1).max(10),
      })
      .strict(),
    handler: async (caller, input) =>
      await app.ctx.state.transaction(async (tx) => {
        await app.ctx.scope.require(caller, 'write', tx);
        const operation = await app.ctx.codeResearch.operation(caller, input.commandId);
        check(
          operation.status === 'succeeded' && operation.receipt,
          'commit_required',
          'Wait for the runner commit receipt',
          409,
        );
        check(
          operation.command.actorId === caller.actorId &&
            operation.command.sessionId === caller.session?.id &&
            operation.command.instanceId === target.id &&
            operation.command.expectedRevision === 0,
          'forbidden',
          'The proposal must use this worker’s own exact operation',
          403,
        );
        const proposal = await app.ctx.codeResearch.seal(
          caller,
          {
            commandId: input.commandId,
            summary: 'Set the verified answer to 42',
            artifactIds: input.artifactIds,
            provenance: { fixture: 'native-code-proposals', criteria },
            requestId: 'seal-proposal',
          },
          { tool: 'step.propose', input },
          tx,
        );
        const artifact = proposal.manifestArtifact;
        const review = await app.ctx.reviews.request(
          caller,
          {
            subjectId: target.id,
            subjectRevision: 1,
            producerId: proposal.producer.actorId,
            administrativeActorId: (await app.ctx.scope.authorityActor(caller, tx)).id,
            artifactIds: [...proposal.artifacts.map((item) => item.id), artifact.id],
            criteria,
            formatVersion: 2,
            requestId: 'review-code',
          },
          tx,
        );
        return await program.transition(
          caller,
          {
            instanceId: target.id,
            expectedRevision: 0,
            action: 'propose',
            requestId: 'propose',
            data: {
              reviewId: review.id,
              proposalArtifactId: artifact.id,
              code: proposal.receipt.headOid,
              proposalId: proposal.id,
              proposalHash: proposal.manifestHash,
              commandId: operation.command.id,
            },
          },
          tx,
        );
      }),
  }),
  app.ctx.reviews.registerSubmitOwner({
    id: 'native-code-proposals',
    owns: async (review) => review.projectId === source.projectId && review.subjectId === target.id,
    submit: async (caller, input, tx) => {
      const snapshot = await app.ctx.workflows.get(caller, target.id, tx);
      check(
        snapshot.state === 'review' &&
          snapshot.data.reviewId === input.reviewId &&
          input.expectedRevision === snapshot.revision,
        'stale_review',
        'This is not the current proposal review',
        409,
      );
      const proposal = await app.ctx.codeResearch.proposal(
        caller,
        String(snapshot.data.proposalId),
        tx,
      );
      const session = await app.ctx.sessions.describe(caller);
      check(
        proposal.manifestHash === snapshot.data.proposalHash &&
          proposal.receipt.headOid === snapshot.data.code &&
          session.execution.policy.readOnly &&
          session.runnerId === proposal.command.runnerId &&
          session.workspace?.attachment.repositoryId === proposal.receipt.repositoryId &&
          session.workspace.attachment.headOid === proposal.receipt.headOid,
        'proposal_workspace_mismatch',
        'Review the exact proposal in its repository-owning runner',
        409,
      );
      const review = await app.ctx.reviews.get(caller, input.reviewId, tx);
      check(
        review.producerId === proposal.producer.actorId &&
          review.artifactIds.includes(proposal.manifestArtifact.id),
        'stale_review',
        'Review must pin the sealed proposal author and manifest',
        409,
      );
      await app.ctx.reviews.submit(
        caller,
        {
          reviewId: input.reviewId,
          claimId: input.claimId,
          verdict: input.verdict,
          notes: input.notes,
          synopsis: input.synopsis,
          findings: input.findings,
          requestId: input.requestId,
        },
        tx,
      );
      return await program.transition(
        caller,
        {
          instanceId: target.id,
          expectedRevision: snapshot.revision,
          action: input.verdict === 'pass' ? 'approve' : 'reject',
          requestId: input.requestId,
        },
        tx,
      );
    },
  }),
];
const runner = new MachineRunner({
  directory: join(directory, 'machine'),
  baseUrl: app.ctx.api.url!,
  projectId: boot.project.id,
  credentialEnv,
  workspace: { repository, baseRef: 'refs/heads/main' },
  capacity: 1,
  pollIntervalMs: 500,
  profiles: [
    {
      name: 'native-codex',
      harness: 'codex',
      executable: process.env.MERV_CODEX_BIN ?? 'codex',
      enabled: true,
      parallelism: 1,
    },
  ],
});
try {
  await runner.start();
  await app.ctx.sessions.setDispatch(source, { enabled: true });
  const deadline = Date.now() + 12 * 60_000;
  let last = '';
  while (true) {
    await app.ctx.domainEvents.drain();
    const state = (await app.ctx.workflows.get(source, target.id)).state;
    const snapshot = runner.snapshot();
    const summary = JSON.stringify({
      state,
      runnerState: snapshot.state,
      error: snapshot.lastError,
      launches: snapshot.launches.map(({ id, status, workspace }) => ({ id, status, workspace })),
    });
    if (summary !== last) {
      console.log(summary);
      last = summary;
    }
    if (
      ['done', 'rejected'].includes(state) &&
      snapshot.launches.length === 2 &&
      snapshot.launches.every((launch) => launch.workspace?.status === 'closed')
    )
      break;
    assert.ok(Date.now() < deadline, 'Native code review timed out');
    assert.ok(
      snapshot.launches.length <= 2,
      'Acceptance requires exactly two fresh agents; inspect retained failure logs',
    );
    await delay(1000);
  }
  await app.ctx.sessions.setDispatch(source, { enabled: false });
  await runner.stop();
  const final = await app.ctx.workflows.get(source, target.id);
  const review = await app.ctx.reviews.get(source, String(final.data.reviewId));
  const proposalArtifact = await app.ctx.artifacts.read(
    source,
    String(final.data.proposalArtifactId),
  );
  const proposal = await app.ctx.codeResearch.proposal(source, String(final.data.proposalId));
  const operation = await app.ctx.codeResearch.operation(source, String(final.data.commandId));
  const sessions = (await app.ctx.sessions.list(source)).sort(
    (a, b) => a.expectedRevision - b.expectedRevision,
  );
  assert.equal(final.state, 'done', `Independent review verdict: ${review.verdict}`);
  assert.equal(sessions.length, 2);
  assert.equal(review.status, 'submitted');
  assert.equal(review.verdict, 'pass');
  assert.equal(review.producerId, sessions[0].actorId);
  assert.equal(review.reviewerId, sessions[1].actorId);
  assert.notEqual(review.producerId, review.reviewerId);
  assert.ok(sessions.every((session) => session.actorId !== source.actorId));
  assert.equal(proposalArtifact.artifact.createdBy, sessions[0].actorId);
  assert.equal(proposal.producer.actorId, sessions[0].actorId);
  assert.equal(proposal.manifestHash, final.data.proposalHash);
  assert.equal(proposal.manifestArtifact.hash, proposal.manifestHash);
  assert.deepEqual(JSON.parse(proposalArtifact.content).receipt, operation.receipt);
  assert.equal(operation.command.actorId, sessions[0].actorId);
  assert.equal(operation.command.sessionId, sessions[0].id);
  assert.equal(operation.status, 'succeeded');
  const committed = operation.receipt!.headOid;
  assert.notEqual(committed, initialOid);
  assert.equal(operation.receipt!.parentOid, initialOid);
  assert.equal(sessions[0].workspace!.attachment.baseOid, initialOid);
  assert.equal(sessions[0].workspace!.result!.headOid, committed);
  assert.equal(sessions[1].workspace!.attachment.baseOid, committed);
  assert.equal(sessions[1].workspace!.result!.headOid, committed);
  assert.equal(git('rev-parse', 'HEAD'), initialOid);
  assert.equal(readFileSync(join(repository, 'answer.txt'), 'utf8'), '0\n');
  const bare = join(directory, 'machine/workspaces/repository.git');
  const managedGit = (...args: string[]) =>
    execFileSync('git', ['--git-dir', bare, ...args], { encoding: 'utf8', env: gitEnv });
  assert.equal(managedGit('rev-parse', 'refs/merv/central').trim(), initialOid);
  assert.equal(managedGit('rev-parse', `${committed}^{tree}`).trim(), operation.receipt!.treeOid);
  assert.equal(managedGit('show', `${committed}:answer.txt`), '42\n');
  assert.ok(
    runner
      .snapshot()
      .launches.every(
        (launch) =>
          ['exited', 'stopped'].includes(launch.status) && launch.workspace?.status === 'closed',
      ),
  );
  const walk = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)],
    );
  const phases = walk(join(directory, 'machine/launches'))
    .filter((path) => path.endsWith('/stdout.log'))
    .map((path) => {
      const events = readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      return {
        log: path,
        threadId: events.find((event) => event.type === 'thread.started')?.thread_id,
        shellCalls: events.filter(
          (event) => event.type === 'item.completed' && event.item?.type === 'command_execution',
        ).length,
        calls: events
          .filter(
            (event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call',
          )
          .map((event) => ({
            tool: event.item.tool,
            status: event.item.status,
            failed: !!event.item.error || event.item.result?.isError === true,
            artifactId:
              event.item.tool === 'artifact.read' ? event.item.arguments?.artifactId : undefined,
          })),
      };
    });
  assert.equal(new Set(phases.map((phase) => phase.threadId).filter(Boolean)).size, 2);
  assert.ok(phases.every((phase) => phase.shellCalls > 0));
  const calls = phases.flatMap((phase) => phase.calls);
  for (const name of [
    'code.commit',
    'code.operation',
    'artifact.create',
    'step.propose',
    'review.get',
    'artifact.read',
    'review.submit',
  ])
    assert.ok(
      calls.some((call) => call.tool === name && !call.failed),
      `Missing successful ${name}`,
    );
  assert.deepEqual(
    [
      ...new Set(
        calls
          .filter((call) => call.tool === 'artifact.read' && !call.failed)
          .map((call) => call.artifactId),
      ),
    ].sort(),
    [...review.artifactIds].sort(),
    'The reviewer must read every pinned artifact through the actual MCP service',
  );
  const totals = {
    agents: phases.length,
    shellCalls: phases.reduce((sum, phase) => sum + phase.shellCalls, 0),
    toolCalls: calls.length,
    failedToolCalls: calls.filter((call) => call.failed).length,
  };
  const report = {
    passed: true,
    schema,
    ...totals,
    initialOid,
    committedOid: committed,
    sourceUnchanged: true,
    centralUnchanged: true,
    workflow: final,
    review,
    proposal,
    proposalArtifact: proposalArtifact.artifact,
    operation,
    sessions,
    phases,
    runner: runner.snapshot(),
    limits: [
      'Synthetic domain uses production Code.seal and Reviews.apply; no standalone Code workflow',
      'Synthetic verdict handler lacks command replay after transition; production Tasks replay is tested separately',
      'One machine and private object store',
      'No reflection proposal coverage or central publication',
    ],
  };
  const output = JSON.stringify(report, null, 2);
  assert.ok(!output.includes(boot.token));
  writeFileSync(join(directory, 'report.json'), output + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: true, ...totals, report: join(directory, 'report.json') }));
} finally {
  await runner.stop();
  for (const handle of handles) await handle();
  program.dispose();
  await app.stop();
  if (previous === undefined) delete process.env[credentialEnv];
  else process.env[credentialEnv] = previous;
}
