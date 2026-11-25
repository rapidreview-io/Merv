/**
 * One job end to end on the default composition, with the machine faked: the person proposes and
 * runs it, the Mac's writer (a hand offer, never dispatch) pushes a branch and hands in its
 * commit, Merv's machine step runs it under a read-only run grant, and a fresh reviewer accepts
 * it with the next job. Stop waits for the machine's release; the cap refuses a run that does
 * not fit.
 */
import type { AutoresearchService } from '@merv/autoresearch';
import type { Caller } from '@merv/contracts';
import type { JobsService, JobView } from '@merv/jobs';
import {
  runScript,
  SandboxesMachine,
  type JobMachine,
  type MachineProgress,
  type MachineRun,
} from '@merv/jobs/machine';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { secret, twoStepWorkflow } from './fixtures/session-workflow.js';

/** Git as a test runs it, asynchronously: the server answering it runs in this process. */
function git(cwd: string, args: string[]) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn('/usr/bin/git', args, {
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Mac',
        GIT_AUTHOR_EMAIL: 'mac@example.test',
        GIT_COMMITTER_NAME: 'Mac',
        GIT_COMMITTER_EMAIL: 'mac@example.test',
      },
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (code) => resolve({ code: code ?? 1, out: out.trim() }));
  });
}
const code = (error: unknown) => (error as { code?: string }).code;
type Allowance = {
  allowance: { capUsd: number; committedUsd: number; leftUsd: number } | null;
  allowanceReason: string | null;
};

