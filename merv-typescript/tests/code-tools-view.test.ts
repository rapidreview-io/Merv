import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context } from 'cordis';
import type { Caller, CodeCommandRecord } from '@merv/contracts';
import { codeToolsPlugin } from '../packages/code-work/src/tools.js';

const oid = (c: string) => c.repeat(40);
const record = (error: string | null): CodeCommandRecord => ({
  command: {
    id: 'codecmd_1',
    projectId: 'project_1',
    sessionId: 'session_1',
    actorId: 'actor_1',
    instanceId: 'wf_1',
    expectedRevision: 0,
    runnerId: 'runner_1',
    hostRef: 'launch_1',
    workspace: {
      repositoryId: 'repository',
      workspaceId: 'workspace',
      mode: 'persistent',
      branch: 'merv/work/wf_1',
      baseOid: oid('a'),
      headOid: oid('a'),
      stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    },
    expectedHead: oid('b'),
    message: 'Record the run',
    createdAt: '2026-10-18T00:00:00.000Z',
  },
  status: error ? 'failed' : 'queued',
  receipt: null,
  error,
});

/** The code.* tools as a worker calls them, over a Code Work that answers `answer`. */
function tools(answer: CodeCommandRecord) {
  const handlers = new Map<string, (caller: Caller, input: unknown) => Promise<unknown>>();
  const codeWork = {
    commit: async () => answer,
    merge: async () => answer,
    operation: async () => answer,
  };
  codeToolsPlugin.apply({
    codeWork,
    tools: {
      register: (definition: {
        name: string;
        handler: (c: Caller, i: unknown) => Promise<unknown>;
      }) => handlers.set(definition.name, definition.handler),
    },
    effect: (fn: () => unknown) => fn(),
  } as unknown as Context);
  return (name: string) => handlers.get(name)!({} as Caller, {}) as Promise<Record<string, any>>;
}

test('a worker reads its command without the head and stats its checkout had when it attached', async () => {
  const call = tools(record(null));
  for (const name of ['code.commit', 'code.merge', 'code.operation']) {
    const seen = await call(name);
    assert.deepEqual(Object.keys(seen.command.workspace).sort(), [
      'baseOid',
      'branch',
      'mode',
      'repositoryId',
      'workspaceId',
    ]);
    assert.equal(seen.command.expectedHead, oid('b'));
    assert.equal(seen.next, undefined);
  }
});

test('a file Code will not keep is refused with the limit and how to find it', async () => {
  const seen = await tools(record('workspace_file_too_large'))('code.operation');
  assert.equal(seen.error, 'workspace_file_too_large');
  assert.match(seen.next, /50 MiB/);
  assert.match(seen.next, /-size \+50M/);
  assert.match(seen.next, /new requestId/);
  assert.equal((await tools(record('workspace_head_conflict'))('code.operation')).next, undefined);
});

test('a commit refused for a credential-shaped file says where the findings are and who may exempt them', async () => {
  const seen = await tools(record('code_capture_quarantined'))('code.operation');
  assert.match(seen.next, /code\.status lists the refused upload/);
  assert.match(seen.next, /secretExemptGlobs in code\.repository\.configure/);
  assert.match(seen.next, /session\.ask_owner/);
});
