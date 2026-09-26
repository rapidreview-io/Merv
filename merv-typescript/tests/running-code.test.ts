import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import { CodeService } from '@merv/code-research/service';
import type { CodeCapture } from '@merv/code-research/types';
import codeUiPlugin from '@merv/code-research/ui';
import { checkNode, hasCheck, OVERDUE_GRACE_MS } from '@merv/code-research/running';
import { CodeRepositories } from '@merv/code/store/repository';
import {
  createService,
  personMove,
  type Caller,
  type RunningNode,
  type RunningSection,
  type WorkflowSnapshot,
} from '@merv/contracts';
import { UiRegistry, type RunningContribution } from '@merv/ui';
import { runningBoard, runningPanel, type RunningSources } from '@merv/ui/running';
import type { SandboxCheckHandle, SandboxChecks } from '@merv/sandboxes';
import { baseFixture } from './fixtures/code-bases.js';
import { boundProject } from './fixtures/code-binding.js';
import { git, gitSource } from './fixtures/code-store.js';
import { resolutionFixture } from './fixtures/resolution.js';
import { assessment } from './fixtures/review-verdict.js';
import { config as githubConfig, githubFixture } from './github-fixture.js';

/**
 * Code's part of the Running page, read the way ui.running reads it: through the code-ui
 * adapter, inside one read-only snapshot, each part behind its own savepoint. A project Code
 * hosts, with the GitHub App faked at its seam, accepts real units and opens a real pull
 * request; the few rows no fixture here can reach otherwise (a blocker on work that has ended,
 * a check's machine) are written as their owner writes them.
 */

