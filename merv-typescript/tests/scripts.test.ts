import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Caller } from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import { createApp } from './fixtures/app.js';
import { LIMITS, parseCall, runScript } from '../packages/scripts/src/bridge.js';
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
      tier: 'ui',
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

test('writes and reads kept from agents are refused and catchable; open-world reads and download links run', async (t) => {
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
      name: 'test.page',
      description: 'A page’s own read, which no agent conversation is offered.',
      inputSchema: z.object({}).strict(),
      readOnly: true,
      tier: 'ui',
      handler: () => 'value',
    }),
  );
  const artifact = await mcp('artifact.create', { title: 'Notes', content: 'hello' });
  const ran = await run(`
    const outcome = async (name, input) => {
      try { await call(name, input); return 'ran'; } catch (e) { return e.message; }
    };
    return {
      write: await outcome('task.create', { title: 'x', goal: 'g', checks: ['c'], requestId: 'r' }),
      outside: await outcome('test.outside', {}),
      download: await outcome('artifact.read', { artifactId: '${artifact.id}', mode: 'download' }),
      page: await outcome('test.page', {}),
      script: await outcome('script.tools', {}),
      tools: [typeof tools.task, typeof tools.test.outside, typeof tools.script],
    };
  `);
  assert.deepEqual(ran.result, {
    write: 'script_tool_refused: task.create cannot be called from a script',
    outside: 'ran',
    // A download link is any agent's to have; this fixture's storage signs none.
    download: 'download_unsupported: This storage provider does not support direct downloads',
    // Kept from every agent, it is refused by the caller's rules before the script's own check.
    page: 'tool_forbidden: This tool is not offered to agents',
    script: 'script_tool_refused: script.tools cannot be called from a script',
    tools: ['object', 'function', 'undefined'],
  });
  assert.deepEqual(
    ran.calls.filter(({ ok }: any) => !ok).map(({ error }: any) => error),
    ['script_tool_refused', 'download_unsupported', 'tool_forbidden', 'script_tool_refused'],
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
  const flood = await run("const s = 'x'.repeat(2045); for (;;) console.log(s);", 1000);
  assert.equal(flood.error.code, 'script_timeout');
  assert.equal(flood.truncated, true);
  assert.equal(flood.logs.length, 15);
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
  assert.match(long.result, /^"x{32000,}$/);
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

/** A child at `entry` that writes `body`, with frame(message) for one protocol message. */
function stub(t: test.TestContext, body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-scripts-stub-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'stub.mjs');
  writeFileSync(
    path,
    `const raw = (b) => { const h = Buffer.alloc(4); h.writeUInt32BE(b.length); process.stdout.write(Buffer.concat([h, b])); };
const frame = (m) => raw(Buffer.from(JSON.stringify(m)));
${body}
setInterval(() => {}, 1000);
`,
  );
  return path;
}
const envelope = (result: unknown) => Buffer.byteLength(JSON.stringify(result));

test('a sandbox without the permission model, or that speaks first, runs no script', async (t) => {
  let called = 0;
  const host = async () => ++called;
  for (const body of [
    "frame({ type: 'ready', permission: false });",
    // A call before readiness never runs, whatever readiness says next.
    "frame({ type: 'call', id: 0, name: 'x', input: '{}' }); frame({ type: 'ready', permission: false });",
    "frame({ type: 'call', id: 0, name: 'x', input: '{}' }); frame({ type: 'ready', permission: true });",
  ])
    await assert.rejects(runScript('return 1', 1000, [], host, stub(t, body)), {
      code: 'script_unavailable',
      status: 503,
    });
  assert.equal(called, 0);
  // A child that dies before it is ready leaves its reason in the server's log, not the answer.
  const dies = stub(t, "process.stderr.write('cannot start'); process.exit(1);");
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((text: string) => written.push(text) > 0) as typeof write;
  try {
    await assert.rejects(runScript('return 1', 1000, [], host, dies), (error: any) => {
      assert.equal(error.code, 'script_unavailable');
      assert.doesNotMatch(error.message, /cannot start/);
      return true;
    });
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(
    written.map((line) => JSON.parse(line)),
    [{ event: 'script_sandbox_failed', stderr: 'cannot start' }],
  );
});

test('a hostile child’s frames end it, never the parent, and it has no IPC channel', async (t) => {
  const host = async () => null;
  const ready = "frame({ type: 'ready', permission: true });";
  // Refused from its length alone, long before the timeout.
  const begun = Date.now();
  await assert.rejects(
    runScript(
      'return 1',
      30_000,
      [],
      host,
      stub(
        t,
        'raw(Buffer.alloc(0xffff)); process.stdout.write(Buffer.from([255, 255, 255, 255]));',
      ),
    ),
    { code: 'script_unavailable' },
  );
  assert.ok(Date.now() - begun < 5000);
  for (const body of [
    "raw(Buffer.from('{oops'));",
    'process.stdout.write(Buffer.from([0, 0, 0, 2, 1, 2, 3]));',
  ])
    await assert.rejects(runScript('return 1', 1000, [], host, stub(t, body)), {
      code: 'script_unavailable',
    });
  for (const body of [
    `${ready} raw(Buffer.from('{oops'));`,
    `${ready} raw(Buffer.from('7'));`,
    `${ready} process.stdout.write(Buffer.from([0x7f, 0, 0, 0]));`,
  ])
    assert.equal(
      (await runScript('return 1', 1000, [], host, stub(t, body))).error?.code,
      'script_error',
    );
  const ipc = await runScript(
    'return 1',
    1000,
    [],
    host,
    stub(
      t,
      `${ready} frame({ type: 'done', ok: true, result: JSON.stringify([typeof process.send, typeof process.channel]) });`,
    ),
  );
  assert.deepEqual(ipc.result, ['undefined', 'undefined']);
});

test('the child leads its own process group, which teardown kills', async (t) => {
  const entry = stub(t, '');
  const ran = runScript('return 1', 1000, [], async () => null, entry);
  let row: string | undefined;
  for (let i = 0; i < 50 && !row; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    row = execFileSync('ps', ['-axo', 'pid=,pgid=,args='], { encoding: 'utf8' })
      .split('\n')
      .find((line) => line.includes(entry));
  }
  const [pid, pgid] = row!.trim().split(/\s+/).map(Number);
  assert.equal(pgid, pid);
  assert.equal((await ran).error?.code, 'script_timeout');
  // Killed with its group: gone once reaped.
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false);
});

test('a script holds its slot until its host calls settle; host calls are bounded globally', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const host = async (name: string) => (name === 'hang' ? await gate : null);
  for (const code of [
    "call('hang', {}); await call('quick', {}); return 1",
    "call('hang', {}); await call('quick', {}); while (true) {}",
  ])
    for (let i = 0; i < 2; i++) await runScript(code, 1000, [], host);
  await assert.rejects(runScript('return 1', 1000, [], host), { code: 'script_busy' });
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await runScript('return 1', 1000, [], host)).result, 1);
  let now = 0;
  let most = 0;
  const slow = async () => {
    most = Math.max(most, ++now);
    await new Promise((resolve) => setTimeout(resolve, 30));
    now--;
    return 1;
  };
  const code = "return (await Promise.all([0, 1, 2, 3].map(() => call('slow', {})))).length";
  const all = await Promise.all([0, 1, 2, 3].map(() => runScript(code, 5000, [], slow)));
  assert.deepEqual(
    all.map(({ result }) => result),
    [4, 4, 4, 4],
  );
  assert.equal(most, LIMITS.hostCalls);
});

