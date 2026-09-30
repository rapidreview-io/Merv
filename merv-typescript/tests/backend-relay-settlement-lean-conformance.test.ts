import { importMutation } from './fixtures/lean-mutation.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createService, type Blobs, type State } from '@merv/contracts';
import type { Tools } from '@merv/api/types';
import { ProjectScope } from '@merv/scope';
import type { ManagedModelGrant, Sessions } from '@merv/sessions/types';
import type { Fleet, ModelRelayConfig } from '@merv/fleet/types';
import { ModelRelay } from '../packages/fleet/src/model-relay.js';
import { codexModelRelay, modelMigrations } from '../packages/fleet/src/codex-relay.js';
import { PiService } from '../packages/pi/src/service.js';
import { piModelRelay } from '../packages/pi/src/relay.js';
import type { PiModelCharge, PiRelayGrant } from '../packages/pi/src/types.js';
import { openState, schemaFor } from './fixtures/state.js';

const binary = fileURLToPath(
  new URL('../verification/lean/.lake/build/bin/backend_relay_model', import.meta.url),
);
const options = {
  timeout: 10_000,
  skip:
    !existsSync(binary) && process.env.MERV_REQUIRE_LEAN !== '1'
      ? 'Build backend_relay_model'
      : undefined,
};
const mutations = {
  skip: process.env.MERV_LEAN_MUTATIONS !== '1' ? 'Enable MERV_LEAN_MUTATIONS' : options.skip,
};
type Owner = 'fleet' | 'pi';
type Grant = ManagedModelGrant & PiRelayGrant;
type Config = ModelRelayConfig<Grant, string, PiModelCharge>;
const grant: Grant = {
  id: 'settlement-grant',
  person: 'settlement-person',
  userId: 'settlement-person',
  projectId: 'settlement-project',
  allocationId: 'settlement-allocation',
  conversationId: 'settlement-conversation',
  commandId: 'settlement-command',
  runtimeId: 'settlement-runtime',
  epoch: 1,
  toolNames: [],
  model: 'test-model',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
const body = {
  model: grant.model,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  store: false,
  stream: true,
};
const record = {
  event: 'test_relay_usage' as const,
  model: grant.model,
  inputTokens: 23,
  outputTokens: 11,
  cachedTokens: 0,
  reasoningTokens: 0,
};
const terminal = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 23, output_tokens: 11 } } })}\n\n`;
const commands = [
  { kind: 'send' },
  { kind: 'terminal', usage: { input_tokens: 23, output_tokens: 11 } },
];
function oracle(amount: number, cs: Record<string, unknown>[]) {
  const run = spawnSync(binary, [], {
    input: JSON.stringify({ amount, day: 1, requestId: 1, commands: cs }),
    encoding: 'utf8',
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout).observations.at(-1) as {
    booked: number;
    settled: boolean;
    commits: number;
    usageForwarded: boolean;
  };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function accounting(owner: Owner, state: State): Promise<Config> {
  const scope = await createService(new ProjectScope(state));
  if (owner === 'fleet') {
    await state.migrate('fleet_workflow', modelMigrations);
    return codexModelRelay({ managedModelGrant: async () => grant } as unknown as Sessions, state, {
      providerKey: () => 'test-only-key',
      dailyTokensPerPerson: 100_000_000,
    }) as Config;
  }
  // Accounting has no dependency on a running host, Tools or Blobs. Exercise the production
  // service and its migrations without creating a conversation or renting a machine.
  const pi = await createService(
    new PiService(state, scope, {} as Fleet, {} as Tools, {} as Blobs),
  );
  const { person: _person, allocationId: _allocation, effort: _effort, ...piGrant } = grant;
  return piModelRelay({
    enabled: true,
    models: [{ id: grant.model, effort: 'none' }],
    providerKey: () => 'test-only-key',
    authority: { authorize: async () => piGrant, validate: async () => {} },
    reserve: (g, b) => pi.reserveModel(g, b),
    onUsage: (r, g, charge) => pi.settleModel(r, g, charge),
  }) as Config;
}

async function fixture(t: TestContext, owner: Owner) {
  const key = `relay-settlement-${randomUUID()}`;
  const state = await openState(key);
  const config = await accounting(owner, state);
  t.after(() => state.close());
  const snapshot = async (charge: PiModelCharge) =>
    state.read(async (sql) => {
      const request = await sql.get<{ reserved_tokens: string; settled_tokens: string | null }>(
        `SELECT reserved_tokens,settled_tokens FROM ${owner}_model_requests WHERE id=?`,
        charge.requestId,
      );
      const usage = await sql.get<{ tokens: string }>(
        `SELECT tokens FROM ${owner}_model_usage WHERE person=? AND day=?`,
        grant.person,
        charge.day,
      );
      assert.ok(request);
      return {
        booked: Number(usage!.tokens),
        settled: request.settled_tokens !== null,
        amount: Number(request.settled_tokens ?? request.reserved_tokens),
      };
    });
  const compare = async (charge: PiModelCharge, cs: Record<string, unknown>[]) => {
    const expected = oracle(charge.tokens, cs);
    const actual = await snapshot(charge);
    assert.deepEqual(
      { booked: actual.booked, settled: actual.settled },
      { booked: expected.booked, settled: expected.settled },
    );
  };
  return { key, state, config, snapshot, compare };
}

async function listen(t: TestContext, server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function http(
  t: TestContext,
  owner: Owner,
  config: Config,
  Relay = ModelRelay,
  upstreamStatus = 200,
) {
  const upstream = await listen(
    t,
    createServer((req, res) => {
      req.resume();
      res.writeHead(upstreamStatus, { 'content-type': 'text/event-stream' });
      res.end(
        upstreamStatus === 200 ? `event: response.created\ndata: {}\n\n${terminal}` : 'refused',
      );
    }),
  );
  const relay = new Relay({
    ...config,
    onFailure: () => {},
    onTerminal: () => {},
    fetchImpl: (_url, init) => fetch(upstream, init),
  });
  t.after(() => relay.close());
  const url = await listen(
    t,
    createServer((req, res) => void relay.handle(req, res)),
  );
  return {
    relay,
    call: (signal?: AbortSignal) =>
      fetch(`${url}${config.route}`, {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${owner === 'fleet' ? 'ms' : 'pir'}_${'s'.repeat(43)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
  };
}

async function forwarding(t: TestContext, owner: Owner, Relay = ModelRelay) {
  const f = await fixture(t, owner);
  const entered = deferred();
  const release = deferred();
  const committed = deferred();
  let charge!: PiModelCharge;
  const h = await http(
    t,
    owner,
    {
      ...f.config,
      reserve: async (g, b) => (charge = await f.config.reserve!(g, b)),
      onUsage: async (r, g, c) => {
        entered.resolve();
        await release.promise;
        await f.config.onUsage!(r, g, c);
        committed.resolve();
      },
    },
    Relay,
  );
  const response = await h.call();
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let seen = new TextDecoder().decode((await reader.read()).value);
  await entered.promise;
  const next = reader.read().then((part) => {
    seen += new TextDecoder().decode(part.value);
    return part;
  });
  try {
    await pause(80);
    const expected = oracle(charge.tokens, [...commands, { kind: 'forwardUsage' }]);
    assert.equal(
      seen.includes('response.completed'),
      expected.usageForwarded,
      'terminal preceded durable settlement',
    );
    await f.compare(charge, commands);
  } finally {
    release.resolve();
    await committed.promise;
  }
  await next;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    seen += new TextDecoder().decode(part.value);
  }
  assert.match(seen, /response.completed/);
  await f.compare(charge, [...commands, { kind: 'commitCallback' }, { kind: 'forwardUsage' }]);
}

for (const owner of ['fleet', 'pi'] as const) {
  for (const boundary of ['beforeCommit', 'afterCommit'] as const) {
    test(
      `${owner}: SIGKILL ${boundary} preserves exactly the durable side of settlement`,
      options,
      async (t) => {
        const f = await fixture(t, owner);
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(new URL('./fixtures/relay-settlement-worker.ts', import.meta.url)),
          ],
          {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            env: process.env,
          },
        );
        t.after(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        });
        let errors = '';
        child.stderr!.on('data', (chunk) => {
          errors += String(chunk);
        });
        const ready = once(child, 'message');
        child.send({ schema: schemaFor(f.key), owner, boundary, grant });
        const [started] = (await ready) as [{ stage: string; url: string }];
        assert.equal(started.stage, 'ready', errors);
        const atBoundary = once(child, 'message');
        const response = await fetch(started.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${owner === 'fleet' ? 'ms' : 'pir'}_${'s'.repeat(43)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
        let seen = '';
        const reader = response.body!.getReader();
        const draining = (async () => {
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              seen += new TextDecoder().decode(part.value);
            }
          } catch {}
        })();
        const [paused] = (await atBoundary) as [{ stage: string; charge: PiModelCharge }];
        assert.equal(paused.stage, 'settlement', errors);
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        await draining;
        assert.doesNotMatch(seen, /response.completed/);
        const trace = [
          ...commands,
          ...(boundary === 'afterCommit' ? [{ kind: 'commitCallback' }] : []),
          { kind: 'crash' },
        ];
        await f.compare(paused.charge, trace);
        const restartedState = await openState(f.key);
        t.after(() => restartedState.close());
        const restarted = await accounting(owner, restartedState);
        // An explicitly supplied usage report can be retried; no provider inference or replay loop.
        await restarted.onUsage!(record, grant, paused.charge);
        await f.compare(paused.charge, [
          ...trace,
          { kind: 'settleRequest', requestId: 1, amount: 34 },
        ]);
      },
    );
  }
  test(`${owner}: HTTP terminal waits for durable accounting`, options, (t) =>
    forwarding(t, owner),
  );

  test(
    `${owner}: reservation and receipt writes roll back atomically; restarts and concurrent retries keep the first settlement`,
    options,
    async (t) => {
      const f = await fixture(t, owner);
      // Fail the reservation identity write after its daily-total increment.
      await f.state.transaction((tx) =>
        tx.run(`CREATE FUNCTION fail_accounting() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected accounting failure'; END; $$;
      CREATE TRIGGER fail_reservation BEFORE INSERT ON ${owner}_model_requests FOR EACH ROW EXECUTE FUNCTION fail_accounting();`),
      );
      await assert.rejects(f.config.reserve!(grant, body), { code: 'state_constraint' });
      assert.equal(
        await f.state.read(async (sql) =>
          Number(
            (await sql.get<{ n: string }>(`SELECT count(*) AS n FROM ${owner}_model_usage`))!.n,
          ),
        ),
        0,
      );
      await f.state.transaction((tx) =>
        tx.run(`DROP TRIGGER fail_reservation ON ${owner}_model_requests`),
      );
      const charge = await f.config.reserve!(grant, body);
      await f.compare(charge, [{ kind: 'send' }]);
      // Fail the receipt write after the daily delta; neither may survive.
      await f.state.transaction((tx) =>
        tx.run(
          `CREATE TRIGGER fail_receipt BEFORE UPDATE ON ${owner}_model_requests FOR EACH ROW EXECUTE FUNCTION fail_accounting()`,
        ),
      );
      await assert.rejects(Promise.resolve(f.config.onUsage!(record, grant, charge)), {
        code: 'state_constraint',
      });
      await f.compare(charge, [...commands, { kind: 'crash' }, { kind: 'commitCallback' }]);
      await f.state.transaction((tx) =>
        tx.run(`DROP TRIGGER fail_receipt ON ${owner}_model_requests`),
      );
      // A new service and independent PostgreSQL pool retain the reservation identity.
      const secondState = await openState(f.key);
      t.after(() => secondState.close());
      const second = await accounting(owner, secondState);
      await assert.rejects(
        Promise.resolve(
          second.onUsage!(record, { ...grant, person: 'wrong', userId: 'wrong' }, charge),
        ),
      );
      await assert.rejects(
        Promise.resolve(second.onUsage!({ ...record, inputTokens: -1 }, grant, charge)),
      );
      // The stored day/estimate are authoritative, even if a caller's copied metadata is stale.
      await Promise.all([
        f.config.onUsage!(record, grant, charge),
        second.onUsage!(record, grant, { ...charge, tokens: 0, day: '1900-01-01' }),
      ]);
      await f.compare(charge, [
        ...commands,
        { kind: 'commitCallback' },
        { kind: 'crash' },
        { kind: 'settleRequest', requestId: 1, amount: 34 },
      ]);
      await assert.rejects(
        Promise.resolve(second.onUsage!({ ...record, outputTokens: 99 }, grant, charge)),
        /already settled/,
      );
      await f.compare(charge, [
        ...commands,
        { kind: 'commitCallback' },
        { kind: 'settleRequest', requestId: 1, amount: 122 },
      ]);
      const another = await second.reserve!(grant, body);
      assert.notEqual(another.requestId, charge.requestId);
      await second.onUsage!({ ...record, inputTokens: 0, outputTokens: 0 }, grant, another);
      assert.equal(
        (await f.snapshot(charge)).booked,
        34,
        'a second request in the same grant has its own receipt',
      );
    },
  );

  test(
    `${owner}: lost commit reply withholds terminal; a restarted owner safely retries`,
    options,
    async (t) => {
      const f = await fixture(t, owner);
      let charge!: PiModelCharge;
      const h = await http(t, owner, {
        ...f.config,
        reserve: async (g, b) => (charge = await f.config.reserve!(g, b)),
        onUsage: async (r, g, c) => {
          await f.config.onUsage!(r, g, c);
          throw new Error('commit reply lost');
        },
      });

      const response = await h.call();
      const text = await response.text();
      assert.doesNotMatch(text, /response.completed/);
      assert.match(text, /relay_interrupted/);
      await f.compare(charge, [...commands, { kind: 'commitCallback' }, { kind: 'crash' }]);
      h.relay.close();
      const restartedState = await openState(f.key);
      t.after(() => restartedState.close());
      const restarted = await accounting(owner, restartedState);
      await restarted.onUsage!(record, grant, charge);
      await f.compare(charge, [
        ...commands,
        { kind: 'commitCallback' },
        { kind: 'crash' },
        { kind: 'settleRequest', requestId: 1, amount: 34 },
      ]);
    },
  );

  test(
    `${owner}: disconnect and relay shutdown do not cancel an observed settlement`,
    options,
    async (t) => {
      const f = await fixture(t, owner);
      const entered = deferred();
      const release = deferred();
      const committed = deferred();
      let charge!: PiModelCharge;
      const h = await http(t, owner, {
        ...f.config,
        reserve: async (g, b) => (charge = await f.config.reserve!(g, b)),
        onUsage: async (r, g, c) => {
          entered.resolve();
          await release.promise;
          await f.config.onUsage!(r, g, c);
          committed.resolve();
        },
      });
      const controller = new AbortController();
      const response = await h.call(controller.signal);
      await entered.promise;
      controller.abort();
      h.relay.close();
      await response.body!.cancel().catch(() => {});
      release.resolve();
      await committed.promise;
      await f.compare(charge, [...commands, { kind: 'commitCallback' }]);
    },
  );

  test(
    `${owner}: definite refusal waits for its refund; failed refund returns 503 and keeps the reservation`,
    options,
    async (t) => {
      const f = await fixture(t, owner);
      const entered = deferred();
      const release = deferred();
      let charge!: PiModelCharge;
      let fail = false;
      const h = await http(
        t,
        owner,
        {
          ...f.config,
          reserve: async (g, b) => (charge = await f.config.reserve!(g, b)),
          onUsage: async (r, g, c) => {
            entered.resolve();
            await release.promise;
            if (fail) throw new Error('database unavailable');
            await f.config.onUsage!(r, g, c);
          },
        },
        ModelRelay,
        429,
      );
      let replied = false;
      const pending = h.call().then((response) => {
        replied = true;
        return response;
      });
      await entered.promise;
      try {
        await pause(80);
        assert.equal(replied, false);
      } finally {
        release.resolve();
      }
      assert.equal((await pending).status, 502);
      await f.compare(charge, [
        { kind: 'send' },
        { kind: 'upstreamRefused' },
        { kind: 'commitCallback' },
      ]);
      fail = true;
      assert.equal((await h.call()).status, 503);
      await f.compare(charge, [{ kind: 'send' }, { kind: 'upstreamRefused' }, { kind: 'crash' }]);
    },
  );
}

test(
  'mutation: forwarding without awaiting the real accounting hook violates the Lean/HTTP contract',
  mutations,
  async (t) => {
    const source = readFileSync(
      new URL('../packages/fleet/src/model-relay.ts', import.meta.url),
      'utf8',
    );
    const target = 'await keep(data);';
    assert.equal(source.split(target).length, 2);
    const javascript = ts.transpileModule(
      source.replace(target, 'void keep(data).catch(() => {});'),
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      },
    ).outputText;
    const mutant = await importMutation(javascript);
    await assert.rejects(
      forwarding(t, 'fleet', mutant.ModelRelay),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message.includes('terminal preceded durable settlement'),
    );
  },
);

test(
  'mutation: removing the Fleet receipt guard applies a replayed delta twice',
  mutations,
  async (t) => {
    const source = readFileSync(
      new URL('../packages/fleet/src/codex-relay.ts', import.meta.url),
      'utf8',
    );
    const target = 'if (request.settled_tokens !== null)';
    assert.equal(source.split(target).length, 2);
    const mutantSource = source
      .replace(target, 'if (false)')
      .replaceAll("from 'zod'", `from '${import.meta.resolve('zod')}'`)
      .replaceAll("from '@merv/contracts'", `from '${import.meta.resolve('@merv/contracts')}'`);
    const javascript = ts.transpileModule(mutantSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const mutant = await importMutation(javascript);
    const f = await fixture(t, 'fleet');
    const config = mutant.codexModelRelay({} as Sessions, f.state, {
      providerKey: () => 'test-only-key',
      dailyTokensPerPerson: 100_000_000,
    }) as Config;
    const charge = await config.reserve!(grant, body);
    await config.onUsage!(record, grant, charge);
    await f.compare(charge, [...commands, { kind: 'commitCallback' }]);
    await config.onUsage!(record, grant, charge);
    await assert.rejects(
      f.compare(charge, [
        ...commands,
        { kind: 'commitCallback' },
        { kind: 'settleRequest', requestId: 1, amount: 34 },
      ]),
      (error) => error instanceof assert.AssertionError,
    );
  },
);