async function fixture(t: TestContext) {
  const f = await resolutionFixture(t, { human: true });
  const remote = await githubFixture(t, f.state, f.admin);
  await remote.enable();
  const root = join(f.directory, 'code');
  mkdirSync(join(root, 'tmp'), { recursive: true });
  mkdirSync(join(root, 'empty-template'));
  const repositories = new CodeRepositories({ root, quotaBytes: 1024 ** 3, reservedFreeBytes: 1 });
  await repositories.ensure(f.admin.projectId, 'repository', 'sha1');
  const code = await createService(
    new CodeService(
      f.state,
      f.scope,
      f.sessions,
      f.artifacts,
      f.workflows,
      githubConfig,
      remote.fetcher,
      {
        config: { root, settleMs: 60_000, reservedFreeBytes: 1 },
        mirror: {
          target: async () => ({ repository: 'fixture/private' }),
          lsRemote: async (_project: string, ref: string) =>
            remote.branches.get(ref.replace('refs/heads/', '')) ?? null,
          push: async (_project: string, update: { ref: string; oid: string }) => {
            remote.branches.set(update.ref.replace('refs/heads/', ''), update.oid);
            return 'ok' as const;
          },
        },
        mirrorConfig: { mirrorSeconds: 0 },
        // Nothing merges or steps a check behind the test's back: a row written here stays.
        autoMerge: false,
      },
    ),
  );
  const source = gitSource(t);
  const bare = repositories.paths(f.admin.projectId).repository;
  const root0 = source.commit({ 'own.txt': 'root\n' });
  const feature = source.commit({ 'own.txt': 'feature\n' });
  source.git('checkout', '--detach', root0);
  const other = source.commit({ 'other.txt': 'other\n' });
  for (const [name, commit] of Object.entries({ root0, feature, other }))
    source.git('push', bare, `${commit}:refs/heads/${name}`);
  await boundProject(f.state, f.admin.projectId, root0, 'repository');
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE code_projects SET store_json=?,main_json=? WHERE project_id=?',
      JSON.stringify({ format: 1, objectFormat: 'sha1', rootOid: root0 }),
      JSON.stringify({
        oid: root0,
        operationId: 'fixture',
        admittedBy: 'fixture',
        admittedAt: 'now',
        stored: true,
      }),
      f.admin.projectId,
    ),
  );
  remote.branches.set('main', root0);
  const handle = await f.workflows.register(
    {
      name: 'input',
      version: 1,
      managed: true,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'accept', to: 'done' }],
    },
    {
      successStates: ['done'],
      actions: [
        {
          name: 'accept',
          tool: 'input.accept',
          instruction: 'Accept.',
          states: ['working'],
          transitions: ['accept'],
          check: () => {},
        },
      ],
    },
  );
  let sequence = 0;
  const id = () => `request-${++sequence}`;
  const actor = async (
    name: string,
    role: 'operator' | 'producer' | 'reader',
  ): Promise<Caller> => ({
    projectId: f.admin.projectId,
    actorId: (await f.scope.issueActor(f.admin, { name, role })).actor.id,
  });
  const producer = await actor('Producer', 'operator');
  const captures = new Map<string, CodeCapture>();
  const original = code.capture.bind(code);
  t.mock.method(code, 'capture', async (...args: Parameters<CodeService['capture']>) =>
    args[1].kind === 'code-commit' && captures.has(args[1].commandId!)
      ? captures.get(args[1].commandId!)!
      : original(...args),
  );
  const start = (name: string) =>
    handle.start(f.admin, {
      workflow: 'input',
      requestId: id(),
      data: { title: name, goal: `Deliver ${name}` },
    });
  const declare = async (name: string) => {
    const work = await start(name);
    await f.state.transaction((tx) => code.declareUnit(f.admin, work.id, tx));
    return work;
  };
  const move = (work: WorkflowSnapshot) =>
    handle.transition(f.admin, {
      instanceId: work.id,
      action: 'accept',
      expectedRevision: work.revision,
      requestId: `accept-${work.id}`,
    });
  /** Acceptance as a passing review leaves it: an admitted upload, then the owner's record. */
  const accept = async (work: WorkflowSnapshot, commit: string) => {
    const commandId = `capture-${work.id}`;
    captures.set(commandId, {
      ref: { kind: 'code-commit', commandId },
      status: 'ready',
      provenance: {
        projectId: f.admin.projectId,
        instanceId: work.id,
        readOnly: false,
      } as CodeCapture['provenance'],
      workspace: {
        repositoryId: 'repository',
        workspaceId: work.id,
        mode: 'persistent',
        branch: null,
        baseOid: root0,
        headOid: commit,
        treeOid: git(bare, ['rev-parse', `${commit}^{tree}`]),
        stats: { commitCount: 1, filesChanged: 1, insertions: 1, deletions: 0 },
      },
      observedAt: 'now',
      eventId: null,
    });
    const evidence = await f.artifacts.create(producer, {
      title: 'Evidence',
      content: 'The delivered change was checked against its goal.',
    });
    const request = await f.reviews.request(producer, {
      subjectId: work.id,
      subjectRevision: work.revision,
      producerId: producer.actorId,
      artifactIds: [evidence.id],
      criteria: ['The change works.'],
      requestId: `review-${work.id}`,
    });
    const claim = await f.reviews.start(f.admin, request.id);
    await f.reviews.submit(f.admin, {
      reviewId: request.id,
      claimId: claim.claimId!,
      verdict: 'pass',
      notes: 'Checked the delivered change.',
      ...assessment(claim),
      requestId: `pass-${request.id}`,
    });
    const done = await move(work);
    await f.state.transaction(async (tx) => {
      await tx.run(
        "UPDATE code_units SET generation=1,writer_state='closed',head_oid=? WHERE project_id=? AND unit_id=?",
        commit,
        f.admin.projectId,
        work.id,
      );
      await tx.run(
        "INSERT INTO code_operations(id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at,unit_id) VALUES (?,?,'fixture',?,'upload','hash','{}','completed',?,'now','now',?)",
        commandId,
        f.admin.projectId,
        commandId,
        JSON.stringify({ head: commit }),
        work.id,
      );
    });
    await f.state.transaction((tx) =>
      code.acceptUnit(
        f.admin,
        {
          unitId: work.id,
          terminalRevision: done.revision,
          submissionRef: commandId,
          reviewRef: request.id,
          codeRef: { kind: 'code-commit', commandId },
          reviewSessionId: null,
        },
        tx,
      ),
    );
  };
  /** A unit that publishes to main, accepted, whose publication has opened no pull request yet. */
  const publishing = async (name: string) => {
    await code.controlPublication(f.admin, {
      action: 'record_canary',
      staleMerged: false,
      reason: 'The release matrix passed with this App and its rules.',
      requestId: 'canary',
    });
    const work = await declare(name);
    await f.state.transaction((tx) => code.publishOnAcceptance(f.admin, { unitId: work.id }, tx));
    await f.state.transaction((tx) =>
      code.pinBase(f.admin, { unitId: work.id, leaseId: `lease-${work.id}` }, tx),
    );
    await accept(work, feature);
    return work;
  };
  const sync = async () => {
    await f.state.transaction((tx) => tx.run("UPDATE code_publications SET synced_at=''"));
    return await code.syncPublications(f.admin);
  };
  const unbind = f.tasks.bindCode(code);
  const unbindReviews = code.bindReviews(f.reviews);
  f.beforeClose.push(async () => {
    unbind();
    unbindReviews();
    await code.close();
    repositories.git.close();
  });

  // The adapter as the application composes it, registered on a UI registry of its own.
  const ctx = new Context();
  const ui = new UiRegistry();
  ctx.provide('ui', ui);
  ctx.provide('codeResearch', code);
  await ctx.plugin(codeUiPlugin);
  f.beforeClose.unshift(async () => await ctx.fiber.dispose());
  /** Code's contribution as registered, beside the other owners a test stands in for. */
  const sources = (...others: RunningContribution[]): RunningSources => ({
    contributions: () =>
      [...ui.contributions(), ...others].sort((a, b) => a.owner.localeCompare(b.owner)),
    tools: async () => [],
    isolated: (read) => f.state.isolated(read),
  });
  /** Both reads, as the tools make them: inside one read-only snapshot, where nothing writes. */
  const board = (running: RunningSources, caller: Caller = f.admin) =>
    f.state.snapshot(() => runningBoard(running, caller));
  const panel = (running: RunningSources, key: string, caller: Caller = f.admin) =>
    f.state.snapshot(() => runningPanel(running, caller, key));
  const holds = (caller: Caller = f.admin) => f.state.snapshot(() => code.runningHolds(caller));
  const blockers = async (instanceId: string) =>
    (await f.workflows.blockers(f.admin, instanceId)).filter((item) => item.provider === 'code');
  return {
    ...f,
    code,
    bare,
    root0,
    feature,
    other,
    actor,
    start,
    declare,
    move,
    accept,
    publishing,
    sync,
    sources,
    board,
    panel,
    holds,
    blockers,
  };
}