test('every answer is cut by UTF-8 bytes of its JSON, however the script ends', async () => {
  const host = async (name: string) => (name === 'big' ? '€'.repeat(400_000) : null);
  const run = (code: string, timeoutMs = 2000) => runScript(code, timeoutMs, ['big'], host);
  const outcomes = [
    await run("return '€'.repeat(20000)"),
    await run("for (let i = 0; i < 40; i++) console.log('\"'.repeat(2000)); return 1"),
    await run("for (let i = 0; i < 200; i++) console.log('x'.repeat(2047)); throw new Error('no')"),
    await run("for (let i = 0; i < 200; i++) console.log('€'.repeat(2047)); while (true) {}", 1000),
    await run(
      "for (let i = 0; i < 51; i++) { console.log('€'.repeat(2047)); await call('x', {}); }",
    ),
  ];
  assert.deepEqual(
    outcomes.map(({ ok, error, truncated }) => [ok, error?.code, truncated]),
    [
      [true, undefined, true],
      [true, undefined, true],
      [false, 'script_error', true],
      [false, 'script_timeout', true],
      [false, 'script_call_limit', true],
    ],
  );
  for (const outcome of outcomes) assert.ok(envelope(outcome) <= LIMITS.returned);
  assert.ok(outcomes[0].logs.every((line) => Buffer.byteLength(JSON.stringify(line)) <= 2048));
  // A result past 1 MiB of UTF-8 fails its call; an input past 64 KiB is refused in the child.
  let called = 0;
  const counted = async (name: string) => (++called, host(name));
  const caught = await runScript(
    `const reason = async (f) => { try { await f(); } catch (e) { return [e.code, e.message.split(':')[0]]; } };
     return [await reason(() => call('big', {})), await reason(() => call('x', { a: '€'.repeat(30000) }))];`,
    2000,
    [],
    counted,
  );
  assert.deepEqual(caught.result, [
    ['script_result_too_large', 'script_result_too_large'],
    ['script_input_too_large', 'script_input_too_large'],
  ]);
  assert.equal(called, 1);
});

