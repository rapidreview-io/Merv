import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { importRepository } from '../src/code-import.js';
import type { CodeProjectStatus, CodeStoreOperation, Task } from '@merv/contracts';

/**
 * Take the Git model through a running server's own HTTP/MCP surface: bind a project to a
 * repository, import a three-commit history the way `merv code-import` does, and confirm the
 * project is hosted and that new Git work is created on the hosted version.
 *
 *   MERV_URL=https://dev-experiments.rapidreview.io MERV_KEY=… \
 *     [MERV_PROJECT=project_…] node --import tsx scripts/git-model-scenario.ts
 *
 * MERV_KEY is a bearer with project admin. `code.local.bind` accepts only a signed-in human
 * (`code_human_required` refuses a machine key and a leased worker), so a machine key needs
 * MERV_PROJECT to name a project a human has already bound to this scenario's repository id.
 * Creating the scratch project is a human-only route as well. Everything after the binding —
 * the import, `code.status` and `task.create` — accepts a project-admin machine key.
 *
 * The scratch repository is byte-for-byte reproducible, so the same run against the same
 * project replays rather than importing twice: a bind that would not move main is skipped, a
 * history the store already holds is not sent again, and `task.create` replays its request id.
 *
 * This is the first half of the model. Driving the task through commit, delivery and review
 * needs a machine: `merv runner` composed with Code's `code.v2` workspace driver, advertising
 * that capability in its heartbeat, because a hosted task's execution policy names it (see
 * docs/MACHINE_RUNNER.md and packages/runner). Nothing here leases, launches or writes code.
 */

/** The repository identity this scenario binds. A project bound to another one is left alone. */
const REPOSITORY_ID = 'git-model-scenario';
/** Fixed identity and timestamps: the three commit ids are the same on every machine. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Merv scenario',
  GIT_AUTHOR_EMAIL: 'scenario@merv.test',
  GIT_COMMITTER_NAME: 'Merv scenario',
  GIT_COMMITTER_EMAIL: 'scenario@merv.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00+0000',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00+0000',
};
const COMMITS = [
  { file: 'README.md', content: '# Git model scenario\n', message: 'Start the scenario history' },
  { file: 'answer.txt', content: '41\n', message: 'Record a first answer' },
  { file: 'answer.txt', content: '42\n', message: 'Correct the answer' },
];

export interface GitModelScenarioOptions {
  /** The running server's origin, https or a loopback http URL. */
  url: string;
  /** A bearer with project admin; never logged and never written to the report. */
  token: string;
  /** An existing scratch project. Omitted, the scenario creates one (human bearer only). */
  projectId?: string;
  onCheckpoint?: (value: unknown) => void;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const text = (result.content as { type: string; text?: string }[]).find(
    (block) => block.type === 'text',
  )?.text;
  assert.equal(result.isError, undefined, `${name} was refused: ${text ?? 'no reason given'}`);
  assert.ok(text, `${name} returned no text content`);
  return JSON.parse(text) as T;
}

/** Only a verified human may create a project; there is no tool and no client for this route. */
async function createScratchProject(url: string, token: string) {
  const name = `Git model scenario ${new Date().toISOString().slice(0, 16)}Z`;
  const response = await fetch(new URL('/projects', url), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, requestId: `git-model-scenario:${name}` }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    project?: { id: string };
    error?: { code: string; message: string };
  };
  assert.equal(
    response.status,
    200,
    `POST /projects answered ${response.status} (${body.error?.code ?? 'no code'}). Only a ` +
      'signed-in human may create a project: set MERV_PROJECT to a scratch project when ' +
      'MERV_KEY is a machine key.',
  );
  assert.ok(body.project?.id, 'POST /projects returned no project');
  return body.project.id;
}