/**
 * Tasks' part as far as this slice needs it: a key another owner marked is drawn quiet as
 * done, as the tasks contribution draws a held done task, and any key named here is drawn.
 */
const tasks = (drawn: string[] = []): RunningContribution => ({
  owner: 'tasks',
  kinds: ['work'],
  lanes: ['work'],
  nodes: async (read) => ({
    nodes: [...new Set([...drawn, ...read.include])].map((key): RunningNode => ({
      key,
      lane: 'work',
      kind: 'Task',
      title: key,
      lines: [['Done']],
      look: 'quiet',
    })),
  }),
  panel: async () => ({
    header: { kind: 'Task', title: 'Publishing', says: [{ state: 'done' }] },
    sections: [],
    actions: [],
    live: false,
  }),
});

const codeOf = (sections: RunningSection[]) =>
  sections.find((section) => section.owner === 'code-research' && section.title === 'Code');

test('done work whose pull request waits for a merge is held on the board in the Code page’s own words, and only a signed-in operator is offered the merge', async (t) => {
  const f = await fixture(t);
  const work = await f.publishing('Publish the index');
  const key = `work:${work.id}`;
  const running = f.sources(tasks());

  // Before the first sync there is no pull request: nobody owes a merge yet, so nothing is
  // held, and the Code section says in ink what the work waits on.
  assert.deepEqual(await f.holds(), { marks: [], summary: null });
  const [unopened] = await f.blockers(work.id);
  const before = codeOf((await f.panel(running, key)).sections)!;
  assert.equal(before.attention, undefined);
  assert.deepEqual(before.kind === 'facts' && before.rows[0], {
    label: 'Waiting',
    value: [
      'The publication for this work has not opened its pull request yet',
      ' · ',
      'The server',
      ' · ',
      { ago: unopened.since },
    ],
  });

  const [opened] = await f.sync();
  const pull = opened.pull!;
  const [blocker] = await f.blockers(work.id);
  assert.equal(blocker.code, 'code_publication_pending');
  const move = personMove(blocker)!;
  assert.equal(move.sentence, 'Waiting on a person to merge the pull request');

  // The mark is the Code page's sentence and who ends the wait. The way to the merge is
  // offered to the signed-in operator alone; an operator's key and a reader are only told.
  const said = { key, says: [move.sentence], who: move.who };
  const merge = { route: '/code', text: 'Merge reviewed proposal' };
  assert.deepEqual(await f.holds(), { marks: [{ ...said, to: merge }], summary: null });
  const operatorKey = await f.actor('Operator key', 'operator');
  const reader = await f.actor('Reader', 'reader');
  assert.deepEqual(await f.holds(operatorKey), { marks: [said], summary: null });
  assert.deepEqual(await f.holds(reader), { marks: [said], summary: null });

  // On the board the done task, drawn by its owner only because Code marked it, stands in
  // the work lane with that attention; nothing failed, and the read wrote nothing.
  const answer = await f.board(running);
  assert.deepEqual(answer.lanes.work.nodes, [
    {
      key,
      lane: 'work',
      kind: 'Task',
      title: key,
      lines: [['Done']],
      look: 'quiet',
      attention: { says: [move.sentence], who: move.who, to: merge },
      owner: 'tasks',
    },
  ]);
  assert.equal(answer.lanes.work.needsYou, 1);
  assert.deepEqual(answer.lanes.work.summaries, []);
  for (const lane of Object.values(answer.lanes)) assert.deepEqual(lane.failed, []);
  const read = (await f.board(running, reader)).lanes.work.nodes[0];
  assert.deepEqual(read.attention, { says: [move.sentence], who: move.who });

  // Where the work has got to comes from the newest commit that succeeded for this unit: not
  // an older one, not one that failed, and not another unit's.
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const newest = at(6);
  const stats = (
    commitCount: number,
    filesChanged: number,
    insertions: number,
    deletions: number,
  ) => JSON.stringify({ stats: { commitCount, filesChanged, insertions, deletions } });
  await f.state.transaction(async (tx) => {
    for (const [id, instanceId, createdAt, status, receipt] of [
      ['cmd-older', work.id, at(120), 'succeeded', stats(1, 1, 3, 0)],
      ['cmd-newest', work.id, newest, 'succeeded', stats(3, 2, 12, 4)],
      ['cmd-failed', work.id, at(2), 'failed', null],
      ['cmd-other', 'wf_elsewhere', at(1), 'succeeded', stats(9, 9, 9, 9)],
    ] as const)
      await tx.run(
        'INSERT INTO code_commands (id,project_id,session_id,actor_id,request_id,input_hash,command_json,status,receipt_json,error) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id,
        f.admin.projectId,
        'session-fixture',
        f.admin.actorId,
        id,
        'hash',
        JSON.stringify({ instanceId, createdAt }),
        status,
        receipt,
        status === 'failed' ? 'push_rejected' : null,
      );
  });

  // The Code section leads the sidebar, above every place, with the move; then the branch,
  // the work since its base, the acceptance and the publication with its pull request.
  const unit = await f.code.unit(f.admin, work.id);
  const needs = [move.sentence, ' · ', move.who, ' · ', { ago: blocker.since }];
  const rows = (link: boolean) => [
    {
      label: 'Needs',
      value: link
        ? [...needs, ' · ', { link: { route: '/code' }, text: 'Merge reviewed proposal' }]
        : needs,
      attention: true,
    },
    { label: 'Branch', value: [{ mono: unit.branch }] },
    {
      label: 'Working',
      value: [
        { state: 'closed' },
        ' · 3 commits since base · +12 −4 in 2 files · last commit ',
        { ago: newest },
      ],
    },
    { label: 'Accepted', value: [{ ago: unit.acceptance!.acceptedAt }] },
    {
      label: 'Publication',
      value: [{ state: 'pending' }, ' · ', { link: { href: pull.url }, text: `#${pull.number}` }],
    },
  ];
  const sidebar = await f.panel(running, key);
  assert.deepEqual(sidebar.sections[0], {
    title: 'Code',
    place: 'code',
    attention: true,
    owner: 'code-research',
    kind: 'facts',
    rows: rows(true),
  });
  const readerSection = codeOf((await f.panel(running, key, reader)).sections)!;
  assert.deepEqual(readerSection.kind === 'facts' && readerSection.rows, rows(false));

  // Work without a unit, and keys that are not work, have no Code section.
  const plain = await f.start('No code here');
  assert.deepEqual(
    await f.state.snapshot(() =>
      f.code.runningCode(f.admin, [`work:${plain.id}`, 'session:s1', 'sandbox:sbx_1']),
    ),
    [],
  );
});