test('a deeply nested result is refused, never re-serialized; the calls list stays bounded', async () => {
  const host = async () => 1;
  // V8's JSON.stringify overflows its stack near 5,000 levels; the bridge never reaches it.
  const deep = await runScript(
    'let v = []; for (let i = 0; i < 8000; i++) v = [v]; return v;',
    5000,
    [],
    host,
  );
  assert.equal(deep.ok, false);
  assert.equal(deep.error?.code, 'script_result_too_deep');
  assert.equal(envelope(deep) <= LIMITS.returned, true);
  // Fifty calls whose names widen past their characters still fit the answer, marked cut.
  const names = await runScript(
    "for (let i = 0; i < 50; i++) { try { await call('\\u0001'.repeat(120) + i, {}); } catch {} } return 1",
    5000,
    [],
    host,
  );
  assert.ok(envelope(names) <= LIMITS.returned);
  assert.equal(names.truncated, true);
  assert.equal(names.result, 1);
});

test('an answer is measured as sent, and calls queued when a script ends hold nothing', async () => {
  // A script that makes its own JSON.stringify print short numbers still gets the limit.
  const forged = await runScript(
    "JSON.stringify = () => '[' + Array(6000).fill('1e20').join(',') + ']'; return Array(6000).fill(1e20)",
    5000,
    [],
    async () => 1,
  );
  assert.ok(envelope(forged) <= LIMITS.returned);
  assert.equal(forged.truncated, true);
  // Two scripts leave eight host calls hanging; two more end with their calls still queued.
  const releases: (() => void)[] = [];
  const hang = () => new Promise<unknown>((resolve) => releases.push(() => resolve(1)));
  const leave = "for (let i = 0; i < 4; i++) call('h', {}); await 0; return 1";
  for (let i = 0; i < 4; i++) assert.equal((await runScript(leave, 5000, [], hang)).ok, true);
  // Queued calls dropped with their scripts: a fifth script still gets a slot.
  assert.equal((await runScript('return 1', 5000, [], hang)).result, 1);
  releases.forEach((release) => release());
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test('a script call is judged on the tool registered when it runs', async (t) => {
  const { app, run } = await fixture(t);
  let wrote = false;
  let swapped: (() => Promise<void>) | undefined = app.ctx.tools.register({
    name: 'test.swap',
    description: 'Read a value.',
    inputSchema: z.object({}).strict(),
    readOnly: true,
    handler: () => 'read',
  });
  t.after(async () => await swapped?.());
  t.after(
    app.ctx.tools.register({
      name: 'test.flip',
      description: 'Replace test.swap with a write under the same name.',
      inputSchema: z.object({}).strict(),
      readOnly: true,
      handler: async () => {
        await swapped!();
        swapped = app.ctx.tools.register({
          name: 'test.swap',
          description: 'Write a value.',
          inputSchema: z.object({}).strict(),
          handler: () => (wrote = true),
        });
        return 'flipped';
      },
    }),
  );
  const ran = await run(`
    const before = await tools.test.swap({});
    await tools.test.flip({});
    try { await tools.test.swap({}); return 'ran'; } catch (e) { return [before, e.message]; }
  `);
  assert.deepEqual(ran.result, [
    'read',
    'script_tool_refused: test.swap cannot be called from a script',
  ]);
  assert.equal(wrote, false);
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
    tool: (name: string) => ({
      name,
      remote: true,
      readOnly: false,
      tier: 'deferred',
      noun: false,
    }),
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

test('a noun read, every action of which reads, is scriptable with one overload per action', async (t) => {
  const { mcp, run } = await fixture(t);
  const found = await mcp('script.tools', { names: ['code.read', 'code.write'] });
  assert.deepEqual(
    found.tools.map(({ name, scriptable }: { name: string; scriptable: boolean }) => [
      name,
      scriptable,
    ]),
    [
      ['code.read', true],
      ['code.write', false],
    ],
  );
  assert.match(
    found.tools[0].declaration,
    /tools\.code\.read\(input: \{ action: "status"; status\?: \{\} \}\): Promise<\{ project: /,
  );
  const ran = await run(`
    const status = await tools.code.read({ action: 'status' });
    const viaAddress = await call('code.read:status', {});
    let refused;
    try { await call('code.write', { action: 'publication_sync' }); } catch (e) { refused = e.message; }
    return [Array.isArray(status.bases), Array.isArray(viaAddress.units), refused];
  `);
  assert.deepEqual(ran.result, [
    true,
    true,
    'script_tool_refused: code.write cannot be called from a script',
  ]);
});
