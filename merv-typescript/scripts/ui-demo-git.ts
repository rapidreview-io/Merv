import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Caller, CodeCommitReceipt } from '@merv/contracts';
import { CodeRepositories } from '@merv/code/store/repository';
import { githubFixture, config as githubConfig } from '../tests/github-fixture.js';

/**
 * The Git state the /code page draws, seeded in the demo server's own process. An HTTP-only
 * seeder cannot reach any of it: code.commit needs a leased session, and a base needs a hosted
 * repository holding real commits. Every record below is made by the real services — units are
 * declared by Tasks and Experiments, commits are admitted by Code's store, and bases are merged
 * by the base worker — so what the canvas draws is what a project looks like, not a fixture.
 *
 * Two seams stand in for the world outside this process: GitHub's HTTP API, faked exactly as
 * tests/github-fixture.ts fakes it, and the Git remote the project publishes to, which is a
 * bare repository on this machine. Everything on the near side of both is the real server.
 *
 * One task here publishes to main, so its acceptance seals a publication and the sync opens the
 * pull request nobody has merged: the ring on the trunk and `published from` are drawn by a real
 * record, and `code_publication_pending` is on screen as the wait it is. What it does NOT make is
 * a merged publication — nothing here presses the operator's own merge — so `merged into` is
 * still drawn by no record in this bed and a screenshot of it proves nothing about that edge.
 */

/** What the bed exists to show, checked rather than hoped: a wrong state screenshots green. */
function must(fact: boolean, what: string): void {
  if (!fact) throw new Error(`The seeded Git bed is missing ${what}`);
}

const RUNNER = 'demo-runner';
const author = {
  GIT_AUTHOR_NAME: 'Demo',
  GIT_AUTHOR_EMAIL: 'demo@example.test',
  GIT_COMMITTER_NAME: 'Demo',
  GIT_COMMITTER_EMAIL: 'demo@example.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

/** Git as the demo runs it: no configuration of the machine or the user reaches it. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...author,
    },
  }).trim();
}

/** GitHub's HTTP seam, answered inside this process; everything else still reaches the network. */
let githubFetch: typeof fetch | undefined;
export function fakeGitHub(): void {
  process.env.MERV_TS_PUBLIC_ORIGIN = githubConfig.origin;
  process.env.MERV_GITHUB_CLIENT_ID = githubConfig.clientId;
  process.env.MERV_GITHUB_CLIENT_SECRET = githubConfig.clientSecret;
  process.env.MERV_GITHUB_APP_SLUG = githubConfig.appSlug;
  process.env.MERV_GITHUB_ENCRYPTION_KEY = githubConfig.encryptionKey;
  process.env.MERV_GITHUB_PRIVATE_KEY_BASE64 = githubConfig.privateKey;
  const network = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const github = url.hostname === 'github.com' || url.hostname === 'api.github.com';
    return github && githubFetch ? githubFetch(input, init) : network(input, init);
  }) as typeof fetch;
}

interface App {
  ctx: any;
  directory: string;
}
interface Bundle {
  tip: string;
  sha256: string;
  bytes: number;
  content: Buffer;
}
interface Held {
  unitId: string;
  sessionId: string;
  control: { sessionId: string; runnerId: string; hostRef: string };
  worker: Caller;
  workspace: Record<string, unknown>;
}