test('a move that is nobody’s holds nothing, open work is marked whatever its code, and done work is held for its publication alone, the newest twenty', async (t) => {
  const f = await fixture(t);
  const write = async (work: WorkflowSnapshot, code: string, since: string, key = 'fixture') => {
    await f.state.transaction(async (tx) => {
      await f.workflows.replaceBlockers(
        {
          projectId: f.admin.projectId,
          instanceId: work.id,
          provider: 'code',
          blockers: [
            { key, code, status: 409, message: `fixture ${code}`, next: 'Nothing.', related: [] },
          ],
        },
        tx,
      );
      await tx.run('UPDATE wf_blockers SET since=? WHERE instance_id=?', since, work.id);
    });
  };
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const ended = async (name: string) => {
    const work = await f.start(name);
    return { ...work, ...(await f.move(work)) };
  };

  // Open work, which its owner draws anyway, is marked for any person's move: main not in
  // the repository is an administrator's, a quarantine an operator's. A wait on a
  // successor is nobody's and marks nothing, and another provider's blocker is not Code's.
  const main = await f.start('Waits on main');
  await write(main, 'code_base_pending', at(50), 'main');
  const quarantined = await f.start('Quarantined');
  await write(quarantined, 'code_quarantined', at(49));
  const stale = await f.start('Stale');
  await write(stale, 'code_publication_stale', at(48));
  const other = await f.start('Other provider');
  await f.state.transaction((tx) =>
    f.workflows.replaceBlockers(
      {
        projectId: f.admin.projectId,
        instanceId: other.id,
        provider: 'sessions',
        blockers: [
          {
            key: 'k',
            code: 'code_quarantined',
            status: 409,
            message: 'm',
            next: 'n',
            related: [],
          },
        ],
      },
      tx,
    ),
  );
  // A quarantine that outlived its work holds nothing: only a publication holds done work.
  const over = await ended('Ended quarantine');
  await write(over, 'code_quarantined', at(47));

  // Twenty-two done units wait on an operator to clear a disabled publication. The newest
  // twenty are held; the other two are one line of the work lane that leads to Code.
  const done: WorkflowSnapshot[] = [];
  for (let index = 0; index < 22; index++) {
    const work = await ended(`Done ${index}`);
    await write(work, 'code_publication_disabled', at(40 - index), 'publication');
    done.push(work);
  }
  const { marks, summary } = await f.holds();
  const disabled = {
    says: ['Publication is disabled for this project until an operator clears it'],
    who: 'An operator',
  };
  assert.deepEqual(marks, [
    {
      key: `work:${main.id}`,
      says: ['Main is not in this project’s repository yet'],
      who: 'An administrator',
    },
    {
      key: `work:${quarantined.id}`,
      says: [
        'Quarantined: the code kept here cannot be used, and an operator replans the work waiting on it',
      ],
      who: 'An operator',
    },
    ...done
      .slice(2)
      .reverse()
      .map((work) => ({ key: `work:${work.id}`, ...disabled })),
  ]);
  assert.deepEqual(summary, {
    lane: 'work',
    says: [],
    attention: {
      says: [{ count: 2 }, ' more waiting on a person'],
      to: { route: '/code', text: 'Open Code' },
    },
    actions: [],
  });

  // On the board the held work and the line stand together, and the line counts once.
  const answer = await f.board(f.sources(tasks()));
  assert.deepEqual(
    answer.lanes.work.nodes.map(({ key }) => key).sort(),
    marks.map(({ key }) => key).sort(),
  );
  assert.equal(answer.lanes.work.nodes.length, 22);
  assert.deepEqual(
    answer.lanes.work.summaries.map(({ owner, attention }) => ({ owner, attention })),
    [{ owner: 'code-research', attention: summary!.attention }],
  );
  assert.equal(answer.lanes.work.needsYou, 23);
});