async function fixture(t: TestContext) {
  const f = await twoStepWorkflow(t, 'jobs');
  const { app, owner, token, ok, http } = f;
  const service = app.ctx.jobs as unknown as JobsService;
  await waitForManagedCode(app.ctx.codeWork, owner);
  const remote = `${app.ctx.api.url}/git/${owner.projectId}.git`;
  const bearer = (value: string) => ['-c', `http.extraHeader=Authorization: Bearer ${value}`];
  const work = await mkdtemp(join(tmpdir(), 'merv-jobs-mac-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  await git(work, ['init', '-q', '-b', 'main', '.']);
  /** The Mac's writer: a commit pushed to its own branch of the project's Merv git. */
  const push = async (branch: string, body: string) => {
    await writeFile(join(work, 'train.py'), body);
    await git(work, ['add', '.']);
    await git(work, ['commit', '-q', '-m', body]);
    const pushed = await git(work, [
      ...bearer(token),
      'push',
      '-q',
      remote,
      `HEAD:refs/heads/${branch}`,
    ]);
    assert.equal(pushed.code, 0, pushed.out);
    return (await git(work, ['rev-parse', 'HEAD'])).out;
  };

  // The machine, faked: each attempt starts once, minting its grant then; the test says how it ends.
  const grants: { url: string; token: string }[] = [];
  const runs: MachineRun[] = [];
  let ending: MachineProgress['state'] = 'running';
  let started = false;
  let released = true;
  let releases = 0;
  const machine: JobMachine = {
    linked: async () => true,
    advance: async (_caller, run, grant) => {
      if (!runs.some((item) => item.jobId === run.jobId && item.attempt === run.attempt)) {
        runs.push(run);
        grants.push(await grant());
      }
      return {
        state: ending,
        started: started || ending !== 'running',
        workflowId: `wf_${run.attempt}`,
        captureArtifactId: null,
        final: ending === 'running' ? null : { step: 400, loss: 0.31 },
        error: null,
      };
    },
    live: async (_caller, jobId, attempt) =>
      runs.some((item) => item.jobId === jobId && item.attempt === attempt)
        ? { step: 10, loss: 1.5 }
        : null,
    release: async () => {
      releases++;
      return released ? { costUsd: 0.42 } : null;
    },
  };
  service.machine = machine;
  // What Sandboxes says the project has spent, against autoresearch's default $20 cap, and since when.
  let spent: number | null = 0;
  const windows: (string | null)[] = [];
  const autoresearch = app.ctx.autoresearch as unknown as AutoresearchService;
  autoresearch.spendSource = {
    since: async (_projectId, since) => {
      windows.push(since);
      if (spent === null) throw new Error('Sandboxes is unreachable');
      return { usd: spent };
    },
  };

  const call = async <T = JobView>(name: string, caller: Caller, input: Record<string, unknown>) =>
    (await app.ctx.tools.call(name, caller, input)) as T;
  const get = async (jobId: string) =>
    await call<{ job: JobView; live: Record<string, number> | null } & Allowance>(
      'job.read:get',
      owner,
      { jobId },
    );
  const propose = async (title = 'Dropout sweep', estimateUsd = 1.2) =>
    await call('job.write:propose', owner, {
      title,
      goal: 'Does dropout help small transformers?',
      doneMeans: 'Validation loss for dropout 0 and 0.1, with a verdict.',
      command: 'python train.py',
      minutes: 20,
      estimateUsd,
      requestId: randomUUID(),
    });
  const move = async (action: 'run' | 'stop', job: JobView) =>
    await call(`job.write:${action}`, owner, {
      jobId: job.id,
      expectedRevision: job.revision,
      requestId: randomUUID(),
    });
  /** The Mac's offer and attach of the job's current step, as POST /sessions/offer. */
  const offer = async (job: JobView) => {
    const input = {
      instanceId: job.id,
      expectedRevision: job.revision,
      runnerId: 'mac-desk',
      requestId: randomUUID(),
      secret: secret(),
    };
    const { session } = await ok('POST', '/sessions/offer', token, input);
    const control = { runnerId: 'mac-desk', hostRef: `mac-${randomUUID()}` };
    const attached = await ok('POST', `/sessions/${session.id}/attach`, token, control);
    const worker = await f.sessions.authenticate(input.secret);
    return { session: attached.session, prompt: attached.prompt, worker, control };
  };
  return {
    ...f,
    app,
    owner,
    http,
    service,
    remote,
    bearer,
    work,
    push,
    grants,
    runs,
    setEnding: (state: MachineProgress['state']) => void (ending = state),
    setStarted: (value: boolean) => void (started = value),
    setReleased: (value: boolean) => void (released = value),
    releases: () => releases,
    setSpent: (usd: number | null) => {
      spent = usd;
      // A page's read may be 15 s old: the next one asks Sandboxes again.
      (autoresearch as unknown as { spent: Map<string, unknown> }).spent.clear();
    },
    windows,
    call,
    get,
    propose,
    move,
    offer,
  };
}

test('jobs: plan on the Mac, run the exact commit, review fresh, propose the next', async (t) => {
  const f = await fixture(t);
  const { app, owner, call } = f;

  let job = await f.propose();
  assert.equal(job.state, 'proposed');
  // What is left under the cap, as Run will admit it: autoresearch's default $20, nothing spent.
  assert.deepEqual((await f.get(job.id)).allowance, { capUsd: 20, committedUsd: 0, leftUsd: 20 });
  assert.deepEqual(
    job.steps.map((step) => step.place),
    ['mac', 'machine', 'mac'],
  );
  job = await f.move('run', job);
  assert.equal(job.state, 'writing');
  // Only the person's own Mac takes the writing step: dispatch never offers it to a machine.
  const candidates = await app.ctx.workflows.dispatchCandidates(owner);
  assert.ok(!candidates.some((item) => item.instanceId === job.id));

  const writer = await f.offer(job);
  assert.equal(writer.session.assignment.role, 'producer');
  // On the Mac the app pushes and hands in: the agent only commits and ends its turn.
  assert.match(writer.session.assignment.brief, /commit it on the branch you were given/);
  assert.match(writer.session.assignment.brief, /Do not push/);
  assert.doesNotMatch(writer.session.assignment.brief, /job\.submit_code/);
  // The writer may not move the job as a person, nor review it.
  await assert.rejects(
    call('job.write:stop', writer.worker, {
      jobId: job.id,
      expectedRevision: job.revision,
      requestId: 'x',
    }),
  );
  await assert.rejects(
    call('job.review', writer.worker, {
      jobId: job.id,
      expectedRevision: job.revision,
      verdict: 'accept',
      commitRead: 'a'.repeat(40),
      summary: 'Fine.',
      requestId: randomUUID(),
    }),
  );
  // A person is not the job's writer.
  await assert.rejects(
    call('job.submit_code', owner, {
      jobId: job.id,
      expectedRevision: job.revision,
      ref: 'desk-run/x',
      commit: 'a'.repeat(40),
      requestId: randomUUID(),
    }),
    (error) => code(error) === 'job_worker_only' || code(error) === 'forbidden',
  );

  const commit = await f.push('desk-run/dropout-1', 'print("METRIC {\\"loss\\": 1}")\n');
  const submit = (ref: string, sha: string) =>
    call('job.submit_code', writer.worker, {
      jobId: job.id,
      expectedRevision: job.revision,
      ref,
      commit: sha,
      requestId: randomUUID(),
    });
  // Merv checks the branch points at the commit handed in.
  await assert.rejects(
    submit('desk-run/nowhere', commit),
    (e) => code(e) === 'job_commit_mismatch',
  );
  await assert.rejects(
    submit('desk-run/dropout-1', 'b'.repeat(40)),
    (e) => code(e) === 'job_commit_mismatch',
  );
  job = await submit('desk-run/dropout-1', commit);
  assert.equal(job.state, 'running');
  assert.deepEqual(job.code, { ref: 'desk-run/dropout-1', commit });

  // The machine step starts the commit, with a read-only grant of this project only.
  await f.service.tick();
  assert.equal(f.runs.length, 1);
  assert.deepEqual(
    [f.runs[0]!.ref, f.runs[0]!.commit, f.runs[0]!.gpu, f.runs[0]!.maxCostUsd],
    ['desk-run/dropout-1', commit, 'T4', 1.2 * 1.5],
  );
  const grant = f.grants[0]!;
  assert.equal(grant.url, f.remote);
  const fetched = await git(f.work, [
    ...f.bearer(grant.token),
    'ls-remote',
    grant.url,
    'refs/heads/desk-run/dropout-1',
  ]);
  assert.equal(fetched.code, 0, fetched.out);
  assert.match(fetched.out, new RegExp(commit));
  const pushed = await git(f.work, [
    ...f.bearer(grant.token),
    'push',
    '-q',
    grant.url,
    'HEAD:refs/heads/desk-run/evil',
  ]);
  assert.match(pushed.out, /error: 403/, 'a run grant cannot write');
  // The machine's own script, run here: it fetches exactly the commit, and stops if it moved.
  const machine = async () => {
    const root = await mkdtemp(join(tmpdir(), 'merv-jobs-gpu-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return await new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn('/bin/sh', ['-c', runScript('git rev-parse HEAD; env', root)], {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          MERV_GIT_URL: grant.url,
          MERV_GIT_TOKEN: grant.token,
          MERV_GIT_REF: 'desk-run/dropout-1',
          MERV_GIT_COMMIT: commit,
        },
      });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      child.on('close', (exit) => resolve({ code: exit ?? 1, out }));
    });
  };
  const ran = await machine();
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.out, new RegExp(`^${commit}$`, 'm'));
  assert.doesNotMatch(ran.out, new RegExp(grant.token), 'the command never sees the token');
  await f.push('desk-run/dropout-1', 'print("moved")\n');
  const moved = await machine();
  assert.equal(moved.code, 97);
  assert.match(moved.out, /code changed/);
  // Started on the machine: the record says so at the next tick, before the run ends.
  assert.equal((await f.get(job.id)).job.run!.state, 'starting');
  f.setStarted(true);
  await f.service.tick();
  const running = await f.get(job.id);
  assert.equal(running.job.run!.state, 'running');
  assert.equal(running.job.run!.workflowId, 'wf_2');
  assert.deepEqual(running.live, { step: 10, loss: 1.5 });
  // A running job holds its estimate.
  assert.deepEqual(running.allowance, { capUsd: 20, committedUsd: 1.2, leftUsd: 18.8 });
  await f.ok('POST', `/sessions/${writer.session.id}/release`, f.token, { runnerId: 'mac-desk' });

  // The run ends: its cost and final readings are recorded, the machine released, the grant gone.
  f.setEnding('succeeded');
  await f.service.tick();
  job = (await f.get(job.id)).job;
  assert.equal(job.state, 'reviewing');
  assert.equal(job.run!.state, 'succeeded');
  assert.equal(job.run!.costUsd, 0.42);
  assert.deepEqual(job.run!.final, { step: 400, loss: 0.31 });
  assert.equal(job.run!.machineReleased, true);
  // Its cost counts against the cap at once, even before Sandboxes' report shows it; the
  // report counts when it says more. A project with no round reads its spend since ever.
  assert.deepEqual((await f.get(job.id)).allowance, {
    capUsd: 20,
    committedUsd: 0.42,
    leftUsd: 19.58,
  });
  f.setSpent(1);
  assert.deepEqual((await f.get(job.id)).allowance, { capUsd: 20, committedUsd: 1, leftUsd: 19 });
  f.setSpent(0);
  assert.ok(f.windows.length > 0 && f.windows.every((since) => since === null));
  const revoked = await git(f.work, [...f.bearer(grant.token), 'ls-remote', grant.url]);
  assert.notEqual(revoked.code, 0, 'the grant ends with the run');
  assert.doesNotMatch(revoked.out, /error: 403/);

  // A fresh agent reviews, read-only, bound to the commit it read.
  const reviewer = await f.offer(job);
  assert.equal(reviewer.session.assignment.role, 'reviewer');
  assert.notEqual(reviewer.session.actorId, writer.session.actorId);
  assert.equal(reviewer.session.execution.policy.readOnly, true);
  assert.match(reviewer.session.assignment.brief, /VERDICT: pass.*VERDICT: needs changes/);
  assert.match(reviewer.session.assignment.brief, new RegExp(commit));
  assert.doesNotMatch(reviewer.session.assignment.brief, /job\.review/);
  await assert.rejects(
    call('job.submit_code', reviewer.worker, {
      jobId: job.id,
      expectedRevision: job.revision,
      ref: 'desk-run/dropout-1',
      commit,
      requestId: randomUUID(),
    }),
  );
  const review = (commitRead: string, verdict = 'accept', next?: unknown) =>
    call('job.review', reviewer.worker, {
      jobId: job.id,
      expectedRevision: job.revision,
      verdict,
      commitRead,
      summary: 'Dropout 0.1 lowers validation loss.',
      ...(next ? { next } : {}),
      requestId: randomUUID(),
    });
  await assert.rejects(review('c'.repeat(40)), (e) => code(e) === 'job_commit_stale');
  const next = {
    title: 'Dropout 0.2',
    goal: 'Does more dropout help?',
    doneMeans: 'Validation loss at dropout 0.2.',
    command: 'python train.py --dropout 0.2',
    minutes: 20,
    estimateUsd: 1.2,
  };
  job = await review(commit, 'accept', next);
  assert.equal(job.state, 'done');
  assert.equal(job.result!.verdict, 'accept');
  assert.equal(job.result!.commitRead, commit);
  const proposed = (await f.get(job.result!.nextJobId!)).job;
  assert.equal(proposed.state, 'proposed');
  assert.equal(proposed.previousJobId, job.id);
  assert.deepEqual(
    (await call<{ jobs: JobView[] }>('job.read:list', owner, {})).jobs.map((item) => item.id),
    [proposed.id, job.id],
  );
});

