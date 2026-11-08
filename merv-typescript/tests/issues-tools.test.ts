import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { z } from 'zod';
import { digest, MervError, type Caller, type Scope, type State } from '@merv/contracts';
import { type IssueReport, type Issues } from '@merv/contracts/issues';

import { ToolRegistry } from '../packages/api/src/registry.js';

import { writerFixture } from './fixtures/code-writers.js';

const exec = promisify(execFile);
const caller: Caller = { actorId: 'alice', projectId: 'project-a' };

/** Captures reports; with a state, as Issues holds them: until their transaction commits. */
function capture(state?: State): Issues & { reports: IssueReport[] } {
  const reports: IssueReport[] = [];
  return {
    reports,
    report: (issue) => (state ? state.afterCommit(() => reports.push(issue)) : reports.push(issue)),
    resolve() {},
  };
}

function registry() {
  const scope = { require: async () => ({}) } as unknown as Scope;
  const tools = new ToolRegistry(scope);
  const issues = (tools.issues = capture());
  const failing = (error: unknown) => () => {
    throw error;
  };
  tools.register({
    name: 'item.write',
    description: 'Writes an item',
    tier: 'core',
    inputSchema: z.object({ id: z.string() }).strict(),
    handler: failing(new MervError('item_conflict', 'Item 7 is taken', 409)),
  });
  const wait = Object.assign(new MervError('state_busy', 'Not yet', 503), { wait: true });
  tools.register({
    name: 'item.wait',
    description: 'Not yet',
    tier: 'core',
    inputSchema: z.object({}).strict(),
    handler: failing(wait),
  });
  tools.register({
    name: 'item.crash',
    description: 'Faults',
    tier: 'core',
    inputSchema: z.object({}).strict(),
    handler: failing(new Error('secret connection string')),
  });
  tools.register({
    name: 'item.mounted',
    description: 'Returns its own failure',
    tier: 'core',
    inputSchema: z.object({}).strict(),
    handler: () => ({}),
    present: () => ({
      isError: true,
      content: [
        { type: 'text', text: JSON.stringify({ error: { code: 'sandbox_quota', status: 402 } }) },
      ],
    }),
  });
  tools.register({
    name: 'item.nested',
    description: 'Calls item.write',
    tier: 'core',
    inputSchema: z.object({}).strict(),
    handler: (caller) => tools.invoke('item.write', caller, { id: 'x' }, true),
  });
  return { tools, issues };
}

test('an agent refusal is a notice keyed by its arguments, and a wait is never reported', async () => {
  const { tools, issues } = registry();
  await assert.rejects(tools.invoke('item.write', caller, { id: 'x' }, true, undefined, 'codex'), {
    code: 'item_conflict',
  });
  await assert.rejects(tools.invoke('item.wait', caller, {}, true), { code: 'state_busy' });
  assert.equal(issues.reports.length, 1);
  const [report] = issues.reports;
  assert.deepEqual(
    { ...report, error: undefined },
    {
      class: 'tool',
      where: 'item.write',
      code: 'item_conflict',
      status: 409,
      level: 'notice',
      subject: `alice:${digest(['item.write', { id: 'x' }]).slice(0, 16)}`,
      refs: {
        projectId: 'project-a',
        actorId: 'alice',
        client: 'codex',
        sessionId: undefined,
        threadId: undefined,
        invocationId: undefined,
        conversationId: undefined,
        commandId: undefined,
        allocationId: undefined,
      },
      error: undefined,
    },
  );
  assert.ok(tools.reported.has(report!.error as object));
});

test('a nested call that fails is reported once, by the innermost call', async () => {
  const { tools, issues } = registry();
  await assert.rejects(tools.invoke('item.nested', caller, {}, true), { code: 'item_conflict' });
  assert.deepEqual(
    issues.reports.map(({ where }) => where),
    ['item.write'],
  );
});

/** Code with its native Git remote served, and Issues captured as they commit. */
async function code(t: TestContext) {
  const f = await writerFixture(t);
  const issues = capture(f.state);
  f.core.gitRemote.issues = issues;
  const server = createServer((req, res) => {
    void f.core.gitRemote.handle(req, res, new URL(req.url!, 'http://localhost')).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { ...f, issues, server };
}