test('a check holding a machine is a hardware node that takes in its sandbox and checks the work it merges; its sidebar says its time and that work', async (t) => {
  const f = await fixture(t);
  const checked = await f.declare('Checked work');
  await f.accept(checked, f.feature);
  const SPEC = {
    command: 'npm test -- --ci\nnpm run lint',
    timeoutSeconds: 600,
    image: { provider: 'thunder_compute', offerId: 'a6000_x1:thunder', snapshotId: null },
  };
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE code_projects SET limits_json=? WHERE project_id=?',
      JSON.stringify({ check: SPEC }),
      f.admin.projectId,
    ),
  );
  const handle = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      sandboxId: 'sbx_check',
      jobId: 'job_1',
      objectId: 'obj_1',
      restoreJobId: null,
      sha256: 'f'.repeat(64),
      ready: true,
      environment: null,
      isolation: { network: 'on', sourceReadOnly: false, imagePinned: 'offer', facts: [] },
      epoch: 1,
      ...extra,
    });
  const key = (letter: string) => letter.repeat(64);
  // Handed off three minutes ago: the deadline is the hand-off, the timeout and the slack.
  const deadline = new Date(Date.now() + (600 + 1500 - 180) * 1000).toISOString();
  const insert = async (
    base: string,
    state: string,
    check: string,
    job: string | null,
    until: string | null = deadline,
    blocker: string | null = null,
  ) =>
    await f.state.transaction((tx) =>
      tx.run(
        "INSERT INTO code_bases (project_id,base_key,members_json,left_key,right_key,engine,state,created_at,updated_at,execution_epoch,deadline,check_state,check_job_json,blocker) VALUES (?,?,?,?,?,'fixture',?,?,?,1,?,?,?,?)",
        f.admin.projectId,
        base,
        JSON.stringify([f.feature, f.other].sort()),
        key('1'),
        key('2'),
        state,
        'now',
        'now',
        until,
        check,
        job,
        blocker,
      ),
    );
  await insert(key('a'), 'running', 'running', handle());
  await insert(key('b'), 'running', 'queued', null);
  await insert(key('c'), 'cancelled', 'running', handle({ releaseAttempts: 2 }));
  // A check still Merv's a minute past its deadline is Code's to settle on its next drain,
  // so it is said in ink; one still there past the grace is waiting on a person.
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  await insert(key('d'), 'running', 'running', handle({ sandboxId: 'sbx_late' }), ago(60_000));
  await insert(
    key('3'),
    'running',
    'running',
    handle({ sandboxId: 'sbx_stuck' }),
    ago(OVERDUE_GRACE_MS + 60_000),
  );
  // A machine Code stopped asking back for: the handle is gone, and only the blocker Code
  // wrote in the same breath names it (bases.ts reclaim).
  await insert(
    key('4'),
    'suspended',
    'none',
    null,
    deadline,
    'code_check_unreclaimed: sandbox sbx_lost could not be given back (the service answered 503)',
  );
  // Not in flight: a check that ended, one whose base stopped before it rented anything, and
  // a base that never had a check.
  await insert(key('e'), 'cancelled', 'unavailable', null);
  await insert(key('f'), 'suspended', 'queued', null);
  await insert(key('7'), 'cancelled', 'none', null);

  const checks = await f.state.snapshot(() => f.code.runningChecks(f.admin));
  const checking = [{ to: `work:${checked.id}`, verb: 'checks' }];
  const common = {
    lane: 'hardware',
    title: 'Code check',
    name: 'npm test -- --ci',
    links: checking,
  };
  assert.deepEqual(checks, [
    {
      key: `check:${key('3')}`,
      ...common,
      lines: [['Running']],
      look: 'solid',
      dot: 'live',
      attention: {
        says: ['Past its deadline'],
        who: 'An operator retries or cancels the base on Code',
      },
      units: { count: 1, busy: true },
      aliases: ['sandbox:sbx_stuck'],
    },
    {
      key: `check:${key('4')}`,
      ...common,
      lines: [['Stopped · ', { state: 'suspended' }]],
      look: 'quiet',
      attention: {
        says: ['Machine not given back'],
        who: 'An operator releases it from the sandboxes console',
      },
      units: { count: 1, busy: false },
      aliases: ['sandbox:sbx_lost'],
    },
    {
      key: `check:${key('a')}`,
      ...common,
      lines: [['Running']],
      look: 'solid',
      dot: 'live',
      units: { count: 1, busy: true },
      aliases: ['sandbox:sbx_check'],
    },
    {
      key: `check:${key('b')}`,
      ...common,
      lines: [['Starting']],
      look: 'dashed',
      dot: 'starting',
      units: { count: 1, busy: false },
    },
    {
      key: `check:${key('c')}`,
      ...common,
      lines: [['Giving machine back']],
      look: 'quiet',
      attention: {
        says: ['Giving machine back · refused ', { count: 2 }, ' times, retrying'],
        quiet: true,
      },
      units: { count: 1, busy: false },
      aliases: ['sandbox:sbx_check'],
    },
    {
      key: `check:${key('d')}`,
      ...common,
      lines: [['Running']],
      look: 'solid',
      dot: 'live',
      attention: { says: ['Past its deadline · stopping'], quiet: true },
      units: { count: 1, busy: true },
      aliases: ['sandbox:sbx_late'],
    },
  ]);

  // On the board the sandbox the check runs on folds into it, and its own attention
  // becomes the check's; the check's edge lands on the work it proves where that is drawn.
  const sandboxes: RunningContribution = {
    owner: 'sandboxes',
    kinds: ['sandbox'],
    lanes: ['hardware'],
    nodes: async () => ({
      nodes: [
        {
          key: 'sandbox:sbx_check',
          lane: 'hardware',
          title: 'A6000',
          lines: [],
          look: 'solid',
          attention: { says: ['Lease ends in 6m'], who: 'A producer or operator extends it.' },
        },
        // Idle is never red of itself: alone, the machine Code let go of would read in ink.
        {
          key: 'sandbox:sbx_lost',
          lane: 'hardware',
          title: 'A6000',
          lines: [['Idle 40m · $2.49/h']],
          look: 'solid',
        },
      ],
    }),
    panel: async (_read, sandbox, absorbedBy) =>
      sandbox === 'sandbox:sbx_check'
        ? {
            header: { kind: 'Sandbox', title: 'A6000', says: [] },
            sections: [
              {
                title: 'Machine',
                place: 'machine',
                kind: 'facts',
                rows: [{ label: 'Size', value: [absorbedBy ? 'absorbed' : 'alone'] }],
              },
            ],
            actions: [],
            live: true,
          }
        : null,
  };
  const running = f.sources(tasks([`work:${checked.id}`]), sandboxes);
  const answer = await f.board(running);
  const drawn = answer.lanes.hardware.nodes.map(({ key }) => key);
  assert.deepEqual(drawn.sort(), checks.map(({ key }) => key).sort());
  const first = answer.lanes.hardware.nodes.find(({ key: at }) => at === `check:${key('a')}`)!;
  assert.deepEqual(first.aliases, ['sandbox:sbx_check']);
  assert.deepEqual(first.attention, {
    says: ['Lease ends in 6m'],
    who: 'A producer or operator extends it.',
  });
  assert.ok(
    answer.edges.some(
      (edge) =>
        edge.from === `check:${key('a')}` &&
        edge.to === `work:${checked.id}` &&
        edge.verb === 'checks',
    ),
  );
  // The machine Code let go of is drawn once, on its check, in the red only a person ends.
  const lost = answer.lanes.hardware.nodes.find(({ key: at }) => at === `check:${key('4')}`)!;
  assert.deepEqual(lost.aliases, ['sandbox:sbx_lost']);
  assert.deepEqual(lost.attention, {
    says: ['Machine not given back'],
    who: 'An operator releases it from the sandboxes console',
  });
  // The sandbox's own lease, the check past its grace and the machine let go of need a
  // person; the check just past its deadline and the refusals being retried do not.
  assert.equal(answer.lanes.hardware.needsYou, 3);
  for (const lane of Object.values(answer.lanes)) assert.deepEqual(lane.failed, []);

  // The sidebar: when the check runs out of time, the work it checks, and the machine's own
  // sections after them. It carries no control, and its record is the merge on Code.
  const sidebar = await f.panel(running, `check:${key('a')}`);
  assert.deepEqual(sidebar.header, {
    kind: 'Code check',
    title: 'npm test -- --ci',
    says: ['Running'],
  });
  assert.deepEqual(
    sidebar.sections.map(({ title, owner }) => [title, owner]),
    [
      ['Check', 'code-research'],
      ['Checking', 'code-research'],
      ['Machine', 'sandboxes'],
    ],
  );
  assert.deepEqual(sidebar.sections[0].kind === 'facts' && sidebar.sections[0].rows, [
    { label: 'Deadline', value: [{ until: deadline }] },
    { label: 'Command', value: [{ mono: SPEC.command }] },
  ]);
  assert.deepEqual(sidebar.sections[1].kind === 'links' && sidebar.sections[1].rows, [
    {
      to: { key: `work:${checked.id}`, route: `/code/unit/${checked.id}` },
      name: 'Checked work',
    },
  ]);
  assert.deepEqual(sidebar.sections[2].kind === 'facts' && sidebar.sections[2].rows, [
    { label: 'Size', value: ['absorbed'] },
  ]);
  assert.deepEqual(sidebar.actions, []);
  assert.equal(sidebar.route, `/code/merge/${key('a')}`);
  assert.equal(sidebar.live, true);
  assert.deepEqual(sidebar.aliases, ['sandbox:sbx_check']);

  // Only the deadline is stored, so a timeout an operator raises mid-check moves nothing
  // the board or the sidebar says about it.
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE code_projects SET limits_json=? WHERE project_id=?',
      JSON.stringify({ check: { ...SPEC, timeoutSeconds: 1800 } }),
      f.admin.projectId,
    ),
  );
  assert.deepEqual(await f.state.snapshot(() => f.code.runningChecks(f.admin)), checks);
  const { observedAt: _, ...said } = sidebar;
  const { observedAt: __, ...again } = await f.panel(running, `check:${key('a')}`);
  assert.deepEqual(again, said);

  // The machine Code let go of answers with the red and the machine it names.
  const unreclaimed = await f.panel(running, `check:${key('4')}`);
  assert.deepEqual(unreclaimed.header, {
    kind: 'Code check',
    title: 'npm test -- --ci',
    says: ['Stopped · ', { state: 'suspended' }],
    attention: {
      says: ['Machine not given back'],
      who: 'An operator releases it from the sandboxes console',
    },
  });
  assert.deepEqual(unreclaimed.aliases, ['sandbox:sbx_lost']);

  // A check that ended still answers an open sidebar with its verdict, and one that stopped
  // before a verdict with where its base stopped. A base that never had a check, a key that
  // names no base, or no base of this project's, belongs to nobody here.
  const ended = await f.panel(running, `check:${key('e')}`);
  assert.deepEqual(ended.header.says, ['Ended · ', { state: 'unavailable' }]);
  assert.equal(ended.live, false);
  const stopped = await f.panel(running, `check:${key('f')}`);
  assert.deepEqual(stopped.header.says, ['Stopped · ', { state: 'suspended' }]);
  for (const nobody of [`check:${key('7')}`, `check:${key('9')}`, 'check:not-a-base'])
    await assert.rejects(f.panel(running, nobody), { code: 'running_not_found' });
});