test('jobs: stop waits for the machine release; the cap refuses a run that does not fit', async (t) => {
  const f = await fixture(t);
  const { call } = f;

  // Stopped while running: stopping until every machine is released, then stopped.
  let job = await f.move('run', await f.propose());
  const writer = await f.offer(job);
  const commit = await f.push('desk-run/stop-1', 'print(1)\n');
  job = await call('job.submit_code', writer.worker, {
    jobId: job.id,
    expectedRevision: job.revision,
    ref: 'desk-run/stop-1',
    commit,
    requestId: randomUUID(),
  });
  await f.service.tick();
  f.setReleased(false);
  job = await f.move('stop', job);
  assert.equal(job.state, 'stopping');
  assert.equal(job.run!.machineReleased, false);
  await f.service.tick();
  assert.ok(f.releases() > 0);
  assert.equal((await f.get(job.id)).job.state, 'stopping');
  f.setReleased(true);
  await f.service.tick();
  job = (await f.get(job.id)).job;
  assert.equal(job.state, 'stopped');
  assert.equal(job.run!.state, 'cancelled');
  assert.equal(job.run!.machineReleased, true);
  assert.equal(job.run!.costUsd, 0.42, 'a stopped run records what its machine cost');
  const revoked = await git(f.work, [...f.bearer(f.grants[0]!.token), 'ls-remote', f.remote]);
  assert.notEqual(revoked.code, 0);

  // Stopped while writing: at once, and the writer's lease no longer holds.
  let writing = await f.move('run', await f.propose('Second'));
  const second = await f.offer(writing);
  writing = await f.move('stop', writing);
  assert.equal(writing.state, 'stopped');
  const late = await f.push('desk-run/late-1', 'print(2)\n');
  await assert.rejects(
    call('job.submit_code', second.worker, {
      jobId: writing.id,
      expectedRevision: writing.revision - 1,
      ref: 'desk-run/late-1',
      commit: late,
      requestId: randomUUID(),
    }),
  );

  // $19 of the $20 cap spent: a $2 run does not fit and nothing starts; a $0.50 one does.
  f.setSpent(19);
  const dear = await f.propose('Dear', 2);
  const listed = await call<{ jobs: JobView[] } & Allowance>('job.read:list', f.owner, {});
  assert.deepEqual(listed.allowance, { capUsd: 20, committedUsd: 19, leftUsd: 1 });
  assert.equal(listed.allowanceReason, null);
  await assert.rejects(f.move('run', dear), (error) => {
    assert.equal(code(error), 'job_cap_reached');
    assert.match(
      (error as Error).message,
      /\$2\.00 does not fit under the project's cap of \$20\.00/,
    );
    return true;
  });
  assert.equal((await f.get(dear.id)).job.state, 'proposed');
  assert.equal((await f.move('run', await f.propose('Cheap', 0.5))).state, 'writing');
  // Spend Sandboxes does not report: no allowance, a plain reason, and Run refused.
  f.setSpent(null);
  const unknown = await f.get(dear.id);
  assert.equal(unknown.allowance, null);
  assert.match(unknown.allowanceReason!, /did not say what this project has spent/);
  await assert.rejects(f.move('run', dear), (error) => code(error) === 'job_spend_unavailable');
});

