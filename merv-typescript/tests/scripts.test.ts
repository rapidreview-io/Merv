import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Caller } from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import { createApp } from './fixtures/app.js';
import { parseCall, runScript } from '../packages/scripts/src/bridge.js';
import { declaration } from '../packages/scripts/src/declare.js';
import { scriptTools } from '../packages/scripts/src/tools.js';

/** The committed composition over /mcp, as the bootstrapped operator's own agent. */
async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-scripts-'));
  const app = await createApp({ directory, api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const identity = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Scripts test',
    actorName: 'Operator',
  });
  let id = 0;
  const mcp = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(`${app.ctx.api.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const { result } = (await response.json()) as any;
    const value = JSON.parse(result.content[0].text);
    if (result.isError) throw Object.assign(new Error(value.error.message), value.error);
    return value;
  };
  const run = (code: string, timeoutMs?: number) => mcp('script.run', { code, timeoutMs });
  return { app, identity, mcp, run };
}

test('script.tools searches, names and sums up only what this agent may use', async (t) => {
  const { app, mcp } = await fixture(t);
  t.after(
    app.ctx.tools.register({
      name: 'test.hidden',
      description: 'A page’s own read.',
      inputSchema: z.object({}).strict(),
      readOnly: true,
      agent: 'never',
      handler: () => 1,
    }),
  );
  const found = await mcp('script.tools', { query: 'project.get' });
  assert.equal(found.tools[0].name, 'project.get');
  assert.equal(found.tools[0].scriptable, true);
  assert.equal(
    found.tools[0].declaration,
    '/** Read the current project. */\ntools.project.get(input: {}): Promise<unknown>',
  );
  assert.ok(found.tools.length <= 8);
  const named = await mcp('script.tools', {
    names: ['artifact.read', 'task.create', 'test.hidden'],
  });
  assert.deepEqual(
    named.tools.map(({ name, scriptable }: any) => [name, scriptable]),
    [
      // Open-world (its storage I/O holds no snapshot), so never a script's.
      ['artifact.read', true],
      ['task.create', false],
    ],
  );
  const read = named.tools[0].declaration as string;
  assert.match(read, /^\/\*\* Read immutable artifact content: .{0,280}… \*\/\n/);
  assert.match(
    read,
    /tools\.artifact\.read\(input: \{ artifactId: string; mode\?: "download"; fileName\?: string; fileNames\?: string\[\]; offset\?: number; length\?: number \}\): Promise<unknown>$/,
  );
  const summary = await mcp('script.tools');
  const project = summary.namespaces.find(({ namespace }: any) => namespace === 'project');
  assert.ok(project.count >= 2 && project.scriptable.includes('project.get'));
  assert.ok(!summary.namespaces.some(({ namespace }: any) => namespace === 'test'));
  const script = summary.namespaces.find(({ namespace }: any) => namespace === 'script');
  assert.deepEqual(script, { namespace: 'script', count: 2, scriptable: [] });
});

test('declarations render unions, nesting, records and names that are not identifiers', () => {
  // A mounted tool's projectId is its own argument, so it stays.
  assert.equal(
    declaration(
      {
        name: '_docs.find-page',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            q: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
            'max-hits': { type: ['integer', 'null'] },
            where: {
              type: 'object',
              properties: { kind: { enum: ['a', 'b'] } },
              required: ['kind'],
            },
            tags: { type: 'object', additionalProperties: { type: 'boolean' } },
            x: { allOf: [] },
          },
          required: ['q'],
        },
        outputSchema: { type: 'object', properties: { hits: { const: 3 } }, required: ['hits'] },
      },
      false,
    ),
    'tools._docs["find-page"](input: { projectId?: string; q: string | string[]; "max-hits"?: number | null; where?: { kind: "a" | "b" }; tags?: Record<string, boolean>; x?: unknown }): Promise<{ hits: 3 }>',
  );
});

test('a script makes parallel reads and returns its result, logs and calls', async (t) => {
  const { identity, run } = await fixture(t);
  const ran = await run(`
    const [project, me] = await Promise.all([tools.project.get({}), call('actor.whoami', {})]);
    console.log('read', project.name, { role: me.role });
    const same = await tools.project.get({ projectId: project.id });
    return { id: project.id, same: same.id === project.id, role: me.role };
  `);
  assert.deepEqual(ran.result, { id: identity.project.id, same: true, role: 'operator' });
  assert.equal(ran.ok, true);
  assert.deepEqual(ran.logs, ['read Scripts test {"role":"operator"}']);
  assert.deepEqual(ran.calls.map(({ name, ok }: any) => [name, ok]).sort(), [
    ['actor.whoami', true],
    ['project.get', true],
    ['project.get', true],
  ]);
  // The script's project is fixed: it cannot select another.
  const other = await run(
    `try { await tools.project.get({ projectId: 'project_other' }) } catch (e) { return e.message }`,
  );
  assert.equal(other.result, 'invalid_input: A script works in its own project only');
});

test('writes and secret reads are refused and catchable; open-world reads run', async (t) => {
  const { app, mcp, run } = await fixture(t);
  t.after(
    app.ctx.tools.register({
      name: 'test.outside',
      description: 'Ask a paid service.',
      inputSchema: z.object({}).strict(),
      readOnly: true,
      openWorld: true,
      handler: () => 'paid',
    }),
  );
  t.after(
    app.ctx.tools.register({
      name: 'test.guarded',
      description: 'Read a value, or a signed link only the person sees.',
      inputSchema: z.object({ link: z.boolean().optional() }).strict(),
      readOnly: true,
      conversation: (input: { link?: boolean }) => (input.link ? 'secret' : undefined),
      handler: () => 'value',
    }),
  );
  const artifact = await mcp('artifact.create', { title: 'Notes', content: 'hello' });
  const ran = await run(`
    const outcome = async (name, input) => {
      try { await call(name, input); return 'ran'; } catch (e) { return e.message; }
    };
    return {
      write: await outcome('task.create', { title: 'x' }),
      outside: await outcome('test.outside', {}),
      download: await outcome('artifact.read', { artifactId: '${artifact.id}', mode: 'download' }),
      link: await outcome('test.guarded', { link: true }),
      // The guard reads the input invoke receives, with the script's own projectId taken out.
      own: await outcome('test.guarded', { link: true, projectId: (await tools.project.get({})).id }),
      value: await tools.test.guarded({}),
      script: await outcome('script.tools', {}),
      tools: [typeof tools.task, typeof tools.test.outside, typeof tools.script],
    };
  `);
  assert.deepEqual(ran.result, {
    write: 'script_tool_refused: task.create cannot be called from a script',
    outside: 'ran',
    download: 'script_tool_refused: artifact.read cannot be called so from a script',
    link: 'script_tool_refused: test.guarded cannot be called so from a script',
    own: 'script_tool_refused: test.guarded cannot be called so from a script',
    value: 'value',
    script: 'script_tool_refused: script.tools cannot be called from a script',
    tools: ['object', 'function', 'undefined'],
  });
  assert.deepEqual(
    ran.calls.filter(({ ok }: any) => !ok).map(({ error }: any) => error),
    Array(5).fill('script_tool_refused'),
  );
  // task.get is a read, so the task namespace is there; task.create is not in it.
  assert.equal(
    (await run('return [typeof tools.task.get, typeof tools.task.create]')).result.join(),
    'function,undefined',
  );
});

test('a script runs in a sandbox with no host, and its failures are named', async (t) => {
  const { run } = await fixture(t);
  assert.equal(
    (await run('return [typeof require, typeof process, typeof fetch, typeof setTimeout].join()'))
      .result,
    'undefined,undefined,undefined,undefined',
  );
  const failed = async (code: string, timeoutMs?: number) => (await run(code, timeoutMs)).error;
  assert.equal((await failed('while (true) {}', 1000)).code, 'script_timeout');
  // Small objects, large strings and buffers: QuickJS's own count misses the large ones.
  assert.equal(
    (await failed('const a = []; for (;;) a.push({ i: a.length });')).code,
    'script_memory',
  );
  for (const grow of ["'x'.repeat(1e6) + i", 'new Uint8Array(1 << 20)'])
    assert.equal(
      (await failed(`const a = []; for (let i = 0; i < 200; i++) a.push(${grow}); return 1`)).code,
      'script_memory',
    );
  // The child stops sending past the lines kept (its blocked loop would queue them all); one
  // more would be forged.
  const flood = await run("const s = 'x'.repeat(2047); for (;;) console.log(s);", 1000);
  assert.equal(flood.error.code, 'script_timeout');
  assert.equal(flood.logs.length, 200);
  assert.equal(
    (await failed('for (let i = 0; i < 51; i++) await tools.project.get({});')).code,
    'script_call_limit',
  );
  assert.equal((await failed('return (')).code, 'script_syntax');
  // QuickJS's own stack limit, not the host's, ends a runaway recursion.
  assert.deepEqual(await failed('const f = () => f() + 1; f();'), {
    code: 'script_error',
    message: 'InternalError: stack overflow',
  });
  assert.deepEqual(await failed("throw new TypeError('no')"), {
    code: 'script_error',
    message: 'TypeError: no',
  });
  const long = await run("console.log('kept'); return 'x'.repeat(40000)");
  assert.equal(long.truncated, true);
  assert.equal(long.result.length, 32 << 10);
  assert.deepEqual(long.logs, []);
});

test('the bridge refuses any call message a sandbox would not send', () => {
  const seen = new Set<number>();
  const valid = { type: 'call', id: 0, name: 'project.get', input: '{}' };
  assert.deepEqual(parseCall(valid, seen), { id: 0, name: 'project.get', input: {} });
  for (const forged of [
    valid,
    { ...valid, id: 1.5 },
    { ...valid, id: -1 },
    { ...valid, id: '2' },
    { ...valid, id: 3, name: 7 },
    { ...valid, id: 4, name: 'x'.repeat(129) },
    { ...valid, id: 5, input: { a: 1 } },
    { ...valid, id: 6, input: '[1]' },
    { ...valid, id: 7, input: 'null' },
    { ...valid, id: 8, input: '{' },
    { ...valid, id: 9, input: JSON.stringify({ a: 'x'.repeat(64 << 10) }) },
    null,
    'call',
  ])
    assert.equal(parseCall(forged, seen), undefined, JSON.stringify(forged)?.slice(0, 80));
});

test('a sandbox without the permission model runs no script', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-scripts-stub-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stub = join(directory, 'stub.mjs');
  writeFileSync(
    stub,
    "process.send({ type: 'ready', permission: false }); setInterval(() => {}, 1000);\n",
  );
  let called = false;
  await assert.rejects(
    runScript('return 1', 1000, [], async () => (called = true), stub),
    { code: 'script_unavailable', status: 503 },
  );
  assert.equal(called, false);
  // A child that dies before it is ready leaves its reason in the server's log, not the answer.
  writeFileSync(stub, "process.stderr.write('cannot start'); process.exit(1);\n");
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((text: string) => written.push(text) > 0) as typeof write;
  try {
    await assert.rejects(
      runScript('return 1', 1000, [], async () => null, stub),
      (error: any) => {
        assert.equal(error.code, 'script_unavailable');
        assert.doesNotMatch(error.message, /cannot start/);
        return true;
      },
    );
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(
    written.map((line) => JSON.parse(line)),
    [{ event: 'script_sandbox_failed', stderr: 'cannot start' }],
  );
});

test('mounted tools need a closed-world read hint; workers get no scripts', async () => {
  const mounted = (name: string, annotations: object) => ({
    kind: 'mcp' as const,
    name,
    description: 'Find.',
    annotations,
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, q: { type: 'string' } },
      required: ['projectId', 'q'],
    },
  });
  const listed = [
    mounted('_crm.find', { readOnlyHint: true, openWorldHint: false }),
    // MCP reads a missing openWorldHint as true.
    mounted('_crm.open', { readOnlyHint: true }),
  ];
  const inputs: unknown[] = [];
  const tools = {
    describe: async () => listed.map(({ kind: _kind, ...description }) => description),
    list: async () => listed,
    // A remote result may leave out content.
    invoke: async (_name: string, _caller: Caller, input: unknown) => {
      inputs.push(input);
      return { format: 'mcp', value: { structuredContent: { a: 1 } } };
    },
  } as unknown as Tools;
  const [find, run] = scriptTools(tools, { run: runScript });
  const caller = { actorId: 'actor_1', projectId: 'project_1' } as Caller;
  assert.deepEqual(await find.handler(caller, { names: ['_crm.find', '_crm.open'] }), {
    tools: ['_crm.find', '_crm.open'].map((name) => ({
      name,
      scriptable: true,
      declaration: `/** Find. */\ntools.${name}(input: { projectId: string; q: string }): Promise<unknown>`,
    })),
  });
  const ran = (await run.handler(caller, {
    code: "return [await tools._crm.find({ projectId: 'crm_1', q: 'x' }), typeof tools._crm.open]",
  })) as any;
  assert.deepEqual(ran.result, [{ a: 1 }, 'function']);
  assert.deepEqual(inputs, [{ projectId: 'crm_1', q: 'x' }]);
  const worker = { ...caller, session: { id: 'session_1' } };
  for (const [tool, input] of [
    [find, {}],
    [run, { code: 'return 1' }],
  ] as const)
    await assert.rejects(async () => await tool.handler(worker, input), {
      code: 'session_forbidden',
      status: 403,
    });
});