test('the work since its base is read from the project’s newest commits alone, and its branch is sent whole for the page to shorten', async (t) => {
  const f = await fixture(t);
  const work = await f.declare('Recent work');
  await f.accept(work, f.feature);
  const rows = async () => {
    const [code] = await f.state.snapshot(() => f.code.runningCode(f.admin, [`work:${work.id}`]));
    return code.kind === 'facts' ? code.rows : [];
  };
  const row = async (label: string) => (await rows()).find((item) => item.label === label);
  const createdAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const insert = (sql: string, ...values: string[]) =>
    f.state.transaction((tx) =>
      tx.run(
        `INSERT INTO code_commands (id,project_id,session_id,actor_id,request_id,input_hash,command_json,status,receipt_json) ${sql}`,
        ...values,
      ),
    );
  const stats = JSON.stringify({
    stats: { commitCount: 2, filesChanged: 1, insertions: 5, deletions: 1 },
  });
  await insert(
    "VALUES ('cmd-unit',?,'session-fixture',?,'cmd-unit','hash',?,'succeeded',?)",
    f.admin.projectId,
    f.admin.actorId,
    JSON.stringify({ instanceId: work.id, createdAt }),
    stats,
  );
  assert.deepEqual(await row('Working'), {
    label: 'Working',
    value: [
      { state: 'closed' },
      ' · 2 commits since base · +5 −1 in 1 file · last commit ',
      { ago: createdAt },
    ],
  });

  // The branch is sent whole, since it is what an operator fetches and copies; the page
  // prints the id inside it by its head and its tail (tests/ui-running.test.ts).
  assert.deepEqual(await row('Branch'), {
    label: 'Branch',
    value: [{ mono: `merv/work/${work.id}` }],
  });

  // Two hundred newer commits of other work push this unit's out of what is read, and a row
  // behind them that no parser could read is never reached: nothing older is decoded.
  await insert(
    "VALUES ('cmd-unreadable',?,'session-probe',?,'cmd-unreadable','hash','not json','succeeded',?)",
    f.admin.projectId,
    f.admin.actorId,
    stats,
  );
  await insert(
    "SELECT 'cmd-recent-'||n,?,'session-recent',?,'cmd-recent-'||n,'hash',?,'succeeded',? FROM generate_series(1,200) AS n",
    f.admin.projectId,
    f.admin.actorId,
    JSON.stringify({ instanceId: 'wf_elsewhere', createdAt }),
    stats,
  );
  assert.deepEqual(await row('Working'), { label: 'Working', value: [{ state: 'closed' }] });
});