test('jobs: a read-only key reads a running job before any machine tick, writing nothing', async (t) => {
  const f = await fixture(t);
  const { app, owner, call } = f;
  // No machine tick runs: the jobs service actor does not exist yet when the job is read.
  const tick = f.service.tick;
  f.service.tick = async () => {};
  let job = await f.move('run', await f.propose());
  const writer = await f.offer(job);
  const commit = await f.push('desk-run/read-1', 'print(1)\n');
  job = await call('job.submit_code', writer.worker, {
    jobId: job.id,
    expectedRevision: job.revision,
    ref: 'desk-run/read-1',
    commit,
    requestId: randomUUID(),
  });
  const reader = await app.ctx.scope.credentials.issueActor(owner, {
    name: 'Reader',
    role: 'reader',
  });
  const before = await app.ctx.state.transaction((tx) =>
    tx.get<{ n: string }>('SELECT count(*) AS n FROM actors WHERE project_id=?', owner.projectId),
  );
  const read = await f.http('POST', '/tools/job.read', reader.token, {
    action: 'get',
    get: { jobId: job.id },
  });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.result.job.state, 'running');
  assert.equal(read.body.result.job.run.state, 'starting');
  assert.deepEqual(read.body.result.live, null, 'nothing has started on the machine yet');
  const listed = await f.http('POST', '/tools/job.read', reader.token, { action: 'list' });
  assert.equal(listed.status, 200, listed.text);
  const after = await app.ctx.state.transaction((tx) =>
    tx.get<{ n: string }>('SELECT count(*) AS n FROM actors WHERE project_id=?', owner.projectId),
  );
  assert.equal(after!.n, before!.n, 'a read creates no actor');
  f.service.tick = tick;
});