/** Real server, real HTTP and MCP, real Git. Nothing here is stubbed and nothing is launched. */
export async function runGitModelScenario(options: GitModelScenarioOptions) {
  const url = new URL(options.url).origin;
  const checkpoints: unknown[] = [];
  const checks: Record<string, boolean> = {};
  const checkpoint = (phase: string, details: Record<string, unknown> = {}) => {
    const item = { phase, ...details };
    checkpoints.push(item);
    options.onCheckpoint?.(item);
  };
  const directory = mkdtempSync(join(tmpdir(), 'merv-git-model-'));
  const repository = join(directory, 'source');
  const client = new Client({ name: 'merv-git-model-scenario', version: '1' });
  try {
    mkdirSync(repository, { mode: 0o700 });
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...GIT_IDENTITY,
    };
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', env }).trim();
    git('init', '-b', 'main');
    for (const commit of COMMITS) {
      writeFileSync(join(repository, commit.file), commit.content);
      git('add', '--all');
      git('commit', '-m', commit.message);
    }
    const tip = git('rev-parse', 'HEAD');
    assert.equal(git('rev-list', '--count', 'HEAD'), String(COMMITS.length));
    checks.threeCommitHistory = true;
    checkpoint('repository-built', { tip, commits: COMMITS.length });

    const projectId = options.projectId ?? (await createScratchProject(url, options.token));
    checks.scratchProjectCreated = options.projectId === undefined;
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', url), {
        requestInit: {
          redirect: 'error',
          headers: {
            authorization: `Bearer ${options.token}`,
            'x-merv-project-id': projectId,
          },
        },
      }),
      { timeout: 30_000 },
    );
    checkpoint('connected', { url, projectId });

    const before = await call<CodeProjectStatus>(client, 'code.status');
    assert.ok(before.store, 'This server keeps no Code repositories: code.status.store is null');
    checks.serverKeepsRepositories = true;
    assert.ok(
      !before.project || before.project.repositoryId === REPOSITORY_ID,
      `Project ${projectId} is already bound to ${before.project?.repositoryId}. Run this ` +
        'scenario against a scratch project; it never rebinds somebody else’s repository.',
    );

    // Main is named before the history arrives; the import that delivers it marks it stored.
    const binding =
      before.project && before.project.main.oid === tip
        ? before.project
        : await call<NonNullable<CodeProjectStatus['project']>>(client, 'code.local.bind', {
            repositoryId: REPOSITORY_ID,
            mainOid: tip,
            ...(before.project ? { expectedMainOid: before.project.main.oid } : {}),
            requestId: `git-model-scenario.bind.${tip.slice(0, 12)}`,
          });
    assert.equal(binding.mode, 'local');
    assert.equal(binding.repositoryId, REPOSITORY_ID);
    assert.equal(binding.main.oid, tip);
    checks.boundToNamedMain = true;
    checkpoint('bound', { repositoryId: binding.repositoryId, mainOid: binding.main.oid });

    // The same path `merv code-import` takes: bundle the ref locally, send it in parts, wait
    // for admission. A rerun finds the tip already held and sends nothing.
    const held = before.store.tips.includes(tip);
    const operation: CodeStoreOperation | null = held
      ? null
      : await importRepository({
          url,
          repository,
          ref: 'main',
          token: options.token,
          projectId,
        });
    if (operation)
      assert.equal(
        operation.status,
        'completed',
        // Findings never carry the matched text, only the rule and where it fired.
        `Import ${operation.id} ended ${operation.status}: ${operation.error ?? ''} ${operation.findings
          .map((finding) => `${finding.rule} ${finding.path ?? ''}`.trim())
          .join(', ')}`,
      );
    checks.historyImported = true;
    checkpoint('imported', {
      operationId: operation?.id ?? null,
      head: operation?.head ?? tip,
      alreadyHeld: held,
    });

    const after = await call<CodeProjectStatus>(client, 'code.status');
    assert.ok(after.store);
    assert.equal(after.store.hosted, true, 'The store must be hosted once history is imported');
    assert.ok(after.project, 'code.status lost the binding');
    assert.equal(after.project.durability, 'code');
    assert.equal(after.project.main.oid, tip);
    assert.ok(
      after.store.tips.includes(after.project.main.oid),
      `store.tips ${after.store.tips.join(', ')} does not cover main ${after.project.main.oid}`,
    );
    assert.equal(after.project.main.stored, true, 'Code must hold the commit main names');
    checks.projectHosted = checks.tipsCoverMain = true;
    checkpoint('hosted', {
      durability: after.project.durability,
      tips: after.store.tips,
      mainStored: after.project.main.stored,
      objectFormat: after.store.objectFormat,
    });

    // The rule under test: a Git task with no baseTaskId in a hosted project is task@5.
    const task = await call<Task>(client, 'task.create', {
      title: 'Git model smoke: hosted Git task',
      goal: 'Confirm that new Git work in a hosted project is created on the hosted version.',
      checks: ['The task is created on task@5 with workspace git.'],
      workspace: 'git',
      requestId: `git-model-scenario:task:${tip.slice(0, 12)}`,
    });
    assert.equal(task.workspace, 'git');
    assert.equal(task.baseTaskId, undefined, 'This task must have no explicit base');
    assert.equal(task.workflow.workflow, 'task');
    assert.equal(
      task.workflow.version,
      5,
      `A Git task without baseTaskId in a hosted project must be task@5, got task@${task.workflow.version}`,
    );
    const read = await call<Task>(client, 'task.get', { taskId: task.id });
    assert.equal(read.workflow.version, 5);
    assert.equal(read.id, task.id);
    checks.hostedGitTaskVersion = true;
    checkpoint('task-created', {
      taskId: task.id,
      version: task.workflow.version,
      state: task.workflow.state,
    });

    return {
      status: 'passed',
      url,
      projectId,
      repositoryId: REPOSITORY_ID,
      mainOid: tip,
      importOperationId: operation?.id ?? null,
      taskId: task.id,
      taskVersion: task.workflow.version,
      checkpoints,
      checks,
      nextStep:
        'Driving this task through code.commit, task.submit_delivery and its pinned review ' +
        'needs a machine: `merv runner` with Code’s code.v2 workspace driver, advertising that ' +
        'capability in its heartbeat, plus project dispatch and a producer profile.',
    };
  } finally {
    await client.close().catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const url = process.env.MERV_URL,
    token = process.env.MERV_KEY;
  assert.ok(url && token, 'MERV_URL and MERV_KEY are required; MERV_PROJECT is optional');
  const report = await runGitModelScenario({
    url,
    token,
    ...(process.env.MERV_PROJECT ? { projectId: process.env.MERV_PROJECT } : {}),
    onCheckpoint: (item) => console.log(JSON.stringify(item)),
  });
  console.log(JSON.stringify(report, null, 2));
}