/**
 * A base whose check rented a machine that never came up, stopped by an operator with the
 * given action, and a service that will not take the machine back until `taken` says so.
 */
async function keptMachine(t: TestContext, action: 'suspend' | 'cancel') {
  const f = await baseFixture(t);
  const command = 'make test';
  await f.state.transaction(async (tx) => {
    const limits = JSON.stringify({
      format: 1,
      denyGlobs: [],
      secretExemptGlobs: [],
      check: {
        command,
        timeoutSeconds: 600,
        image: { provider: 'thunder_compute', offerId: 'a6000_x1:thunder', snapshotId: null },
      },
    });
    await tx.run(
      'INSERT INTO code_projects (project_id,mode,repository_id,binding_json,main_json,limits_json,warnings_json,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      f.projectId,
      'local',
      'repository-bases',
      '{}',
      '{}',
      limits,
      '[]',
      new Date().toISOString(),
    );
  });
  // A machine that never comes up, and a service that will not take it back.
  const machine: SandboxCheckHandle = {
    sandboxId: 'sbx_kept',
    objectId: 'obj_kept',
    jobId: null,
    restoreJobId: null,
    sha256: '',
    ready: false,
    environment: null,
    isolation: { network: 'on', sourceReadOnly: false, imagePinned: 'offer', facts: [] },
  };
  const service = { taken: false, asked: [] as (string | null)[] };
  const checks: SandboxChecks = {
    start: async (_projectId, spec) => ({ ...machine, sha256: spec.source.sha256 }),
    step: async (_projectId, _plan, handle) => handle,
    follow: async () => assert.fail('a machine that never came up has no job to follow'),
    release: async (_projectId, handle) => {
      service.asked.push(handle.sandboxId);
      if (!service.taken) throw new Error('the service answered 503');
    },
  };
  f.bases.checks = checks;
  const { a, b } = f.commits;
  const base = await f.state.transaction((tx) => f.bases.ensure(tx, f.projectId, [a, b]));
  for (let pass = 0; pass < 2; pass += 1) await f.bases.work(f.projectId);
  await f.bases.control(f.scope, f.admin, {
    key: base.key,
    action,
    reason: 'the operator stops this base',
    requestId: `req-${action}`,
  });
  const standing = async () => {
    const all = await f.state.read((sql) => f.bases.checking(sql, f.projectId));
    return all.find((check) => check.key === base.key);
  };
  return { f, base, command, service, standing };
}

