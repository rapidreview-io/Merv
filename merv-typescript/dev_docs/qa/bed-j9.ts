/**
 * QA bed J9 C0.1: Merv's consolidation journey, rehearsed on the real server in this process
 * before it is attempted on production.
 *
 *   MERV_TEST_POSTGRES_URL=postgres://merv@127.0.0.1:55439/merv \
 *     node --import tsx dev_docs/qa/bed-j9.ts          # BED_KEEP=1 keeps the schema and directory
 *
 * The server is the committed default composition, started the way scripts/ui-demo-git.ts
 * starts it. Three seams stand in for the world outside: GitHub's HTTP API (faked exactly as
 * tests/github-fixture.ts fakes it, plus a merge that writes a real merge commit), the repository
 * the project publishes to (a bare repository on this machine, reached by the mirror, the
 * publication snapshot and the post-merge import), and the runner (its v2 workspace protocol is
 * spoken here by hand: offer, manifest, attach, code.commit, upload, receipt, release, final
 * capture). Everything else is the real services, driven through the tools a signed-in person, a
 * leased worker session and a leased reviewer session call. Any network host other than
 * loopback or the faked GitHub is refused.
 *
 * Who is who: the owner is a signed-in human (supplies research.*, code.local.bind, the canary
 * and the merge); K1 and K2 are two mk_ user keys of that same owner (K1 directs the original
 * producer, the lenses, the synthesis and the consolidation producer W); W-B is the mk_ key of a
 * second person, the independent reviewer.
 *
 * Prints one line per step: STEP <id> PASS|DIFF|FAIL|INFO :: what happened :: evidence, then a
 * markdown table. PASS matches the plan written before the latest fixes, DIFF differs from it but
 * the journey went on, FAIL stopped the journey, INFO is a probe the plan did not make: 1' and 2'
 * (may the directing person review an ordinary task and a reflection), 5b' (may another key of
 * W's person review the consolidation) and 8.5 (the consolidation after a resolved clash).
 *
 * Where the plan and the product disagree, the bed does what the product asks and says so: the
 * advance that injects consolidation is refused with input_required until it names nextWave
 * (step 3), so it is repeated with nextWave: "create", which that advance then does not use.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import pg from 'pg';
import type { Caller, CodeCommitReceipt } from '@merv/contracts';
import { CodeRepositories } from '@merv/code/store/repository';
import { createApp } from '../../src/app.js';
import { defaultConfigFile } from '../../src/config.js';
import { config as githubConfig, githubFixture } from '../../tests/github-fixture.js';

const started = Date.now();
const databaseUrl =
  process.env.MERV_DB_URL?.trim() || process.env.MERV_TEST_POSTGRES_URL?.trim() || '';
if (!databaseUrl)
  throw new Error('Set MERV_TEST_POSTGRES_URL, e.g. postgres://merv@127.0.0.1:55439/merv');
const databaseHost = new URL(databaseUrl).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(databaseHost))
  throw new Error(`The bed only runs against a local PostgreSQL, not ${databaseHost}`);
process.env.MERV_DB_URL = databaseUrl;
/** This run's own schema: created by the server on open, dropped at the end unless BED_KEEP. */
const schema = `qa_bed_j9_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
process.env.MERV_DB_SCHEMA = schema;
const keep = process.env.BED_KEEP === '1';

// ---------------------------------------------------------------------------------------------
// Reporting

type Verdict = 'PASS' | 'DIFF' | 'FAIL' | 'INFO';
interface Row {
  step: string;
  expected: string;
  actual: string;
  verdict: Verdict;
  evidence: Record<string, unknown>;
  seconds: number;
}
const rows: Row[] = [];
let stepStarted = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
function report(
  step: string,
  expected: string,
  actual: string,
  verdict: Verdict,
  evidence: Record<string, unknown> = {},
) {
  const seconds = (Date.now() - stepStarted) / 1000;
  stepStarted = Date.now();
  rows.push({ step, expected, actual, verdict, evidence, seconds });
  console.log(`[${elapsed()}] STEP ${step} ${verdict} :: ${actual} :: ${JSON.stringify(evidence)}`);
}
interface Refusal {
  code: string;
  status?: number;
  message: string;
}
const refusal = (error: unknown): Refusal => ({
  code: String((error as { code?: unknown })?.code ?? 'exception'),
  ...(typeof (error as { status?: unknown })?.status === 'number'
    ? { status: (error as { status: number }).status }
    : {}),
  message: error instanceof Error ? error.message : String(error),
});
type Attempt<T> = { ok: true; value: T } | ({ ok: false } & Refusal);
async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, ...refusal(error) };
  }
}
const said = (result: Attempt<unknown>) =>
  result.ok ? 'admitted' : `${result.code}${result.status ? ` ${result.status}` : ''}`;

/** A step that cannot go on stops its journey; the later steps are reported as not run. */
class Stopped extends Error {}
interface Outcome<T> {
  verdict: Verdict;
  actual: string;
  evidence?: Record<string, unknown>;
  value: T;
}
async function step<T>(
  name: string,
  expected: string,
  body: () => Promise<Outcome<T>>,
): Promise<T> {
  let outcome: Outcome<T>;
  try {
    outcome = await body();
  } catch (error) {
    if (error instanceof Stopped) throw error;
    const r = refusal(error);
    report(
      name,
      expected,
      `threw ${r.code}${r.status ? ` (${r.status})` : ''}: ${r.message}`,
      'FAIL',
      {
        code: r.code,
        ...(r.status ? { status: r.status } : {}),
        at: (error instanceof Error ? (error.stack ?? '') : '')
          .split('\n')
          .slice(1, 4)
          .map((line) => line.trim()),
      },
    );
    throw new Stopped(name);
  }
  report(name, expected, outcome.actual, outcome.verdict, outcome.evidence ?? {});
  if (outcome.verdict === 'FAIL') throw new Stopped(name);
  return outcome.value;
}

// ---------------------------------------------------------------------------------------------
// The world outside the server

const author = {
  GIT_AUTHOR_NAME: 'QA bed',
  GIT_AUTHOR_EMAIL: 'bed@example.test',
  GIT_COMMITTER_NAME: 'QA bed',
  GIT_COMMITTER_EMAIL: 'bed@example.test',
  GIT_AUTHOR_DATE: '2026-09-25T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-09-25T00:00:00Z',
};
const gitEnv = (cwd: string) => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: cwd,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  ...author,
});
/** Git as the bed runs it: no configuration of this machine or its user reaches it. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: gitEnv(cwd),
  }).trim();
}
/** merge-tree answers 1 for a conflicted merge, which is a result rather than a failure. */
function mergeTree(cwd: string, left: string, right: string): { tree: string; clean: boolean } {
  const run = spawnSync('git', ['merge-tree', '--write-tree', left, right], {
    cwd,
    encoding: 'utf8',
    env: gitEnv(cwd),
  });
  if (run.status !== 0 && run.status !== 1) throw new Error(`git merge-tree failed: ${run.stderr}`);
  return { tree: run.stdout.split('\n')[0]!.trim(), clean: run.status === 0 };
}

/** GitHub's HTTP seam, answered inside this process; loopback is the only other host allowed. */
let githubFetch: typeof fetch | undefined;
function fakeGitHub(): void {
  process.env.MERV_TS_PUBLIC_ORIGIN = githubConfig.origin;
  process.env.MERV_GITHUB_CLIENT_ID = githubConfig.clientId;
  process.env.MERV_GITHUB_CLIENT_SECRET = githubConfig.clientSecret;
  process.env.MERV_GITHUB_APP_SLUG = githubConfig.appSlug;
  process.env.MERV_GITHUB_ENCRYPTION_KEY = githubConfig.encryptionKey;
  process.env.MERV_GITHUB_PRIVATE_KEY_BASE64 = githubConfig.privateKey;
  const network = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'github.com' || url.hostname === 'api.github.com') {
      if (!githubFetch) throw new Error('The bed has not faked GitHub yet');
      return await githubFetch(input, init);
    }
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname))
      throw new Error(`The bed refuses network access to ${url.hostname}`);
    return await network(input, init);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------
// One project on the server, with the people, keys, runner and repositories around it

type App = Awaited<ReturnType<typeof createApp>>;
interface Authority {
  name: string;
  caller: Caller;
  runnerId: string;
}
interface Control {
  sessionId: string;
  runnerId: string;
  hostRef: string;
}
interface Offered {
  session: any;
  control: Control;
  token: string;
  by: Authority;
}
interface Held extends Offered {
  unitId: string;
  worker: Caller;
  workspace: Record<string, unknown>;
}
interface Bundle {
  sha256: string;
  bytes: number;
  content: Buffer;
}
const zero = { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 };
const secret = () => `ms_${randomBytes(32).toString('base64url')}`;

async function stand(app: App, label: string, withGitHub: boolean) {
  const ctx = app.ctx as any;
  const code = ctx.codeResearch;
  const root = join(app.directory, `git-${label}`);
  mkdirSync(root, { recursive: true });
  let sequence = 0;
  const id = (name: string) => `bed-${label}-${name}-${++sequence}`;
  const call = async (tool: string, caller: Caller, input: Record<string, unknown> = {}) =>
    (await ctx.tools.call(tool, caller, input)) as any;
  const identity = (subject: string) => ({
    issuer: 'https://bed.merv.test/auth/v1',
    subject,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  // The owner signs in and creates the project; a second person joins to review.
  const ownerPrincipal = await ctx.scope.acceptVerifiedIdentity(identity(`owner-${label}`));
  const project = await ctx.scope.createProject(ownerPrincipal, {
    name: `QA bed J9 ${label}`,
    requestId: id('project'),
  });
  const human: Caller = await ctx.scope.caller(ownerPrincipal, project.id);
  await ctx.scope.addMember(ownerPrincipal, project.id, {
    subject: `reviewer-${label}`,
    role: 'operator',
  });
  const reviewerPrincipal = await ctx.scope.acceptVerifiedIdentity(identity(`reviewer-${label}`));
  const key = async (principal: unknown, name: string, runnerId: string): Promise<Authority> => {
    const issued = await ctx.scope.createKey(principal, { projectId: project.id, label: name });
    const caller = await ctx.scope.caller(
      { kind: 'key', key: await ctx.scope.authenticateKey(issued.token) },
      project.id,
    );
    return { name, caller, runnerId };
  };
  const K1 = await key(ownerPrincipal, 'K1 (owner key 1, directs W)', 'runner-k1');
  const K2 = await key(ownerPrincipal, 'K2 (owner key 2)', 'runner-k2');
  const WB = await key(reviewerPrincipal, 'W-B (second person key)', 'runner-wb');

  // The owner's repository with the commit that is main.
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
  let bundles = 0;
  const bundle = (where: string, tip: string, not: string[]): Bundle => {
    const file = join(root, `bundle-${++bundles}`);
    git(where, ['update-ref', 'refs/heads/transfer', tip]);
    git(where, [
      'bundle',
      'create',
      '--quiet',
      file,
      'refs/heads/transfer',
      ...not.map((oid) => `^${oid}`),
    ]);
    const content = readFileSync(file);
    return {
      content,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  };
  const main0 = commitIn(
    source,
    {
      'README.md': '# Grokking replication\n',
      'train/loop.py':
        'def train(model, data, steps):\n    for step in range(steps):\n        model.step(data)\n',
      'configs/base.yaml': 'optimizer: adamw\nweight_decay: 1.0\n',
    },
    'Start the replication',
  );

  /** Bring a commit of the owner's repository into Code, as code.repository.import does. */
  const importCommit = async (tip: string, not: string[]) => {
    const made = bundle(source, tip, not);
    const begun = await call('code.repository.import', human, {
      source: 'bundle',
      tip,
      bundle: { sha256: made.sha256, bytes: made.bytes },
      requestId: id('import'),
    });
    await code.v2.putPart(human, begun.id, 0, made.content);
    const done = await code.v2.call(human, `uploads/${begun.id}/complete`, {});
    const operation = (done as any).operation ?? done;
    if (operation.status !== 'completed')
      throw new Error(
        `The import of ${tip} ended ${operation.status}: ${JSON.stringify(operation.error ?? null)}`,
      );
    return operation;
  };
  await call('code.local.bind', human, {
    repositoryId: `bed-${label}`,
    mainOid: main0,
    requestId: id('bind'),
  });
  await importCommit(main0, []);

  const paths = new CodeRepositories({
    root: join(app.directory, 'code'),
    quotaBytes: 0,
    reservedFreeBytes: 0,
  }).paths(project.id);

  // GitHub, faked at its HTTP seam, and the repository it publishes to, on this machine.
  const published = join(root, 'github-remote.git');
  git(root, ['init', '--quiet', '--bare', '--object-format=sha1', published]);
  const remoteRef = (ref: string) =>
    git(published, ['for-each-ref', '--format=%(objectname)', ref]) || null;
  let remote: Awaited<ReturnType<typeof githubFixture>> | undefined;
  if (withGitHub) {
    remote = await githubFixture({ after: () => {} } as unknown as TestContext, ctx.state, human);
    githubFetch = remote.fetcher;
    remote.branches.set('main', main0);
    await remote.enable();
    await call('code.publication.control', human, {
      action: 'record_canary',
      staleMerged: false,
      reason: 'QA bed: the release matrix passed with this App and its rules.',
      requestId: id('canary'),
    });
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
    code.mirrorStore.transport = transport;
    code.publicationHost.mirror = () => transport;
    // Code reads main back from GitHub after a merge; here it reads the same local repository.
    code.store.remote = {
      read: async (_caller: Caller, use: (target: unknown) => Promise<unknown>) =>
        await use({
          url: `file://${published}`,
          protocol: 'file',
          repository: { id: 101, fullName: 'fixture/private' },
          env: {},
        }),
    };
    git(source, ['push', '--quiet', published, `${main0}:refs/heads/main`]);
    // GitHub's merge button, as GitHub does it: a real two-parent merge commit on main.
    remote.control.before = async (path: string) => {
      const match = /\/pulls\/(\d+)\/merge$/.exec(path);
      if (!match) return;
      const pull = remote!.pulls.find((item) => item.number === Number(match[1]));
      const base = remoteRef('refs/heads/main')!;
      const merged = mergeTree(published, base, pull.head.sha);
      if (!merged.clean) throw new Error('The faked GitHub merge conflicted');
      const commit = git(published, [
        'commit-tree',
        merged.tree,
        '-p',
        base,
        '-p',
        pull.head.sha,
        '-m',
        `Merge pull request #${pull.number} from fixture/${pull.head.ref}`,
      ]);
      git(published, ['update-ref', 'refs/heads/main', commit, base]);
      remote!.control.mergeSha = commit;
    };
  }

  // One machine per key, each announcing itself under the authority that uses it.
  await ctx.sessions.setDispatch(human, { enabled: true });
  for (const by of [K1, K2, WB])
    await ctx.sessions.heartbeatRunner(by.caller, {
      runnerId: by.runnerId,
      machine: { hostname: `bed-${by.runnerId}`, system: 'bed', architecture: 'bed' },
      platforms: [{ name: 'codex', harness: 'codex', enabled: true, parallelism: 8 }],
      capacity: 8,
      capabilities: ['code.v2'],
    });

  // The runner's side of Git: a clone that authors commits on what Code holds.
  const work = join(root, 'work');
  git(root, ['clone', '--quiet', '--no-checkout', paths.repository, work]);
  const fetched = () => git(work, ['fetch', '--quiet', paths.repository, '+refs/*:refs/bed/*']);
  const treeOf = (oid: string) => {
    fetched();
    return git(work, ['rev-parse', `${oid}^{tree}`]);
  };

  const settled = async (until: () => Promise<unknown>, what: string, seconds = 45) => {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      const value = await until();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`The bed waited ${seconds}s for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const baseStatus = async (unitId: string) =>
    await ctx.state.transaction(async (tx: any) => await code.baseStatus(human, unitId, tx));
  const based = async (unitId: string) =>
    await settled(
      async () => (await baseStatus(unitId)).status !== 'blocked',
      `a base for ${unitId}`,
    );

  // ------------------------------------------------------------------ sessions, as a runner holds them
  const offer = async (by: Authority, instanceId: string, revision: number): Promise<Offered> => {
    const token = secret();
    const session = await ctx.sessions.offer(by.caller, {
      instanceId,
      expectedRevision: revision,
      runnerId: by.runnerId,
      secret: token,
      requestId: id('offer'),
    });
    return {
      session,
      token,
      by,
      control: { sessionId: session.id, runnerId: by.runnerId, hostRef: `launch-${session.id}` },
    };
  };
  const manifestOf = async (
    by: Authority,
    control: Partial<Control> & { sessionId: string; runnerId: string },
  ) => (await code.v2.call(by.caller, 'workspace', control)) as any;
  /** A session with no checkout: lenses, synthesis and reflection review. */
  const leaseBare = async (by: Authority, instanceId: string, revision: number) => {
    const offered = await offer(by, instanceId, revision);
    await ctx.sessions.attach(by.caller, offered.control);
    return { ...offered, worker: (await ctx.sessions.authenticate(offered.token)) as Caller };
  };
  /** A writer: offered, its manifest read, its checkout attached at the head Code names. */
  const leaseWriter = async (
    by: Authority,
    instance: { id: string; workflow: { revision: number } },
  ): Promise<Held> => {
    const offered = await offer(by, instance.id, instance.workflow.revision);
    const manifest = await manifestOf(by, { sessionId: offered.session.id, runnerId: by.runnerId });
    const workspace = {
      repositoryId: manifest.repositoryId,
      workspaceId: `bed-${instance.id}`,
      mode: 'persistent',
      branch: manifest.branch,
      baseOid: manifest.base,
      headOid: manifest.head,
      ...(manifest.pendingMerge
        ? { pendingMerge: { ...manifest.pendingMerge, checkpoint: manifest.head } }
        : {}),
      stats: zero,
    };
    await ctx.sessions.attach(by.caller, { ...offered.control, workspace });
    return {
      ...offered,
      unitId: instance.id,
      workspace,
      worker: await ctx.sessions.authenticate(offered.token),
    };
  };
  const release = async (held: { by: Authority; control: Control }) =>
    await ctx.sessions.release(held.by.caller, {
      sessionId: held.control.sessionId,
      runnerId: held.by.runnerId,
    });

  const v2 = async (by: Authority, route: string, body: unknown) =>
    ((await code.v2.call(by.caller, route, body)) as { operation: any }).operation;
  /** What the driver's upload does: begin, send the bundle if any, complete. */
  const upload = async (
    held: Held,
    command: { id: string; expectedHead: string },
    manifest: { generation: number },
    made: { tip: string; tree: string; bundle: Bundle | null },
  ) => {
    let operation = await v2(held.by, 'uploads', {
      ...held.control,
      unitId: held.unitId,
      generation: manifest.generation,
      leaseId: held.control.sessionId,
      expectedHead: command.expectedHead,
      proposedHead: made.tip,
      treeOid: made.tree,
      bundle: made.bundle ? { sha256: made.bundle.sha256, bytes: made.bundle.bytes } : null,
      kind: 'checkpoint',
      commandId: command.id,
      requestId: command.id,
    });
    if (made.bundle) await code.v2.putPart(held.by.caller, operation.id, 0, made.bundle.content);
    if (operation.status === 'prepared')
      operation = await v2(held.by, `uploads/${operation.id}/complete`, {});
    if (operation.status !== 'completed')
      throw Object.assign(new Error(`Upload ${operation.id} ended ${operation.status}`), {
        code: operation.error?.code ?? 'bed_upload_refused',
      });
    return operation;
  };
  const receipt = (
    held: Held,
    manifest: any,
    command: any,
    head: string,
    tree: string,
    files = 0,
  ): CodeCommitReceipt => ({
    commandId: command.id,
    repositoryId: manifest.repositoryId,
    workspaceId: String(held.workspace.workspaceId),
    baseOid: manifest.base,
    parentOid: command.expectedHead,
    headOid: head,
    treeOid: tree,
    stats: {
      commitCount: head === command.expectedHead ? 0 : 1,
      filesChanged: files,
      insertions: files * 2,
      deletions: 0,
    },
  });
  /** code.commit, then what the runner does with the command it is handed. */
  const commit = async (held: Held, files: Record<string, string>, message: string) => {
    const manifest = await manifestOf(held.by, held.control);
    await call('code.commit', held.worker, {
      expectedHead: manifest.head,
      message,
      requestId: id('commit'),
    });
    const command = await code.nextCommand(held.by.caller, held.control);
    fetched();
    git(work, ['checkout', '--quiet', '--force', '--detach', manifest.head]);
    const tip = commitIn(work, files, message);
    const made = {
      tip,
      tree: git(work, ['rev-parse', `${tip}^{tree}`]),
      bundle: bundle(work, tip, [manifest.head]),
    };
    await upload(held, command, manifest, made);
    await code.completeCommand(held.by.caller, {
      ...held.control,
      commandId: command.id,
      receipt: receipt(held, manifest, command, made.tip, made.tree, Object.keys(files).length),
    });
    return { commandId: command.id as string, head: tip };
  };
  /** code.merge start: the frozen merge is materialised; Code admits the unchanged head. */
  const mergeStart = async (held: Held) => {
    const manifest = await manifestOf(held.by, held.control);
    await call('code.merge', held.worker, {
      operation: 'start',
      expectedHead: manifest.head,
      message: 'Start the planned merge',
      requestId: id('merge-start'),
    });
    const command = await code.nextCommand(held.by.caller, held.control);
    const tree = treeOf(command.expectedHead);
    await upload(held, command, manifest, { tip: command.expectedHead, tree, bundle: null });
    await code.completeCommand(held.by.caller, {
      ...held.control,
      commandId: command.id,
      receipt: receipt(held, manifest, command, command.expectedHead, tree),
    });
    return { commandId: command.id as string, manifest };
  };
  /** code.merge complete: the worker's resolution, committed with the frozen second parent. */
  const mergeComplete = async (held: Held, resolution: Record<string, string>) => {
    const manifest = await manifestOf(held.by, held.control);
    const pending = manifest.pendingMerge;
    await call('code.merge', held.worker, {
      operation: 'complete',
      expectedHead: manifest.head,
      message: 'Resolve the planned merge',
      requestId: id('merge-complete'),
    });
    const command = await code.nextCommand(held.by.caller, held.control);
    fetched();
    const merged = mergeTree(work, pending.firstParent, pending.secondParent);
    git(work, ['checkout', '--quiet', '--force', '--detach', command.expectedHead]);
    git(work, ['read-tree', '--reset', '-u', merged.tree]);
    write(work, resolution);
    git(work, ['add', '-A']);
    const tree = git(work, ['write-tree']);
    const tip = git(work, [
      'commit-tree',
      tree,
      '-p',
      command.expectedHead,
      '-p',
      pending.secondParent,
      '-m',
      'Resolve the planned merge',
    ]);
    await upload(held, command, manifest, {
      tip,
      tree,
      bundle: bundle(work, tip, [command.expectedHead]),
    });
    await code.completeCommand(held.by.caller, {
      ...held.control,
      commandId: command.id,
      receipt: receipt(held, manifest, command, tip, tree, Object.keys(resolution).length),
    });
    return { commandId: command.id as string, head: tip, conflicted: !merged.clean };
  };
  /** The one thing a machine still owes after its session closed: the final capture. */
  const handOver = async (held: Held, manifest: { generation: number; head: string }) =>
    await v2(held.by, 'finalize', {
      ...held.control,
      unitId: held.unitId,
      generation: manifest.generation,
      leaseId: held.control.sessionId,
      expectedHead: manifest.head,
      proposedHead: manifest.head,
      treeOid: treeOf(manifest.head),
      bundle: null,
      kind: 'final',
    });
  const deliver = async (held: Held, taskId: string, commandId: string, note: string) => {
    const current = await ctx.tasks.get(human, taskId);
    return await call('task.submit_delivery', held.worker, {
      taskId,
      artifactIds: [],
      commandId,
      confirmations: current.checks.map((_: string, index: number) => ({
        checkNumber: index + 1,
        status: 'met',
        evidenceIds: [],
        notes: note,
      })),
      expectedRevision: current.workflow.revision,
      requestId: id('delivery'),
    });
  };
  /** Produce a Git task end to end: base, lease, commits, delivery, release, final capture. */
  const produce = async (
    by: Authority,
    taskId: string,
    changes: Record<string, string>[],
    message: string,
  ) => {
    await based(taskId);
    const held = await leaseWriter(by, await ctx.tasks.get(human, taskId));
    let last = { commandId: '', head: '' };
    for (const files of changes) last = await commit(held, files, message);
    const manifest = await manifestOf(held.by, held.control);
    const delivered = await deliver(
      held,
      taskId,
      last.commandId,
      `The commit records ${message.toLowerCase()}.`,
    );
    await release(held);
    await handOver(held, manifest);
    return { held, delivered, head: last.head };
  };
  /** A leased review of a Git task: offer (the claim), read-only checkout, verdict, release. */
  const offerReview = async (by: Authority, taskId: string) =>
    await offer(by, taskId, (await ctx.tasks.get(human, taskId)).workflow.revision);
  const passGit = async (offered: Offered, taskId: string) => {
    const by = offered.by;
    const manifest = await manifestOf(by, { sessionId: offered.session.id, runnerId: by.runnerId });
    const worker = await ctx.sessions.authenticate(offered.token);
    await ctx.sessions.attach(by.caller, {
      ...offered.control,
      workspace: {
        repositoryId: manifest.repositoryId,
        workspaceId: `bed-review-${offered.session.id}`,
        mode: 'ephemeral',
        branch: null,
        baseOid: manifest.base,
        headOid: manifest.head,
        stats: zero,
      },
    });
    const task = await ctx.tasks.get(human, taskId);
    const review = await ctx.reviews.get(by.caller, task.reviewId);
    const verdict = await call('review.submit', worker, {
      reviewId: review.id,
      claimId: review.claimId,
      verdict: 'pass',
      synopsis: 'Read the delivered commit in the pinned read-only checkout against each check.',
      findings: review.criteria.map((_: string, index: number) => ({
        criterionNumber: index + 1,
        status: 'met',
        evidenceIds: [...review.artifactIds],
        notes: 'The delivered commit records what this check names.',
      })),
      notes: 'Accepting the delivered commit.',
      expectedRevision: task.workflow.revision,
      requestId: id('verdict'),
    });
    await release(offered);
    return { review, verdict, head: manifest.head as string };
  };

  /** Offer a review under `by` and, if admitted, give it back and wait until the claim is free. */
  const probeReview = async (
    by: Authority,
    instanceId: string,
    revision: number,
    reviewId: string,
  ) => {
    const offered = await attempt(() => offer(by, instanceId, revision));
    if (!offered.ok) return { offer: offered, freed: null as Attempt<unknown> | null };
    await release(offered.value);
    const freed = await attempt(() =>
      settled(
        async () => (await ctx.reviews.get(human, reviewId)).status === 'requested',
        'the probe claim to be freed',
        30,
      ),
    );
    return { offer: offered as Attempt<Offered>, freed };
  };

  // ------------------------------------------------------------------ the research cycle, as the owner runs it
  const define = async () => {
    const paper = await ctx.paper.read(human);
    await call('paper.patch', human, {
      kind: 'problem',
      expectedRevision: paper.documents.problem.current.revision,
      requestId: id('problem'),
      changes: [
        {
          id: 'problem',
          content: 'Does weight decay alone move the grokking step on modular addition?',
        },
        {
          id: 'scope',
          content: 'Addition modulo 97 with a one-layer transformer and the pinned harness.',
        },
        {
          id: 'goals',
          content: 'Retain independently reviewed code and evidence for each setting.',
        },
        {
          id: 'constraints',
          content: 'Local compute only; every result comes from the repository.',
        },
      ],
    });
  };
  const cycle = async (researchId: string) => await call('research.get', human, { researchId });
  const advance = async (researchId: string, choice: Record<string, unknown> = {}) =>
    await call('research.advance', human, {
      researchId,
      expectedRevision: (await cycle(researchId)).workflow.revision,
      requestId: id('advance'),
      ...choice,
    });
  /** Five leased lenses, a leased synthesis with its plan, and an independent leased review. */
  const reflect = async (
    reflectionId: string,
    plan: object,
    producer: Authority,
    reviewer: Authority,
    probe?: (wave: any) => Promise<void>,
  ) => {
    let wave = await ctx.reflections.get(human, reflectionId);
    const lensSessions: string[] = [];
    for (const lens of wave.lenses) {
      const held = await leaseBare(producer, lens.id, lens.workflow.revision);
      const artifact = await call('artifact.create', held.worker, {
        title: `Lens: ${lens.perspective}`,
        content: `# Summary\nThe ${lens.perspective} lens read the accepted work and its commit.\n\n# Evidence\nThe accepted task and its delivered commit are the only evidence; no empirical claim is made.`,
      });
      await call('reflection.submit_lens', held.worker, {
        lensId: lens.id,
        artifactId: artifact.id,
        expectedRevision: lens.workflow.revision,
        requestId: id('lens'),
      });
      await release(held);
      lensSessions.push(held.session.id);
    }
    wave = await ctx.reflections.get(human, reflectionId);
    const synthesis = await leaseBare(producer, wave.id, wave.workflow.revision);
    const reportArtifact = await call('artifact.create', synthesis.worker, {
      title: 'Synthesis report',
      content:
        '# Summary\nAll five lenses agree the accepted code is ready for main and one follow-up task remains.\n',
      mediaType: 'text/markdown',
    });
    const spec = await call('artifact.create', synthesis.worker, {
      title: 'Change specification',
      content: JSON.stringify(plan),
      mediaType: 'application/json',
    });
    wave = await call('reflection.submit', synthesis.worker, {
      reflectionId: wave.id,
      reportArtifactId: reportArtifact.id,
      changeSpecArtifactId: spec.id,
      expectedRevision: wave.workflow.revision,
      requestId: id('synthesis'),
    });
    await release(synthesis);
    if (probe) await probe(wave);
    const reviewing = await leaseBare(reviewer, wave.id, wave.workflow.revision);
    const review = await ctx.reviews.get(reviewer.caller, wave.review.id);
    wave = await call('review.submit', reviewing.worker, {
      reviewId: review.id,
      claimId: review.claimId,
      expectedRevision: wave.workflow.revision,
      verdict: 'pass',
      synopsis: 'The synthesis follows all five lens reports and its plan names reviewable work.',
      findings: review.criteria.map((_: string, index: number) => ({
        criterionNumber: index + 1,
        status: 'met',
        evidenceIds: [review.artifactIds[0]],
        notes: 'Checked against the pinned lens reports and change specification.',
      })),
      notes: 'Approving the reflection.',
      requestId: id('reflection-verdict'),
    });
    await release(reviewing);
    return {
      wave,
      lensSessions,
      synthesisSession: synthesis.session.id,
      reviewSession: reviewing.session.id,
      reviewId: review.id,
    };
  };

  return {
    ctx,
    code,
    project,
    human,
    ownerPrincipal,
    K1,
    K2,
    WB,
    id,
    call,
    source,
    commitIn,
    importCommit,
    main0,
    published,
    remote,
    remoteRef,
    settled,
    baseStatus,
    based,
    offer,
    manifestOf,
    leaseWriter,
    release,
    commit,
    mergeStart,
    mergeComplete,
    handOver,
    deliver,
    produce,
    offerReview,
    passGit,
    probeReview,
    define,
    cycle,
    advance,
    reflect,
  };
}
type Bed = Awaited<ReturnType<typeof stand>>;

