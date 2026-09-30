import { importMutation } from './fixtures/lean-mutation.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createService } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { ManagedModelGrant, Sessions } from '@merv/sessions/types';
import { ModelRelay } from '../packages/fleet/src/model-relay.js';
import { codexModelRelay, modelMigrations } from '../packages/fleet/src/codex-relay.js';
import { openState } from './fixtures/state.js';
import ts from 'typescript';

const binary = fileURLToPath(
  new URL('../verification/lean/.lake/build/bin/backend_relay_model', import.meta.url),
);
function oracle(amount: number, commands: Record<string, unknown>[]) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ amount, day: 1, commands }),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).observations.at(-1) as {
    booked: number;
    callbacks: number;
    settled: boolean;
  };
}

async function conformance(t: TestContext, Relay = ModelRelay) {
  const state = await openState();
  await createService(new ProjectScope(state));
  await state.migrate('fleet_workflow', modelMigrations);
  const token = `ms_${'r'.repeat(43)}`;
  const grant: ManagedModelGrant = {
    id: 'relay_conformance',
    person: 'relay_person',
    projectId: 'relay_project',
    allocationId: 'relay_allocation',
    model: 'test-model',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const sessions = { managedModelGrant: async () => grant } as unknown as Sessions;
  const config = codexModelRelay(sessions, state, {
    providerKey: () => 'test-only-key',
    dailyTokensPerPerson: 100_000_000,
  });
  let frames = '';
  let upstreamStatus = 200;
  let networkFailure = false;
  let amount = 0;
  let callbacks = 0;
  let settlements: Promise<void>[] = [];
  const relay = new Relay({
    ...config,
    onFailure: () => undefined,
    onTerminal: () => undefined,
    reserve: async (g, body) => {
      const charge = await config.reserve!(g, body);
      amount = charge.tokens;
      return charge;
    },
    onUsage: (record, g, charge) => {
      callbacks++;
      const done = Promise.resolve(config.onUsage!(record, g, charge));
      settlements.push(done);
      return done;
    },
    fetchImpl: async () => {
      if (networkFailure) throw new Error('simulated lost upstream response');
      return new Response(frames, {
        status: upstreamStatus,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const server = createServer((req, res) => void relay.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await state.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${config.route}`;
  const spent = async () =>
    Number(
      (
        await state.read((sql) =>
          sql.get<{ tokens: string }>(
            'SELECT tokens FROM fleet_model_usage WHERE person=?',
            grant.person,
          ),
        )
      )?.tokens ?? 0,
    );
  const frame = (usage: unknown, kind = 'completed') =>
    `event: response.${kind}\ndata: ${JSON.stringify({ type: `response.${kind}`, response: { usage } })}\n\n`;
  const cases: [string, unknown][] = [
    ['empty object', {}],
    ['array', []],
    ['null', null],
    ['missing', undefined],
    ['missing output', { input_tokens: 7 }],
    ['missing input', { output_tokens: 7 }],
    ['negative', { input_tokens: -1, output_tokens: 7 }],
    ['fraction', { input_tokens: 0.5, output_tokens: 7 }],
    ['numeric string', { input_tokens: '7', output_tokens: 7 }],
    ['unsafe integer', { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 }],
    ['overflowing total', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }],
    ['valid zero', { input_tokens: 0, output_tokens: 0 }],
    ['valid usage', { input_tokens: 23, output_tokens: 11 }],
    ['actual usage above estimate remains charged', { input_tokens: 100_000, output_tokens: 50 }],
  ];
  const run = async (label: string, commands: Record<string, unknown>[]) => {
    const before = await spent();
    callbacks = 0;
    settlements = [];
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: grant.model, input: [], store: false, stream: true }),
    });
    await response.text();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all(settlements);
    const expected = oracle(amount, commands);
    assert.deepEqual(
      { booked: (await spent()) - before, callbacks },
      { booked: expected.booked, callbacks: expected.callbacks },
      label,
    );
    return expected;
  };
  for (const [label, usage] of cases) {
    frames = frame(usage);
    await run(label, [{ kind: 'send' }, { kind: 'terminal', usage }, { kind: 'commitCallback' }]);
  }
  const first = { input_tokens: 17, output_tokens: 2 };
  const second = { input_tokens: 500, output_tokens: 200 };
  frames = frame(first) + frame(second);
  await run('duplicate terminal emits one delta', [
    { kind: 'send' },
    { kind: 'terminal', usage: first },
    { kind: 'terminal', usage: second },
    { kind: 'commitCallback' },
  ]);
  frames = frame({}, 'incomplete') + frame(second);
  await run('malformed first terminal cannot manufacture a refund', [
    { kind: 'send' },
    { kind: 'terminal', usage: {} },
    { kind: 'terminal', usage: second },
    { kind: 'commitCallback' },
  ]);
  frames = frame(first, 'failed');
  await run('failed stream with valid usage settles consumed tokens', [
    { kind: 'send' },
    { kind: 'terminal', usage: first },
    { kind: 'commitCallback' },
  ]);
  upstreamStatus = 429;
  await run('definite HTTP refusal refunds', [
    { kind: 'send' },
    { kind: 'upstreamRefused' },
    { kind: 'commitCallback' },
  ]);
  upstreamStatus = 200;
  networkFailure = true;
  await run('lost response retains reservation', [{ kind: 'send' }, { kind: 'unknownReply' }]);
  const malformed = oracle(100, [
    { kind: 'send' },
    { kind: 'terminal', usage: {} },
    { kind: 'commitCallback' },
  ]);
  const faultyZeroDefault = oracle(100, [
    { kind: 'send' },
    { kind: 'terminal', usage: { input_tokens: 0, output_tokens: 0 } },
    { kind: 'commitCallback' },
  ]);
  assert.notDeepEqual(
    malformed,
    faultyZeroDefault,
    'the old zero-default mutation must be observable',
  );
}

const leanOptions = {
  skip:
    !existsSync(binary) && process.env.MERV_REQUIRE_LEAN !== '1'
      ? 'Build backend_relay_model'
      : undefined,
};
test(
  'shared model relay and durable Fleet ledger agree with Lean on malformed, valid, duplicate and refused usage',
  leanOptions,
  (t) => conformance(t),
);

test(
  'the real relay zero-default mutation fails the same Lean/SQL comparison',
  {
    skip: process.env.MERV_LEAN_MUTATIONS !== '1' ? 'Enable MERV_LEAN_MUTATIONS' : leanOptions.skip,
  },
  async (t) => {
    const source = readFileSync(
      new URL('../packages/fleet/src/model-relay.ts', import.meta.url),
      'utf8',
    );
    const guard = 'if (usableUsage(usage))';
    assert.equal(
      source.split(guard).length,
      2,
      'mutation must replace the unique settlement guard',
    );
    const mutant = source.replace(guard, "if (usage && typeof usage === 'object')");
    const javascript = ts.transpileModule(mutant, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    // Only this in-memory module is changed; production files and parallel tests stay untouched.
    const module = await importMutation(javascript);
    await assert.rejects(
      conformance(t, module.ModelRelay as typeof ModelRelay),
      (error) => error instanceof assert.AssertionError && error.message.includes('empty object'),
    );
  },
);