test('jobs: the machine step is one capped pipeline scoped to the job, its token only in env', async () => {
  const submitted: { request: Record<string, any>; principal: Record<string, unknown> }[] = [];
  const released: unknown[] = [];
  const link = { namespace: 'ns', account_id: 'acct', member_id: 'mem' };
  let machines: Record<string, unknown>[] = [];
  const sbx = {
    sbxRegistry: { list: async () => machines },
    sbxMerv: {
      linked: async () => link,
      principal: async (_caller: Caller, _need: string, work: Record<string, string>) => ({
        namespace: 'ns',
        account_id: 'acct',
        work_ref: work.workRef,
        attempt_ref: work.attemptRef,
      }),
      releaseWork: async (_caller: Caller, work: unknown) => {
        released.push(work);
        return true;
      },
    },
    sbxPipelines: {
      list: async () => ({ workflows: [], next: null }),
      submit: async (input: (typeof submitted)[number]) => {
        submitted.push(input);
        return { id: 'wf_1', state: 'running', nodes: {} };
      },
    },
  };
  const machine = new SandboxesMachine(sbx as never);
  const caller = { projectId: 'project_1', actorId: 'actor_service' };
  const progress = await machine.advance(
    caller,
    {
      jobId: 'wf_job',
      attempt: 3,
      gpu: 'T4',
      minutes: 20,
      command: 'python train.py',
      maxCostUsd: 1.8,
      ref: 'desk-run/dropout-1',
      commit: 'a'.repeat(40),
    },
    async () => ({ url: 'https://merv.example/git/project_1.git', token: 'mg_secret' }),
  );
  assert.deepEqual(progress, {
    state: 'running',
    started: false,
    workflowId: 'wf_1',
    captureArtifactId: null,
    final: null,
    error: null,
  });
  const [{ request, principal }] = submitted;
  // Scoped to the job, so Stop's release reaches it; capped at 1.5 times the estimate.
  assert.deepEqual([principal.work_ref, principal.attempt_ref], ['wf_job', 'a3']);
  assert.equal(String(request.max_cost), '1.80');
  assert.deepEqual(
    request.nodes.map((node: { id: string; kind: string; when: string }) => [node.kind, node.when]),
    [
      ['provision', 'success'],
      ['run', 'success'],
      ['capture', 'always'],
      ['release', 'always'],
    ],
  );
  assert.equal(request.nodes[0].cleanup, 'always');
  assert.equal(request.nodes[0].request.requirements.gpu, 'T4');
  const run = request.nodes[1].job;
  assert.equal(run.env.MERV_GIT_TOKEN, 'mg_secret');
  assert.equal(run.env.MERV_GIT_COMMIT, 'a'.repeat(40));
  assert.doesNotMatch(run.command, /mg_secret/);
  assert.match(run.command, /'python train\.py'/);
  // Released once the attempt's machines have stopped, with what they cost; others are not its.
  const usd = (amount: string) => ({ currency: 'USD', amount });
  machines = [
    { attempt_ref: 'a3', state: 'deleting', cost_so_far: usd('0.05') },
    { attempt_ref: 'a2', state: 'stopped', cost_so_far: usd('1.00') },
  ];
  assert.equal(await machine.release(caller, 'wf_job', 3), null);
  machines[0] = { attempt_ref: 'a3', state: 'stopped', cost_so_far: usd('0.0985') };
  assert.deepEqual(await machine.release(caller, 'wf_job', 3), { costUsd: 0.0985 });
  assert.deepEqual(released[0], { namespace: 'ns', accountId: 'acct', workRef: 'wf_job' });
});