const plan = (title: string) => ({
  version: 2,
  changes: 'Integrate the accepted harness change into main and follow it with a sweep task.',
  next: {
    decision: 'continue',
    name: `${title}: wave 2`,
    rationale: 'The lenses agree the harness is ready and the sweep is the next open question.',
  },
  items: [
    {
      key: 'sweep',
      kind: 'task',
      workspace: { provider: 'code', version: 1 },
      title: 'Sweep weight decay on the integrated harness',
      goal: 'Run the weight-decay sweep on the harness main now holds.',
      checks: ['The sweep configuration is recorded in the repository'],
      dependsOn: [],
      rationale: 'The method lens named weight decay as the next untested setting.',
    },
  ],
  carriedOver: [],
  rejected: [],
});

// ---------------------------------------------------------------------------------------------
// Steps 1-7: the consolidation journey on a GitHub-published project

async function journey(app: App) {
  const b = await stand(app, 'main', true);
  const { ctx, code, human, K1, K2, WB } = b;
  const evidence: Record<string, any> = { projectId: b.project.id };
  const probes: {
    step: string;
    expected: string;
    actual: string;
    evidence: Record<string, unknown>;
  }[] = [];

  // 1. A Code-hosted project and one accepted Git task with a real commit.
  const task = await step(
    '1',
    'A Code-hosted project; one accepted Git task (task@5, code workspace) with a real commit',
    async () => {
      const status = await b.call('code.status', human);
      const created = await b.call('task.create', human, {
        title: 'Stream the training loop',
        goal: 'Make the training loop read batches from a stream.',
        checks: ['The streaming loop is recorded in the repository'],
        workspace: 'git',
        requestId: b.id('task'),
      });
      const produced = await b.produce(
        K1,
        created.id,
        [
          {
            'train/loop.py':
              'def train(model, stream, steps):\n    for _, batch in zip(range(steps), stream):\n        model.step(batch)\n',
          },
        ],
        'Stream the training loop',
      );
      const inReview = await ctx.tasks.get(human, created.id);
      const sameKey = await b.probeReview(
        K1,
        created.id,
        inReview.workflow.revision,
        inReview.reviewId,
      );
      const reviewing = await b.offerReview(WB, created.id);
      await b.passGit(reviewing, created.id);
      const done = await ctx.tasks.get(human, created.id);
      const unit = await code.unit(human, created.id);
      probes.push({
        step: "1'",
        expected:
          '(probe) The same key K1 that directed the producer offers the review of that ordinary Git task',
        actual: `offer under K1: ${said(sameKey.offer)}${sameKey.freed ? `; given back, claim freed: ${said(sameKey.freed)}` : ''}`,
        evidence: sameKey.offer.ok
          ? { sessionId: sameKey.offer.value.session.id }
          : { code: sameKey.offer.code, status: sameKey.offer.status },
      });
      const ok =
        status.project?.durability === 'code' &&
        done.workflow.version === 5 &&
        done.workflow.state === 'done' &&
        unit.acceptance?.reference === produced.head;
      return {
        verdict: ok ? 'PASS' : 'DIFF',
        actual: `durability ${status.project?.durability}; task@${done.workflow.version} ${done.workflow.state}; accepted commit ${unit.acceptance?.reference ?? 'none'}`,
        evidence: {
          projectId: b.project.id,
          main: b.main0,
          taskId: created.id,
          head: produced.head,
          producerSession: produced.held.session.id,
          reviewSession: reviewing.session.id,
          storage: unit.acceptance?.storage ?? null,
        },
        value: { id: created.id, head: produced.head },
      };
    },
  );
  evidence.taskId = task.id;
  for (const probe of probes.splice(0))
    report(probe.step, probe.expected, probe.actual, 'INFO', probe.evidence);

  // 2. The cycle over it, to an approved reflection whose plan continues.
  const research = await step(
    '2',
    'Cycle reaches reflecting; 5 lenses + synthesis (report + JSON plan naming one task); independent reviewer approves',
    async () => {
      await b.define();
      const created = await b.call('research.create', human, {
        name: 'Grokking harness',
        dependsOn: [task.id],
        requestId: b.id('research'),
      });
      const researching = await b.advance(created.id);
      const reflecting = await b.advance(created.id);
      const reflected = await b.reflect(
        reflecting.reflectionId,
        plan('Grokking harness'),
        K1,
        WB,
        async (wave) => {
          const sameOwner = await b.probeReview(
            K2,
            wave.id,
            wave.workflow.revision,
            wave.review.id,
          );
          probes.push({
            step: "2'",
            expected:
              '(probe) K2, another key of the person whose K1 directed the lenses and synthesis, offers the reflection review',
            actual: `offer under K2: ${said(sameOwner.offer)}${sameOwner.offer.ok ? '' : ` (${sameOwner.offer.message})`}${sameOwner.freed ? `; given back, claim freed: ${said(sameOwner.freed)}` : ''}`,
            evidence: sameOwner.offer.ok
              ? { sessionId: sameOwner.offer.value.session.id }
              : { code: sameOwner.offer.code, status: sameOwner.offer.status },
          });
        },
      );
      const approved = await ctx.reflections.get(human, reflecting.reflectionId);
      const ok =
        researching.workflow.state === 'researching' &&
        reflecting.workflow.state === 'reflecting' &&
        approved.workflow.state === 'approved';
      return {
        verdict: ok ? 'PASS' : 'DIFF',
        actual: `cycle ${researching.workflow.state} -> ${reflecting.workflow.state}; reflection ${approved.workflow.state}`,
        evidence: {
          researchId: created.id,
          cycleVersion: created.workflow.version,
          reflectionId: reflecting.reflectionId,
          lensSessions: reflected.lensSessions.length,
          synthesisSession: reflected.synthesisSession,
          reflectionReviewId: reflected.reviewId,
          plan: approved.plan
            ? `${approved.plan.next.decision}, ${approved.plan.items.length} item`
            : 'none',
        },
        value: created.id as string,
      };
    },
  );
  evidence.researchId = research;
  for (const probe of probes.splice(0))
    report(probe.step, probe.expected, probe.actual, 'INFO', probe.evidence);

  // 3. Advancing from reflecting injects the consolidation task.
  const consolidation = await step(
    '3',
    'research.advance from reflecting -> consolidating with an injected consolidation task (Git)',
    async () => {
      // The plan's advance names no choice: the injecting advance does not complete the cycle.
      const plain = await attempt(() => b.advance(research));
      // What the refusal asks for; an advance that injects does not use the choice.
      const moved = plain.ok ? plain.value : await b.advance(research, { nextWave: 'create' });
      const taskId = moved.integrations?.at(-1);
      const injected = taskId ? await ctx.tasks.get(human, taskId) : null;
      const unit = taskId ? await code.unit(human, taskId) : null;
      const dependencies = taskId
        ? (await ctx.workflows.dependencies(human, taskId)).dependencies.map((d: any) => d.id)
        : [];
      const successor = moved.successorId ?? null;
      const ok =
        moved.workflow.state === 'consolidating' && !!injected && injected.workflow.version === 6;
      return {
        verdict: ok && plain.ok ? 'PASS' : ok ? 'DIFF' : 'FAIL',
        actual: `advance without nextWave: ${said(plain)}${plain.ok ? '' : ` (${plain.message})`}; ${plain.ok ? '' : 'with nextWave create: '}cycle ${moved.workflow.state}; injected ${injected ? `task@${injected.workflow.version} "${injected.title}" (${injected.workflow.state})` : 'nothing'}; plan work created at inject: ${successor ? 'yes' : 'no'}`,
        evidence: {
          plain: plain.ok ? 'admitted' : { code: plain.code, status: plain.status },
          consolidationTaskId: taskId ?? null,
          checks: injected?.checks.length ?? 0,
          dependsOn: dependencies,
          codeBase: unit?.baseStatus?.status ?? null,
          successorAtInject: successor,
        },
        value: taskId as string,
      };
    },
  );
  evidence.consolidationTaskId = consolidation;

  // 4. W, leased under K1, produces the consolidation and submits its delivery.
  const produced = await step(
    '4',
    'Worker W (leased by K1) commits and submits the delivery; no 503 review_owner_unavailable (F6-01)',
    async () => {
      await b.based(consolidation);
      const base = await b.baseStatus(consolidation);
      const held = await b.leaseWriter(K1, await ctx.tasks.get(human, consolidation));
      const made = await b.commit(
        held,
        {
          'CONSOLIDATION.md':
            '# Consolidation\n\nThe streaming loop is integrated with main for this wave.\n',
        },
        'Consolidate the wave onto main',
      );
      const manifest = await b.manifestOf(K1, held.control);
      const delivered = await attempt(() =>
        b.deliver(
          held,
          consolidation,
          made.commandId,
          'The consolidation branch holds every accepted unit and main.',
        ),
      );
      await b.release(held);
      await b.handOver(held, manifest);
      if (!delivered.ok)
        return {
          verdict: 'FAIL',
          actual: `task.submit_delivery refused: ${delivered.code} ${delivered.status ?? ''} ${delivered.message}`,
          evidence: { sessionId: held.session.id, code: delivered.code, status: delivered.status },
          value: null as never,
        };
      const review = await ctx.reviews.get(human, delivered.value.reviewId);
      return {
        verdict: 'PASS',
        actual: `delivered, task ${delivered.value.workflow.state}; review ${review.id} ${review.status}`,
        evidence: {
          wSession: held.session.id,
          wActor: held.worker.actorId,
          base: base.status,
          baseOid: manifest.base,
          head: made.head,
          reviewId: review.id,
          provenance: review.provenance
            ? {
                reference: review.provenance.reference,
                excluded: review.provenance.excludedActorIds.length,
              }
            : null,
          administrativeActorId: review.administrativeActorId ?? null,
        },
        value: {
          head: made.head,
          reviewId: review.id as string,
          wActor: held.worker.actorId as string,
        },
      };
    },
  );

  // 5a. A reviewer directed by the same key as W.
  await step(
    '5a',
    'Reviewer under the SAME key as W is refused with review_independence',
    async () => {
      const offered = await attempt(() => b.offerReview(K1, consolidation));
      let at = 'offer',
        claim: Attempt<unknown> | null = null;
      if (offered.ok) {
        at = 'after offer';
        claim = await attempt(() => b.passGit(offered.value, consolidation));
        await attempt(() => b.release(offered.value));
      } else {
        // The interactive claim, without a lease, is the other door a reviewer could try.
        claim = await attempt(() =>
          b.call('review.start', K1.caller, { reviewId: produced.reviewId }),
        );
        at = claim.ok ? 'offer only (the interactive claim was admitted)' : 'offer and claim';
      }
      const review = await ctx.reviews.get(human, produced.reviewId);
      const refused = !offered.ok && offered.code === 'review_independence' && claim && !claim.ok;
      return {
        verdict: refused ? 'PASS' : 'DIFF',
        actual: `offer: ${said(offered)}; claim: ${claim ? said(claim) : 'not tried'}; refused at ${at}; review ${review.status}`,
        evidence: {
          offer: offered.ok
            ? { sessionId: offered.value.session.id }
            : { code: offered.code, status: offered.status },
          claim: claim
            ? claim.ok
              ? 'admitted'
              : { code: claim.code, status: claim.status }
            : null,
          reviewStatus: review.status,
        },
        value: null,
      };
    },
  );

  // 5b'. Not in the plan: another key of the SAME person. Production keys are user keys, and a
  // user key speaks for its owner's membership actor, so two keys of one person are one authority.
  await step(
    "5b'",
    '(probe) Reviewer under a different mk_ key of the same person as K1',
    async () => {
      const offered = await attempt(() => b.offerReview(K2, consolidation));
      if (offered.ok) await attempt(() => b.release(offered.value));
      return {
        verdict: 'INFO',
        actual: `offer under K2: ${said(offered)}${offered.ok ? '' : ` (${offered.message})`}; K1 actor ${K1.caller.actorId}, K2 actor ${K2.caller.actorId}`,
        evidence: {
          sameActor: K1.caller.actorId === K2.caller.actorId,
          ...(offered.ok ? {} : { code: offered.code }),
        },
        value: null,
      };
    },
  );

  // 5b. The independent reviewer W-B passes it.
  const accepted = await step(
    '5b',
    'Reviewer under a different key W-B passes; the consolidation task is accepted',
    async () => {
      const offered = await b.offerReview(WB, consolidation);
      const passed = await b.passGit(offered, consolidation);
      const done = await ctx.tasks.get(human, consolidation);
      const unit = await code.unit(human, consolidation);
      const ok = done.workflow.state === 'done' && unit.acceptance?.reference === produced.head;
      return {
        verdict: ok ? 'PASS' : 'DIFF',
        actual: `task ${done.workflow.state}; acceptance ${unit.acceptance?.reference ?? 'none'}; publication ${unit.publication?.state ?? 'none'}`,
        evidence: {
          reviewSession: offered.session.id,
          reviewId: passed.review.id,
          reviewedHead: passed.head,
          publication: unit.publication?.state ?? null,
        },
        value: unit,
      };
    },
  );

  // 6. The publication: pending, then merged by a signed-in person.
  await step(
    '6',
    'Publication pending; merged via code.publication.merge (signed-in human required); reaches merged',
    async () => {
      const remote = b.remote!;
      const pendingAtAcceptance = accepted.publication?.state ?? 'none';
      // The runner reconciles publications on its heartbeat, at most once per 30 s per record.
      const syncedBy: string[] = [];
      let publication: any;
      await b.settled(
        async () => {
          const synced = await attempt(() => b.call('code.publication.sync', K1.caller));
          syncedBy.push(said(synced));
          publication = (await code.publications(human)).find(
            (item: any) => item.instanceId === consolidation,
          );
          if (publication?.pull) return true;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return false;
        },
        'the sync to open the pull request',
        60,
      );
      const opened = await code.unit(human, consolidation);
      const input = {
        proposalId: publication.proposalId,
        expectedHead: publication.headOid,
        expectedBase: remote.branches.get('main'),
      };
      const byKey = await attempt(() =>
        b.call('code.publication.merge', K1.caller, { ...input, requestId: b.id('merge-key') }),
      );
      const byWorker = await attempt(() =>
        b.call('code.publication.merge', WB.caller, { ...input, requestId: b.id('merge-key-b') }),
      );
      const byHuman = await attempt(() =>
        b.call('code.publication.merge', human, { ...input, requestId: b.id('merge') }),
      );
      const after = await code.unit(human, consolidation);
      const status = await b.call('code.status', human);
      const merged = byHuman.ok && after.publication?.state === 'published';
      return {
        verdict:
          merged && pendingAtAcceptance === 'pending' && !byKey.ok
            ? 'PASS'
            : merged
              ? 'DIFF'
              : 'FAIL',
        actual: `at acceptance ${pendingAtAcceptance}; after sync ${opened.publication?.state} PR #${publication.pull.number}; merge by K1 key: ${said(byKey)}; by W-B key: ${said(byWorker)}; by signed-in owner: ${said(byHuman)}${byHuman.ok ? '' : ` (${byHuman.message})`}; now ${after.publication?.state}`,
        evidence: {
          proposalId: publication.proposalId,
          pull: publication.pull.number,
          syncAttempts: syncedBy.length,
          sync: syncedBy.at(-1),
          mergeCommit: after.publication?.mergeCommit ?? null,
          verified: byHuman.ok ? (byHuman.value as any).verified : null,
          codeMain: status.project?.main?.oid ?? null,
          githubMain: b.remoteRef('refs/heads/main'),
          keyRefusal: byKey.ok ? null : byKey.code,
        },
        value: null,
      };
    },
  );

  // 7. The cycle completes and the next wave opens.
  await step(
    '7',
    'research.advance {nextWave: create} completes the cycle; digest exists; next cycle and its work created',
    async () => {
      const withoutChoice = await attempt(() => b.advance(research));
      const done = await b.advance(research, { nextWave: 'create' });
      const successor = done.successorId ? await b.cycle(done.successorId) : null;
      const work = successor
        ? await Promise.all(
            successor.researchDependencies.map(
              async (depId: string) => await ctx.tasks.get(human, depId).catch(() => null),
            ),
          )
        : [];
      const digest = done.digest?.id
        ? await b.call('artifact.read', human, { artifactId: done.digest.id })
        : null;
      const lineage = successor
        ? await b.call('research.lineage', human, { researchId: successor.id })
        : null;
      const ok =
        done.workflow.state === 'complete' &&
        !!digest &&
        !!successor &&
        work.length === 1 &&
        !!work[0];
      return {
        verdict: ok ? 'PASS' : 'DIFF',
        actual: `advance without nextWave: ${said(withoutChoice)}; cycle ${done.workflow.state}; digest ${done.digest?.id ?? 'none'}; successor ${successor ? `${successor.id} (${successor.workflow.state})` : 'none'}; next-wave work ${work.map((item: any) => (item ? `task@${item.workflow.version} ${item.workflow.state}` : '?')).join(', ') || 'none'}`,
        evidence: {
          noChoice: withoutChoice.ok ? 'admitted' : withoutChoice.code,
          digestId: done.digest?.id ?? null,
          digestIntegration: digest
            ? (JSON.parse(digest.content ?? '{}').integration ?? null)
            : null,
          successorId: successor?.id ?? null,
          nextWork: successor?.researchDependencies ?? [],
          lineage: lineage ? (lineage.cycles?.length ?? null) : null,
        },
        value: null,
      };
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Step 8: main moved in a conflicting way before consolidation

async function clash(app: App) {
  const b = await stand(app, 'clash', false);
  const { ctx, code, human, K1, WB } = b;

  const setup = await step(
    '8.1',
    'A accepted on main0; main then moves onto the same line A changed',
    async () => {
      const created = await b.call('task.create', human, {
        title: 'Change the optimizer',
        goal: 'Switch the base configuration to SGD.',
        checks: ['The configuration change is recorded in the repository'],
        workspace: 'git',
        requestId: b.id('task'),
      });
      const produced = await b.produce(
        K1,
        created.id,
        [{ 'configs/base.yaml': 'optimizer: sgd\nweight_decay: 1.0\n' }],
        'Switch to SGD',
      );
      const reviewing = await b.offerReview(WB, created.id);
      await b.passGit(reviewing, created.id);
      // Somebody moves main: the same line, changed another way, imported and named as main.
      const moved = b.commitIn(
        b.source,
        { 'configs/base.yaml': 'optimizer: adamw\nweight_decay: 0.1\n' },
        'Lower weight decay on main',
      );
      await b.importCommit(moved, [b.main0]);
      await b.call('code.local.bind', human, {
        repositoryId: 'bed-clash',
        mainOid: moved,
        expectedMainOid: b.main0,
        requestId: b.id('move-main'),
      });
      const status = await b.call('code.status', human);
      const done = await ctx.tasks.get(human, created.id);
      return {
        verdict:
          done.workflow.state === 'done' && status.project?.main?.oid === moved ? 'PASS' : 'DIFF',
        actual: `task ${done.workflow.state} at ${produced.head}; main ${b.main0.slice(0, 8)} -> ${status.project?.main?.oid?.slice(0, 8)}`,
        evidence: {
          projectId: b.project.id,
          taskId: created.id,
          accepted: produced.head,
          main: moved,
        },
        value: { taskId: created.id as string, accepted: produced.head, main: moved },
      };
    },
  );

  const consolidation = await step(
    '8.2',
    'Reflection approved and research.advance injects the consolidation task; its base merge with main conflicts and a resolution task appears',
    async () => {
      await b.define();
      const created = await b.call('research.create', human, {
        name: 'Optimizer choice',
        dependsOn: [setup.taskId],
        requestId: b.id('research'),
      });
      await b.advance(created.id);
      const reflecting = await b.advance(created.id);
      await b.reflect(reflecting.reflectionId, plan('Optimizer choice'), K1, WB);
      // As step 3 found, the injecting advance must name the next-wave choice when the plan continues.
      const moved = await b.advance(created.id, { nextWave: 'create' });
      const taskId = moved.integrations.at(-1);
      const base = (await b.settled(async () => {
        const bases = (await b.call('code.status', human)).bases ?? [];
        return (
          bases.find(
            (item: any) => item.members?.includes(setup.accepted) && item.resolutionTaskId,
          ) ?? null
        );
      }, 'the conflicted base and its resolution task')) as any;
      const blocked = await b.baseStatus(taskId);
      const resolution = await ctx.tasks.get(human, base.resolutionTaskId);
      return {
        verdict:
          moved.workflow.state === 'consolidating' && base.state === 'awaiting_resolution'
            ? 'PASS'
            : 'DIFF',
        actual: `cycle ${moved.workflow.state}; base ${base.state} (${base.conflict?.paths?.join(', ') ?? 'no paths'}); consolidation base ${blocked.status}; resolution task@${resolution.workflow.version} "${resolution.title}"`,
        evidence: {
          researchId: created.id,
          consolidationTaskId: taskId,
          baseKey: base.key,
          members: base.members,
          resolutionTaskId: base.resolutionTaskId,
        },
        value: {
          taskId: taskId as string,
          resolutionTaskId: base.resolutionTaskId as string,
          baseKey: base.key as string,
        },
      };
    },
  );

  const resolved = await step(
    '8.3',
    'A worker leased by K1 runs code.merge start/complete and delivers the resolution',
    async () => {
      const held = await b.leaseWriter(
        K1,
        await ctx.tasks.get(human, consolidation.resolutionTaskId),
      );
      const pending = (await b.manifestOf(K1, held.control)).pendingMerge;
      await b.mergeStart(held);
      const merged = await b.mergeComplete(held, {
        'configs/base.yaml': 'optimizer: sgd\nweight_decay: 0.1\n',
      });
      const manifest = await b.manifestOf(K1, held.control);
      const delivered = await attempt(() =>
        b.deliver(
          held,
          consolidation.resolutionTaskId,
          merged.commandId,
          'The merge keeps SGD from the task and the lower weight decay from main.',
        ),
      );
      await b.release(held);
      await b.handOver(held, manifest);
      if (!delivered.ok)
        return {
          verdict: 'FAIL',
          actual: `task.submit_delivery refused: ${delivered.code} ${delivered.status ?? ''} ${delivered.message}`,
          evidence: { code: delivered.code, status: delivered.status, pending },
          value: null as never,
        };
      return {
        verdict: 'PASS',
        actual: `merge ${merged.conflicted ? 'conflicted and was resolved' : 'was clean'}; delivered, task ${delivered.value.workflow.state}`,
        evidence: {
          sessionId: held.session.id,
          firstParent: pending?.firstParent,
          secondParent: pending?.secondParent,
          head: merged.head,
          reviewId: delivered.value.reviewId,
        },
        value: {
          reviewId: delivered.value.reviewId as string,
          head: merged.head,
          secondParent: pending?.secondParent as string,
        },
      };
    },
  );

  await step(
    '8.4',
    'Review of the resolution fails with 409 code_provenance_unverifiable (finding F12: main is a base member no unit accepted)',
    async () => {
      const review = await ctx.reviews.get(human, resolved.reviewId);
      const offered = await attempt(() => b.offerReview(WB, consolidation.resolutionTaskId));
      let submitted: Attempt<unknown> | null = null;
      if (offered.ok)
        submitted = await attempt(() => b.passGit(offered.value, consolidation.resolutionTaskId));
      if (offered.ok && submitted && !submitted.ok) await attempt(() => b.release(offered.value));
      const task = await ctx.tasks.get(human, consolidation.resolutionTaskId);
      const base = ((await b.call('code.status', human)).bases ?? []).find(
        (item: any) => item.key === consolidation.baseKey,
      );
      const failure = !offered.ok ? offered : submitted && !submitted.ok ? submitted : null;
      const expected = failure?.code === 'code_provenance_unverifiable' && failure.status === 409;
      return {
        verdict: expected ? 'PASS' : 'DIFF',
        actual: `offer: ${said(offered)}; verdict: ${submitted ? said(submitted) : 'not reached'}${failure ? ` (${failure.message})` : ''}; resolution task ${task.workflow.state}; base ${base?.state ?? '?'}`,
        evidence: {
          reviewId: review.id,
          provenance: review.provenance
            ? {
                reference: review.provenance.reference,
                excluded: review.provenance.excludedActorIds.length,
              }
            : null,
          failure: failure ? { code: failure.code, status: failure.status } : null,
          baseResult: base?.result?.commit ?? null,
        },
        value: null,
      };
    },
  );

  await step(
    '8.5',
    '(beyond the plan) the resolved base seals, and the consolidation is produced on it and accepted',
    async () => {
      const records = async () => ((await b.call('code.status', human)).bases ?? []) as any[];
      const resolvedBase = (await attempt(() =>
        b.settled(
          async () =>
            (await records()).find(
              (item) => item.key === consolidation.baseKey && item.state !== 'awaiting_resolution',
            ) ?? null,
          'the resolved base to seal',
          30,
        ),
      )) as Attempt<any>;
      const resolutionUnit = await code.unit(human, consolidation.resolutionTaskId);
      const base = resolvedBase.ok
        ? resolvedBase.value
        : (await records()).find((item) => item.key === consolidation.baseKey);
      if (!resolvedBase.ok)
        return {
          verdict: 'DIFF',
          actual: `base still ${base?.state} after 30 s; resolution acceptance ${resolutionUnit.acceptance?.reference ?? 'none'}; consolidation base ${(await b.baseStatus(consolidation.taskId)).status}`,
          evidence: { base: base ?? null, resolutionAcceptance: resolutionUnit.acceptance ?? null },
          value: null,
        };
      await b.based(consolidation.taskId);
      const held = await b.leaseWriter(K1, await ctx.tasks.get(human, consolidation.taskId));
      const made = await b.commit(
        held,
        {
          'CONSOLIDATION.md': '# Consolidation\n\nSGD from the task, weight decay 0.1 from main.\n',
        },
        'Consolidate onto the resolved base',
      );
      const manifest = await b.manifestOf(K1, held.control);
      const delivered = await attempt(() =>
        b.deliver(
          held,
          consolidation.taskId,
          made.commandId,
          'The consolidation stands on the resolved merge of the task and main.',
        ),
      );
      await b.release(held);
      await b.handOver(held, manifest);
      let reviewed: Attempt<unknown> | null = null;
      if (delivered.ok) {
        const offered = await attempt(() => b.offerReview(WB, consolidation.taskId));
        reviewed = offered.ok
          ? await attempt(() => b.passGit(offered.value, consolidation.taskId))
          : offered;
      }
      const task = await ctx.tasks.get(human, consolidation.taskId);
      const unit = await code.unit(human, consolidation.taskId);
      return {
        verdict: task.workflow.state === 'done' ? 'INFO' : 'DIFF',
        actual: `base ${base.state} at ${base.result?.commit ?? '?'}; consolidation delivery: ${said(delivered)}; review by W-B: ${reviewed ? said(reviewed) : 'not reached'}${reviewed && !reviewed.ok ? ` (${reviewed.message})` : ''}; task ${task.workflow.state}; publication ${unit.publication?.state ?? 'none'}`,
        evidence: {
          baseResult: base.result?.commit ?? null,
          resolutionAcceptance: resolutionUnit.acceptance?.reference ?? null,
          consolidationBase: manifest.base,
          head: made.head,
          delivery: delivered.ok ? 'admitted' : { code: delivered.code, status: delivered.status },
          review: reviewed
            ? reviewed.ok
              ? 'admitted'
              : { code: reviewed.code, status: reviewed.status }
            : null,
        },
        value: null,
      };
    },
  );
}

// ---------------------------------------------------------------------------------------------

/** Drop this run's schema and directory, whatever happened, unless BED_KEEP asks to keep them. */
async function cleanUp(directory: string) {
  if (keep) return console.log(`bed: kept schema ${schema} and ${directory}`);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
  rmSync(directory, { recursive: true, force: true });
}

async function run(directory: string) {
  fakeGitHub();
  console.log(`[${elapsed()}] bed: schema ${schema}, directory ${directory}`);
  const app = await createApp({
    directory,
    configFile: defaultConfigFile,
    host: '127.0.0.1',
    port: 0,
  });
  console.log(`[${elapsed()}] bed: server up at ${app.ctx.api.url}`);
  stepStarted = Date.now();
  try {
    for (const [name, chain] of [
      ['journey', journey],
      ['clash', clash],
    ] as const) {
      try {
        await chain(app);
      } catch (error) {
        if (!(error instanceof Stopped)) {
          const r = refusal(error);
          report(
            `${name}:setup`,
            'the bed stands the project up',
            `threw ${r.code}: ${r.message}`,
            'FAIL',
            {
              at: (error instanceof Error ? (error.stack ?? '') : '')
                .split('\n')
                .slice(1, 5)
                .map((line) => line.trim()),
            },
          );
        } else console.log(`[${elapsed()}] ${name}: stopped after step ${error.message}`);
      }
    }
  } finally {
    await app.stop().catch((error: unknown) => console.error('bed: stop failed', refusal(error)));
  }
  const took = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n| step | verdict | expected | actual | evidence |\n|---|---|---|---|---|');
  for (const row of rows)
    console.log(
      `| ${row.step} | ${row.verdict} | ${row.expected} | ${row.actual.replaceAll('|', '/')} | \`${JSON.stringify(row.evidence).replaceAll('|', '/')}\` |`,
    );
  console.log(
    `\nbed: ${rows.length} steps in ${took}s; ${['PASS', 'DIFF', 'FAIL', 'INFO'].map((v) => `${rows.filter((row) => row.verdict === v).length} ${v}`).join(', ')}`,
  );
  return rows.some((row) => row.verdict === 'FAIL') ? 1 : 0;
}
const directory = mkdtempSync(join(tmpdir(), 'merv-qa-bed-j9-'));
let exitCode = 2;
try {
  exitCode = await run(directory);
} catch (error) {
  console.error(error);
} finally {
  await cleanUp(directory).catch((error: unknown) =>
    console.error('bed: clean-up failed', refusal(error)),
  );
}
process.exit(exitCode);