/** Seed the Git model of one demo project, and report what a screenshot can now prove. */
export async function seedGit(app: App, operator: Caller): Promise<Record<string, unknown>> {
  const ctx = app.ctx;
  const code = ctx.codeResearch;
  const root = join(app.directory, 'git');
  mkdirSync(root, { recursive: true });
  let requests = 0;
  const id = (name: string) => `demo-git-${name}-${++requests}`;
  const call = async (tool: string, caller: Caller, input: Record<string, unknown> = {}) =>
    (await ctx.tools.call(tool, caller, input)) as any;

  // A signed-in human: binding a repository and controlling a base are a person's moves.
  const principal = await ctx.scope.acceptVerifiedIdentity({
    issuer: 'https://demo.merv.test',
    subject: 'operator',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await ctx.scope.adoptProject(principal, operator.projectId);
  const human: Caller = await ctx.scope.caller(principal, operator.projectId);
  // Independent review is somebody else: this authority never produces any of the work below.
  const issued = await ctx.scope.issueActor(operator, {
    name: 'Demo · Git reviewer',
    role: 'operator',
  });
  const reviewer: Caller = {
    projectId: operator.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };

  // The operator's own repository, and the three commits its main carries.
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, ['init', '--quiet', '--object-format=sha1', '--initial-branch=main']);
  const write = (where: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(where, path)), { recursive: true });
      writeFileSync(join(where, path), content);
    }
  };
  const commitIn = (where: string, files: Record<string, string>, message: string) => {
    write(where, files);
    git(where, ['add', '-A']);
    git(where, ['commit', '--quiet', '-m', message]);
    return git(where, ['rev-parse', 'HEAD']);
  };
  commitIn(source, { 'README.md': '# Grokking replication\n' }, 'Start the replication');
  commitIn(
    source,
    {
      'train/loop.py': [
        'def train(model, data, steps):',
        '    for step in range(steps):',
        '        model.step(data)',
        '',
      ].join('\n'),
    },
    'Add the training loop',
  );
  const main = commitIn(
    source,
    { 'configs/base.yaml': 'optimizer: adamw\nweight_decay: 1.0\ndepth: 1\n' },
    'Record the base configuration',
  );

  const bundles = { made: 0 };
  const bundle = (where: string, tip: string, not: string[]): Bundle => {
    const file = join(root, `bundle-${++bundles.made}`);
    git(where, ['update-ref', 'refs/heads/transfer', tip]);
    git(where, ['bundle', 'create', file, 'refs/heads/transfer', ...not.map((oid) => `^${oid}`)]);
    const content = readFileSync(file);
    return {
      tip,
      content,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  };

  // Bind, then import: the binding names main, and the import is what makes Code's own
  // repository hold it, which is what `durability: code` means.
  await code.bindLocal(human, {
    repositoryId: 'demo-repository',
    mainOid: main,
    requestId: id('bind'),
  });
  const imported = bundle(source, main, []);
  const begun = await code.importRepository(human, {
    source: 'bundle',
    tip: main,
    bundle: { sha256: imported.sha256, bytes: imported.bytes },
    requestId: id('import'),
  });
  await code.v2.putPart(human, begun.id, 0, imported.content);
  await code.v2.call(human, `uploads/${begun.id}/complete`, {});

  // GitHub, faked at both its seams: its HTTP API in this process, and the repository it
  // publishes to as a bare repository this machine can push to.
  const remote = await githubFixture(
    { after: () => {} } as unknown as TestContext,
    ctx.state,
    human,
  );
  githubFetch = remote.fetcher;
  remote.branches.set('main', main);
  await remote.enable();
  // Publication stays disabled until an operator records a passing canary for this App, its
  // rules and this base branch; without one a sealed publication reads `disabled` instead of
  // waiting on the person who merges it.
  await code.controlPublication(human, {
    action: 'record_canary',
    staleMerged: false,
    reason: 'The demo release matrix passed with this App and its rules.',
    requestId: id('canary'),
  });
  const paths = new CodeRepositories({
    root: join(app.directory, 'code'),
    quotaBytes: 0,
    reservedFreeBytes: 0,
  }).paths(operator.projectId);
  // What the project publishes to, as a repository on this machine. Code's own transport may
  // speak only https, so the demo puts a local one in its place — the same seam a test replaces
  // — and every push below is a real push that moves a real ref.
  const published = join(root, 'github-remote.git');
  git(root, ['init', '--quiet', '--bare', '--object-format=sha1', published]);
  const remoteRef = (ref: string) =>
    git(published, ['for-each-ref', '--format=%(objectname)', ref]) || null;
  const transport = {
    target: async () => ({ repository: 'fixture/private' }),
    lsRemote: async (_projectId: string, ref: string) => remoteRef(ref),
    push: async (
      _projectId: string,
      update: { ref: string; oid: string; expectedRemote: string | null },
    ) => {
      if ((update.expectedRemote ?? null) !== remoteRef(update.ref)) return 'rejected';
      git(paths.repository, [
        '--git-dir',
        paths.repository,
        'push',
        '--quiet',
        published,
        `${update.oid}:${update.ref}`,
      ]);
      return 'ok';
    },
  };
  (code as any).mirrorStore.transport = transport;
  // A publication pushes its own immutable proposal branch, and reaches the repository through
  // its own transport rather than the mirror's queue, so the same local seam stands in for both.
  (code as any).publicationHost.mirror = () => transport;
  git(source, ['push', '--quiet', published, `${main}:refs/heads/main`]);

  await ctx.sessions.setDispatch(operator, { enabled: true });
  const heartbeat = async (caller: Caller) =>
    await ctx.sessions.heartbeatRunner(caller, {
      runnerId: RUNNER,
      machine: { hostname: 'demo', system: 'demo', architecture: 'demo' },
      platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 8 }],
      capacity: 8,
      capabilities: ['code.v2'],
    });
  await heartbeat(operator);
  // A runner belongs to the authority that registered it and a review is offered by the
  // reviewing authority, so the same machine announces itself under that one as well.
  await heartbeat(reviewer);

  const work = join(root, 'work');
  git(root, ['clone', '--quiet', '--no-checkout', paths.repository, work]);
  const fetched = () => git(work, ['fetch', '--quiet', paths.repository, '+refs/*:refs/demo/*']);
  const treeOf = (oid: string) => {
    fetched();
    return git(work, ['rev-parse', `${oid}^{tree}`]);
  };
  /** Author one commit on a base Code holds, and hand its objects back to Code. */
  const authored = (base: string, files: Record<string, string>, message: string) => {
    fetched();
    git(work, ['checkout', '--quiet', '--detach', base]);
    const tip = commitIn(work, files, message);
    return {
      tip,
      tree: git(work, ['rev-parse', `${tip}^{tree}`]),
      bundle: bundle(work, tip, [base]),
    };
  };

  // Every session-scoped call is made by the authority that offered the session, as a runner's is.
  const v2 = async (route: string, body: unknown) =>
    ((await code.v2.call(operator, route, body)) as { operation: any }).operation;
  const manifestOf = async (
    control: { sessionId: string; runnerId: string; hostRef?: string },
    as: Caller = operator,
  ) => (await code.v2.call(as, 'workspace', control)) as any;

  /** A runner taking one assignment: offered, authenticated and attached to its checkout. */
  const lease = async (instance: { id: string; workflow: { revision: number } }): Promise<Held> => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await ctx.sessions.offer(operator, {
      instanceId: instance.id,
      expectedRevision: instance.workflow.revision,
      runnerId: RUNNER,
      secret,
      requestId: id('offer'),
    });
    const control = { sessionId: session.id, runnerId: RUNNER, hostRef: `launch-${session.id}` };
    const manifest = await manifestOf({ sessionId: session.id, runnerId: RUNNER });
    const workspace = {
      repositoryId: manifest.repositoryId,
      workspaceId: `demo-${instance.id}`,
      mode: 'persistent',
      branch: manifest.branch,
      baseOid: manifest.base,
      headOid: manifest.head,
      stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    };
    await ctx.sessions.attach(operator, { ...control, workspace });
    return {
      unitId: instance.id,
      sessionId: session.id,
      control,
      workspace,
      worker: await ctx.sessions.authenticate(secret),
    };
  };

  /** One commit made the way a machine makes it: the tool, the command, the objects, the receipt. */
  const commit = async (held: Held, files: Record<string, string>, message: string) => {
    const manifest = await manifestOf(held.control);
    const requestId = id('commit');
    await call('code.commit', held.worker, { expectedHead: manifest.head, message, requestId });
    const command = await code.nextCommand(operator, held.control);
    const made = authored(manifest.head, files, message);
    const operation = await v2('uploads', {
      ...held.control,
      unitId: held.unitId,
      generation: manifest.generation,
      leaseId: held.sessionId,
      expectedHead: manifest.head,
      proposedHead: made.tip,
      treeOid: made.tree,
      bundle: { sha256: made.bundle.sha256, bytes: made.bundle.bytes },
      kind: 'checkpoint',
      commandId: command.id,
      requestId: command.id,
    });
    await code.v2.putPart(operator, operation.id, 0, made.bundle.content);
    await v2(`uploads/${operation.id}/complete`, {});
    const receipt: CodeCommitReceipt = {
      commandId: command.id,
      repositoryId: manifest.repositoryId,
      workspaceId: `demo-${held.unitId}`,
      baseOid: manifest.base,
      parentOid: command.expectedHead,
      headOid: made.tip,
      treeOid: made.tree,
      stats: {
        commitCount: 1,
        filesChanged: Object.keys(files).length,
        insertions: 8,
        deletions: 2,
      },
    };
    await code.completeCommand(operator, { ...held.control, commandId: command.id, receipt });
    return { commandId: command.id, head: made.tip };
  };

  /**
   * The one thing a machine still owes after its session closed. Handed over with no bundle,
   * because a checkpoint already delivered every object, which closes the writer generation.
   */
  const handOver = async (held: Held, manifest: { generation: number; head: string }) => {
    await v2('finalize', {
      ...held.control,
      unitId: held.unitId,
      generation: manifest.generation,
      leaseId: held.sessionId,
      expectedHead: manifest.head,
      proposedHead: manifest.head,
      treeOid: treeOf(manifest.head),
      bundle: null,
      kind: 'final',
    });
  };

  /** Wait until the server's own work settles, asked of the record rather than the clock. */
  const settled = async (until: () => Promise<boolean>, what: string) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await until()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`The demo waited for ${what} and it never happened`);
  };

  /**
   * A Git task passes only from the leased reviewer whose runner attached the read-only
   * checkout at the delivered commit, so the review is taken the way a reviewer takes it.
   */
  const pass = async (taskId: string) => {
    const inReview = await ctx.tasks.get(operator, taskId);
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await ctx.sessions.offer(reviewer, {
      instanceId: taskId,
      expectedRevision: inReview.workflow.revision,
      runnerId: RUNNER,
      secret,
      requestId: id('review-offer'),
    });
    const control = { sessionId: session.id, runnerId: RUNNER, hostRef: `review-${session.id}` };
    const manifest = await manifestOf({ sessionId: session.id, runnerId: RUNNER }, reviewer);
    const worker = await ctx.sessions.authenticate(secret);
    await ctx.sessions.attach(reviewer, {
      ...control,
      workspace: {
        repositoryId: manifest.repositoryId,
        workspaceId: `demo-review-${session.id}`,
        mode: 'ephemeral',
        branch: null,
        baseOid: manifest.base,
        headOid: manifest.head,
        stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
      },
    });
    const review = await ctx.reviews.get(
      reviewer,
      (await ctx.tasks.get(operator, taskId)).reviewId!,
    );
    await call('review.submit', worker, {
      reviewId: review.id,
      claimId: review.claimId,
      verdict: 'pass',
      synopsis: 'Read the delivered commit in the pinned checkout against the acceptance check.',
      findings: review.criteria.map((_: string, index: number) => ({
        criterionNumber: index + 1,
        status: 'met',
        evidenceIds: [...review.artifactIds],
        notes: 'The delivered commit records the change this check names.',
      })),
      notes: 'Accepting the delivered commit.',
      expectedRevision: inReview.workflow.revision,
      requestId: id('verdict'),
    });
    await ctx.sessions.release(reviewer, { sessionId: session.id, runnerId: RUNNER });
  };

  /** A unit whose inputs are still being merged waits for the server, as its runner does. */
  const based = async (unitId: string, what: string) =>
    await settled(
      async () =>
        (
          await ctx.state.transaction(
            async (tx: any) => await code.baseStatus(operator, unitId, tx),
          )
        ).status !== 'blocked',
      `a base for ${what}`,
    );

  /** An independent verdict on whatever review a record currently holds. */
  const grade = async (recordId: string, synopsis: string) => {
    const open = (await ctx.reviews.list(reviewer)).find(
      (item: any) => item.subjectId === recordId && item.status !== 'submitted',
    );
    if (!open) throw new Error(`The demo found no open review for ${recordId}`);
    const claim = await call('review.start', reviewer, { reviewId: open.id });
    const review = await ctx.reviews.get(reviewer, open.id);
    await call('review.submit', reviewer, {
      reviewId: review.id,
      claimId: claim.claimId ?? review.claimId,
      verdict: 'pass',
      synopsis,
      findings: review.criteria.map((_: string, index: number) => ({
        criterionNumber: index + 1,
        status: 'met',
        evidenceIds: [...review.artifactIds],
        notes: 'Checked the pinned evidence directly against this criterion.',
      })),
      notes: 'Accepting the pinned submission.',
      expectedRevision: review.subjectRevision,
      requestId: id('verdict'),
    });
  };

  /** A Git task, from its creation to the acceptance that makes its commit a base for others. */
  const task = async (
    title: string,
    goal: string,
    dependsOn: string[],
    files: Record<string, string>[],
    message: string,
    /** Declared before any lease: its acceptance seals a publication that carries it to main. */
    publishes = false,
  ) => {
    const created = await ctx.tasks.create(operator, {
      title,
      goal,
      checks: ['The change is recorded in the repository'],
      workspace: 'git',
      ...(dependsOn.length ? { dependsOn } : {}),
      requestId: id('task'),
    });
    // Nothing a worker does may put its own branch on the road to main, so the declaration
    // is the signed-in human's and is made before the base is pinned.
    if (publishes)
      await ctx.state.transaction((tx: any) =>
        code.publishOnAcceptance(human, { unitId: created.id }, tx),
      );
    await based(created.id, title);
    const held = await lease(created);
    let last = '';
    for (const change of files) last = (await commit(held, change, message)).commandId;
    const current = await ctx.tasks.get(operator, created.id);
    const manifest = await manifestOf(held.control);
    await call('task.submit_delivery', held.worker, {
      taskId: created.id,
      artifactIds: [],
      commandId: last,
      confirmations: [
        {
          checkNumber: 1,
          status: 'met',
          evidenceIds: [],
          notes: `The commit records ${title.toLowerCase()}.`,
        },
      ],
      expectedRevision: current.workflow.revision,
      requestId: id('delivery'),
    });
    await ctx.sessions.release(operator, { sessionId: held.sessionId, runnerId: RUNNER });
    await handOver(held, manifest);
    await pass(created.id);
    return await ctx.tasks.get(operator, created.id);
  };

  /**
   * A Git experiment, which delivers its work as the final capture of its own running session
   * rather than through code.commit: its lane is the class that has no commit receipts at all.
   */
  const experiment = async (
    name: string,
    intent: string,
    dependsOn: string[],
    files: Record<string, string>,
    message: string,
  ) => {
    const created = await ctx.experiments.create(operator, {
      name,
      intent,
      details: `The demo runs ${name.toLowerCase()} against the pinned harness.`,
      workspace: 'git',
      dependsOn,
      requestId: id('experiment'),
    });
    const plan = await ctx.artifacts.create(operator, {
      title: `Plan: ${name}`,
      content: [
        '# Summary',
        `${intent}`,
        '',
        '# Objective and hypothesis',
        'The change under test moves the grokking step, and the pinned harness can show it.',
        '',
        '# Evaluation',
        'One run per setting on the pinned data, reporting the step at which validation crosses 95%.',
      ].join('\n'),
      mediaType: 'text/markdown',
    });
    const feasibility = await ctx.artifacts.create(operator, {
      title: `Feasibility: ${name}`,
      content: JSON.stringify({
        formatVersion: 1,
        resources: [
          {
            kind: 'data',
            name: 'modular addition p=97',
            unit: 'examples',
            required: 9409,
            available: 9409,
            basis: 'The pinned tokenizer commit generates the whole table.',
          },
          {
            kind: 'compute',
            name: 'single GPU',
            unit: 'hours',
            required: 2,
            available: 8,
            basis: 'The demo runner reports eight idle hours.',
          },
        ],
        dependencies: [
          { name: 'pinned tokenizer', present: true, basis: 'Accepted in this project.' },
        ],
        blockers: [],
      }),
      mediaType: 'application/json',
    });
    const planned = await ctx.experiments.get(operator, created.id);
    for (const [role, artifact, path] of [
      ['plan', plan, 'plan.md'],
      ['feasibility', feasibility, 'feasibility.json'],
    ] as const)
      await call('experiment.attach', operator, {
        experimentId: created.id,
        artifactId: artifact.id,
        role,
        path,
        attemptIndex: planned.attempt.index,
        expectedRevision: (await ctx.experiments.get(operator, created.id)).workflow.revision,
        requestId: id('attach'),
      });
    await call('experiment.transition', operator, {
      experimentId: created.id,
      transition: 'submit_design',
      expectedRevision: (await ctx.experiments.get(operator, created.id)).workflow.revision,
      requestId: id('design'),
    });
    await grade(created.id, 'The pinned design can answer its question on the stated resources.');

    await based(created.id, name);
    const held = await lease(await ctx.experiments.get(operator, created.id));
    const manifest = await manifestOf(held.control);
    const made = authored(manifest.head, files, message);
    const result = await call('artifact.create', held.worker, {
      title: `Result: ${name}`,
      content: JSON.stringify({ grokking_step: 9810, validation_accuracy: 0.97, seed: 7 }),
      mediaType: 'application/json',
    });
    const attach = async (role: string, artifactId: string, path: string, resultFormat?: string) =>
      await call('experiment.attach', held.worker, {
        experimentId: created.id,
        artifactId,
        role,
        path,
        attemptIndex: (await ctx.experiments.get(operator, created.id)).attempt.index,
        expectedRevision: (await ctx.experiments.get(operator, created.id)).workflow.revision,
        ...(resultFormat ? { resultFormat } : {}),
        requestId: id('attach'),
      });
    await attach('result', result.id, 'metrics.json', 'json');
    // The report interprets the exhibit the server derived from that result, by its filename.
    const exhibit = await call('experiment.exhibit', held.worker, { experimentId: created.id });
    const report = await call('artifact.create', held.worker, {
      title: `Report: ${name}`,
      content: [
        '# Summary',
        `${name} ran once on the pinned harness.`,
        '',
        '# Results',
        `Validation crossed 95% at step 9,810 with the setting under test, as ${exhibit.path.split('/').at(-1)} records.`,
        '',
        '# Deviations from plan',
        'None. The run followed the approved plan.',
        '',
        '# Conclusion',
        'The setting moves the grokking step, and the commit records the change that produced it.',
      ].join('\n'),
      mediaType: 'text/markdown',
    });
    await attach('report', report.id, 'report.md');
    await call('experiment.transition', held.worker, {
      experimentId: created.id,
      transition: 'submit_results',
      expectedRevision: (await ctx.experiments.get(operator, created.id)).workflow.revision,
      requestId: id('results'),
    });
    await ctx.sessions.release(operator, { sessionId: held.sessionId, runnerId: RUNNER });
    // The machine hands over what it built: this capture is the experiment's accepted commit.
    const final = await v2('finalize', {
      ...held.control,
      unitId: held.unitId,
      generation: manifest.generation,
      leaseId: held.sessionId,
      expectedHead: manifest.head,
      proposedHead: made.tip,
      treeOid: made.tree,
      bundle: { sha256: made.bundle.sha256, bytes: made.bundle.bytes },
      kind: 'final',
    });
    await code.v2.putPart(operator, final.id, 0, made.bundle.content);
    await v2(`uploads/${final.id}/complete`, {});
    await ctx.sessions.workspaceResult(operator, {
      ...held.control,
      workspace: {
        ...held.workspace,
        headOid: made.tip,
        treeOid: made.tree,
        stats: {
          commitCount: 1,
          filesChanged: Object.keys(files).length,
          insertions: 6,
          deletions: 1,
        },
      },
    });
    await grade(
      created.id,
      'The submitted results follow the approved plan and the retained evidence.',
    );
    return await ctx.experiments.get(operator, created.id);
  };

  const tokenizer = await task(
    'Pin the tokenizer',
    'Fix the tokenizer so every run reads the same vocabulary.',
    [],
    [
      { 'data/tokenizer.py': 'VOCAB = 97\n' },
      { 'data/tokenizer.py': 'VOCAB = 97\nPAD = 0\n' },
      { 'data/vocab.txt': 'a\nb\nc\n' },
    ],
    'Pin the tokenizer',
  );

  // One task that publishes to main: its acceptance seals a publication, and the sync opens
  // the pull request nobody has merged. That wait is the one opinion Code keeps about work
  // that has ended, and it is what `code_publication_pending` reads as on the record's page
  // and on Now. It is declared from main and depends on nothing, so no base has to be made
  // for it and the lane leaves the trunk directly.
  const publishing = await task(
    'Publish the tokenizer report',
    'Write the tokenizer note that goes to main with this wave.',
    [],
    [{ 'docs/tokenizer.md': '# Tokenizer\n\nThe vocabulary is pinned at 97 symbols.\n' }],
    'Publish the tokenizer report',
    true,
  );
  // A publication reconciles with GitHub once every thirty seconds and this one was sealed a
  // moment ago; the demo ages it rather than waiting, exactly as its test does.
  await ctx.state.transaction((tx: any) =>
    tx.run("UPDATE code_publications SET synced_at='' WHERE project_id=?", operator.projectId),
  );
  await code.syncPublications(human);
  const sealed = await code.unit(human, publishing.id);
  must(
    sealed.publication?.state === 'pending',
    `a publication waiting on a person (it is ${sealed.publication?.state ?? 'absent'})`,
  );
  must(!!sealed.publication?.pull, 'the open pull request that wait is about');

  // One accepted source and no base record: the single-dependency lane.
  const baseline = await experiment(
    'baseline-p97-reproduction',
    'Reproduce the published grokking curve on modular addition with the pinned tokenizer.',
    [tokenizer.id],
    { 'runs/baseline.md': 'seed 7, weight decay 1.0\n' },
    'Record the baseline run',
  );
  // Two acceptances at commits that do not collide, and the task the server merges them for.
  const decay = await experiment(
    'sweep-weight-decay',
    'Find where the grokking step moves as weight decay grows.',
    [tokenizer.id],
    { 'runs/decay.md': '0.1, 0.3, 1.0, 3.0\n' },
    'Record the weight-decay sweep',
  );
  const depth = await experiment(
    'sweep-depth',
    'Find where the grokking step moves as depth grows.',
    [tokenizer.id],
    { 'runs/depth.md': '1, 2, 4 layers\n' },
    'Record the depth sweep',
  );
  const folded = await task(
    'Fold both sweeps into the harness',
    'Take both sweeps into the harness so one command runs them.',
    [decay.id, depth.id],
    [{ 'train/harness.py': 'def sweep(settings):\n    return [run(s) for s in settings]\n' }],
    'Fold both sweeps into the harness',
  );

  // Two acceptances that changed the same two files, and the units that wait behind them.
  const momentum = await experiment(
    'momentum-ablation',
    'Test whether momentum alone moves the grokking step.',
    [tokenizer.id],
    {
      'train/loop.py':
        'def train(model, data, steps, momentum=0.9):\n    for step in range(steps):\n        model.step(data, momentum)\n',
      'configs/base.yaml': 'optimizer: adamw\nweight_decay: 1.0\ndepth: 1\nmomentum: 0.9\n',
    },
    'Ablate momentum',
  );
  const loader = await task(
    'Rewrite the loader',
    'Rewrite the data loader so a run streams its batches.',
    [tokenizer.id],
    [
      {
        'train/loop.py':
          'def train(model, stream, steps):\n    for step, batch in zip(range(steps), stream):\n        model.step(batch)\n',
        'configs/base.yaml': 'optimizer: adamw\nweight_decay: 1.0\ndepth: 1\nloader: streaming\n',
      },
    ],
    'Rewrite the loader',
  );
  // Two units asking for the same merge: one square, two dashed edges, and the conflict beneath.
  const waiting = [];
  for (const [title, goal] of [
    [
      'Long-run grokking harness',
      'Run the streaming loader and the ablation together for 100k steps.',
    ],
    ['Re-run the ablation grid', 'Re-run the ablation grid on the streaming loader.'],
  ] as const)
    waiting.push(
      await ctx.tasks.create(operator, {
        title,
        goal,
        checks: ['The change is recorded in the repository'],
        workspace: 'git',
        dependsOn: [momentum.id, loader.id],
        requestId: id('task'),
      }),
    );
  await settled(async () => {
    const bases = (await code.status(human)).bases ?? [];
    return bases.some((base: any) => base.state === 'awaiting_resolution' && base.conflict);
  }, 'the conflicting merge to be recorded with its paths');

  // A writer still at work: its machine has committed past what the mirror published.
  const profiling = await ctx.tasks.create(operator, {
    title: 'Profile the data loader',
    goal: 'Find where the loader spends its time.',
    checks: ['The change is recorded in the repository'],
    workspace: 'git',
    dependsOn: [tokenizer.id],
    requestId: id('task'),
  });
  const open = await lease(profiling);
  await commit(open, { 'train/profile.py': 'import cProfile\n' }, 'Start profiling the loader');
  // The remote this project publishes to is a bare repository on this machine, reached through
  // a rewrite rule: the mirror pushes for real, and then the writer moves on past it.
  await code.mirrorStep();
  await settled(async () => {
    await code.mirrorStep();
    return (await code.unit(human, profiling.id)).mirroredHead !== null;
  }, 'the mirror to publish the first commit');
  // The machine that holds the remote goes away, so what the writer does next stays unpublished
  // and the lag between the two heads is a fact about this project rather than a moment.
  rmSync(published, { recursive: true, force: true });
  await commit(
    open,
    { 'train/profile.py': 'import cProfile\nSTEPS = 2000\n' },
    'Profile two thousand steps',
  );

  // A base an operator quarantined, and with it every unit that retains it.
  const sweeps = ((await code.status(human)).bases ?? []).find(
    (base: any) => base.state === 'resolved' && base.result?.method === 'auto',
  );
  must(!!sweeps, 'the automatically merged base it quarantines');
  await code.controlBase(human, {
    key: sweeps!.key,
    action: 'quarantine',
    reason: 'The demo holds this merge so a quarantined lineage is on screen.',
    requestId: id('quarantine'),
  });

  const status = await code.status(human);
  const bases: any[] = status.bases ?? [];
  const units: any[] = status.units;
  must(
    bases.some((base) => base.quarantined && base.state === 'resolved'),
    'a quarantined base, so the hollow mark is on screen',
  );
  must(
    bases.some(
      (base) =>
        base.state === 'awaiting_resolution' &&
        base.conflict?.paths.length &&
        base.resolutionTaskId,
    ),
    'a conflicted base with its paths and the task that resolves it',
  );
  must(
    units.filter((unit) => unit.baseStatus?.merge?.length).length >= 2,
    'two units waiting on one merge, so the dashed edges converge',
  );
  must(
    units.some((unit) => !!unit.mirroredHead && unit.canonicalHead !== unit.mirroredHead),
    'a writer ahead of its mirror, so the hollow tail is on screen',
  );
  const made = new Map<string, number>();
  for (const record of await code.list(human))
    if (record.receipt)
      made.set(record.command.instanceId, (made.get(record.command.instanceId) ?? 0) + 1);
  must(
    [...made.values()].some((count) => count >= 3),
    'a lane of three commit receipts',
  );
  must(
    units.some((unit) => !made.has(unit.unitId)),
    'a lane with no receipt at all, which is the class the old drawing dropped',
  );
  return {
    main,
    repository: paths.repository,
    published,
    units: {
      tokenizer: tokenizer.id,
      publishing: publishing.id,
      baseline: baseline.id,
      decay: decay.id,
      depth: depth.id,
      folded: folded.id,
      momentum: momentum.id,
      loader: loader.id,
      waiting: waiting.map((record: any) => record.id),
      profiling: profiling.id,
    },
    counts: {
      units: status.units.length,
      bases: (status.bases ?? []).length,
      publications: status.publication?.records.length ?? 0,
    },
  };
}