test('a machine Code stops asking back for stays on its check, red, named by the blocker Code wrote', async (t) => {
  const { f, base, command, standing } = await keptMachine(t, 'suspend');

  // While Code still asks, each refusal is said in ink, and nobody is asked to move.
  for (let pass = 0; pass < 4; pass += 1) await f.bases.work(f.projectId);
  const asking = checkNode((await standing())!, command, [], Date.now());
  assert.deepEqual(asking.attention, {
    says: ['Giving machine back · refused ', { count: 4 }, ' times, retrying'],
    quiet: true,
  });

  // The fifth refusal lets go of the handle; the check stays, red, and takes in the machine.
  await f.bases.work(f.projectId);
  const given = (await standing())!;
  assert.equal(given.phase, null);
  assert.deepEqual(given.unreclaimed, { sandboxId: 'sbx_kept' });
  const node = checkNode(given, command, [], Date.now());
  assert.deepEqual(node.lines, [['Stopped · ', { state: 'suspended' }]]);
  assert.deepEqual(node.attention, {
    says: ['Machine not given back'],
    who: 'An operator releases it from the sandboxes console',
  });
  assert.deepEqual(node.aliases, ['sandbox:sbx_kept']);
  const one = await f.state.read((sql) => f.bases.checkOf(sql, f.projectId, base.key));
  assert.ok(one && hasCheck(one), 'its sidebar still answers');
});

test('a machine Code let go of is asked for again every few minutes, even on a cancelled base, and its red goes once the service no longer holds it', async (t) => {
  const { f, base, command, service, standing } = await keptMachine(t, 'cancel');
  // The drain the cancel asked for runs on its own; every count below is from after it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (let pass = 0; pass < 10 && !(await standing())?.unreclaimed; pass += 1)
    await f.bases.work(f.projectId);
  assert.deepEqual((await standing())?.unreclaimed, { sandboxId: 'sbx_kept' });
  const red = async () => checkNode((await standing())!, command, [], f.clock()).attention;
  const asked = service.asked.length;

  // Straight after the last refusal nothing is asked, and a cancelled base is due for nothing.
  await f.bases.work(f.projectId);
  assert.equal(service.asked.length, asked);
  assert.equal((await f.bases.due()).includes(f.projectId), false);

  // Five minutes on, the machine is asked for by its name alone; still refused, still red.
  f.advance(5 * 60_000);
  assert.ok((await f.bases.due()).includes(f.projectId), 'it is due again');
  await f.bases.work(f.projectId);
  assert.deepEqual(service.asked.slice(asked), ['sbx_kept']);
  assert.equal((await red())?.says[0], 'Machine not given back');

  // An operator gives it back from the console; Code hears so on its next ask, not before.
  service.taken = true;
  f.advance(60_000);
  await f.bases.work(f.projectId);
  assert.equal(service.asked.length, asked + 1, 'asked once in five minutes, however often');
  assert.equal((await red())?.says[0], 'Machine not given back');
  f.advance(4 * 60_000);
  const changes = f.changed();
  await f.bases.work(f.projectId);
  assert.equal(service.asked.length, asked + 2);
  assert.equal(await standing(), undefined, 'the check leaves the board with its red');
  const after = await f.state.read((sql) => f.bases.checkOf(sql, f.projectId, base.key));
  assert.equal(after?.unreclaimed, null);
  assert.equal(after && hasCheck(after), false);
  assert.ok(f.changed() > changes, 'work that waits on the base is told');

  // Nothing is left to ask for.
  f.advance(10 * 60_000);
  await f.bases.work(f.projectId);
  assert.equal(service.asked.length, asked + 2);
  assert.equal((await f.bases.due()).includes(f.projectId), false);
});
