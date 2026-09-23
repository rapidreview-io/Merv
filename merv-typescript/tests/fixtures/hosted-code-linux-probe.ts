/** Linux-root probe for the image-owned assignment handoff and Code checkout driver. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceSession } from '@merv/contracts';
import { CodeWorkspaceDriver } from '../../packages/code/src/driver/index.js';
import { LocalLedger } from '../../packages/runner/src/ledger.js';
import { GitWorkspaceManager } from '../../packages/runner/src/workspaces.js';

const root = mkdtempSync(join(tmpdir(), 'merv-code-linux-probe-'));
const assignmentRoot = '/workspace/assignments';
const helper = '/opt/merv/python/merv_sandboxes/runtimes/assignment.py';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  }).trim();
let driver: CodeWorkspaceDriver | undefined;
let manager: GitWorkspaceManager | undefined;
let ledger: LocalLedger | undefined;
try {
  assert.equal(process.getuid?.(), 0);
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  writeFileSync(join(source, 'README.md'), 'base\n');
  git(source, 'add', '.');
  git(
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'base',
  );
  const head = git(source, 'rev-parse', 'HEAD');
  const bundlePath = join(root, 'initial.bundle');
  git(source, 'bundle', 'create', bundlePath, 'HEAD');
  const bytes = readFileSync(bundlePath);
  const terminal = new Set<string>();
  const launch = { id: 'launch-linux-probe', sessionId: 'session-linux-probe', runDirectory: root };
  const manifest = {
    projectRef: 'project-linux-probe',
    repositoryId: 'repository-linux-probe',
    objectFormat: 'sha1',
    unitId: 'unit-linux-probe',
    generation: 1,
    mode: 'write',
    head,
    base: head,
    branch: 'merv/work/unit-linux-probe',
    prerequisites: [],
  };
  const session = {
    id: launch.sessionId,
    runnerId: 'runner-linux-probe',
    instanceId: manifest.unitId,
    execution: {
      policy: {
        readOnly: false,
        tools: [],
        workspace: {
          mode: 'persistent',
          namespace: 'tasks',
          base: 'reference:base',
          perBase: false,
          retain: true,
          advancesCentral: false,
          driver: 'code.v2',
        },
      },
      references: { base: head },
    },
  };
  let admissions = 0;
  driver = new CodeWorkspaceDriver(
    {
      directory: join(root, 'private-ledger'),
      path: join(root, 'private-ledger', 'ledger.sqlite'),
      assignmentWorkspaceDirectory: assignmentRoot,
      terminal: (id) => terminal.has(id),
    },
    {
      call: async (route) => {
        if (route === 'workspace') return manifest;
        if (route === 'downloads')
          return {
            download: {
              exportId: 'initial',
              sha256: createHash('sha256').update(bytes).digest('hex'),
              bytes: bytes.length,
              head,
              partBytes: bytes.length,
            },
          };
        if (route === 'uploads' || route === 'finalize')
          return { operation: { id: `admitted-${++admissions}`, status: 'completed' } };
        throw new Error(`unexpected route ${route}`);
      },
      readPart: async (_id, input) => {
        const part = input as { offset: number; length: number };
        return bytes.subarray(part.offset, part.offset + part.length);
      },
      putPart: async () => ({}),
    },
    { pollMs: 1 },
  );
  const handle = await driver.prepare(launch, session as unknown as WorkspaceSession);
  assert.ok(statSync(join(handle.path, '.git')).isDirectory());
  assert.equal(existsSync(join(handle.path, '.git/objects/info/alternates')), false);
  assert.equal(git(handle.path, 'rev-parse', '--git-common-dir'), '.git');
  assert.equal(handle.snapshot?.headOid, head);
  const handoff = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      'import sys; sys.path.insert(0, "/opt/merv/python"); from pathlib import Path; from merv_sandboxes.runtimes.assignment import _workspace; _workspace(Path.cwd())',
    ],
    {
      cwd: handle.path,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
    },
  );
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.equal(statSync(handle.path).uid, 12001);
  assert.equal(statSync(join(handle.path, '.git')).uid, 12001);
  assert.equal(
    execFileSync(helper, ['--git', 'rev-parse', 'HEAD'], {
      cwd: handle.path,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    }).trim(),
    head,
  );
  const writeAsAssignment = (cwd: string, name: string, content: string) => {
    const edit = spawnSync(
      '/usr/bin/python3',
      [
        '-c',
        'import os, sys; from pathlib import Path; os.setgroups([]); os.setgid(12001); os.setuid(12001); Path(sys.argv[1]).write_text(sys.argv[2])',
        name,
        content,
      ],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(edit.status, 0, edit.stderr);
  };
  writeAsAssignment(handle.path, 'edit.txt', 'assignment edit\n');
  const command = {
    id: 'command-linux-probe',
    projectId: manifest.projectRef,
    sessionId: session.id,
    actorId: 'actor-linux-probe',
    instanceId: manifest.unitId,
    expectedRevision: 0,
    runnerId: session.runnerId,
    hostRef: launch.id,
    workspace: handle.snapshot!,
    expectedHead: head,
    message: 'checkpoint',
    createdAt: '2026-09-23T12:34:56.000Z',
  };
  const receipt = await driver.checkpointCommit(launch, command);
  assert.notEqual(receipt.headOid, head);
  assert.equal(readFileSync(join(handle.path, 'edit.txt'), 'utf8'), 'assignment edit\n');
  writeAsAssignment(handle.path, 'final.txt', 'final capture\n');
  terminal.add(launch.id);
  const final = await driver.capture(launch);
  assert.ok(final && final.headOid !== receipt.headOid);
  await driver.close(launch);
  ledger = new LocalLedger({
    directory: join(root, 'git-ledger'),
    binding: {
      baseUrl: 'http://127.0.0.1:7000',
      projectId: 'project-linux-probe',
      sourceId: 'fixture',
    },
  });
  manager = new GitWorkspaceManager(
    ledger,
    { repository: source, baseRef: 'refs/heads/main' },
    assignmentRoot,
  );
  const legacyLaunch = ledger.reserve({
    id: 'launch-git-linux-probe',
    sessionId: 'session-git-linux-probe',
    deadline: Date.now() + 60000,
  });
  const legacy = await manager.prepare(legacyLaunch, {
    id: legacyLaunch.sessionId,
    projectId: 'project-linux-probe',
    instanceId: 'instance-linux-probe',
    execution: {
      policy: {
        readOnly: false,
        tools: [],
        workspace: {
          mode: 'persistent',
          namespace: 'probe',
          base: 'central',
          retain: true,
          perBase: false,
          advancesCentral: false,
        },
      },
      references: {},
    },
  } as never);
  assert.ok(statSync(join(legacy.path, '.git')).isDirectory());
  const legacyHandoff = spawnSync(
    '/usr/bin/python3',
    [
      '-c',
      'import sys; sys.path.insert(0, "/opt/merv/python"); from pathlib import Path; from merv_sandboxes.runtimes.assignment import _workspace; _workspace(Path.cwd())',
    ],
    {
      cwd: legacy.path,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' },
    },
  );
  assert.equal(legacyHandoff.status, 0, legacyHandoff.stderr);
  writeAsAssignment(legacy.path, 'legacy.txt', 'Git assignment edit\n');
  ledger.cancelReservation(legacyLaunch.id);
  const legacyResult = await manager.capture(legacyLaunch);
  assert.ok(legacyResult && legacyResult.headOid !== head);
  assert.equal(
    git(
      join(ledger.directory, 'workspaces/repository.git'),
      'show',
      `${legacyResult.headOid}:legacy.txt`,
    ),
    'Git assignment edit',
  );
  await manager.close(legacyLaunch);
  process.stdout.write('PASS: Linux UID 12001 Code checkpoint/final capture and Git capture\n');
} finally {
  manager?.dispose();
  ledger?.close();
  driver?.dispose();
  rmSync(root, { recursive: true, force: true });
}
