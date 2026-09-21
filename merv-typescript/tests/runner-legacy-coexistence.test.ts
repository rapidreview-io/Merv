import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Caller, CodeStoreOperation } from '@merv/contracts';
import { MachineRunner } from '@merv/runner';
import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import type { CodeService } from '@merv/code/service';
import type { Session } from '@merv/sessions/types';
import { createApp } from '../src/app.js';
import { boundProject } from './fixtures/code-binding.js';
import { gitSource } from './fixtures/code-store.js';

type App = Awaited<ReturnType<typeof createApp>>;

/** Every session the server holds, with its checkout; each machine's own actor owns its own. */
const stored = async (app: App): Promise<Session[]> => {
  const read = await app.ctx.state.read(async (sql) => ({
    sessions: await sql.all<{ session_json: string }>('SELECT session_json FROM worker_sessions'),
    workspaces: await sql.all<{ session_id: string; attachment_json: string }>(
      'SELECT session_id,attachment_json FROM session_workspaces',
    ),
  }));
  const attached = new Map(
    read.workspaces.map((row) => [row.session_id, JSON.parse(row.attachment_json)]),
  );
  return read.sessions.map((row) => {
    const session = JSON.parse(row.session_json) as Session;
    const attachment = attached.get(session.id);
    return attachment ? { ...session, workspace: { attachment, result: null } } : session;
  });
};

/** One machine, with or without Code's workspace driver, against the same server. */
function machine(
  t: TestContext,
  app: App,
  root: string,
  name: string,
  token: string,
  owner: Caller,
  options: { driver: boolean; repository: string },
) {
  const credentialEnv = `MERV_COEXIST_${name.toUpperCase()}`;
  const previous = process.env[credentialEnv];
  process.env[credentialEnv] = token;
  const control = join(root, `${name}-control`);
  const executable = join(root, `${name}-agent.sh`);
  writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(
      new URL('./fixtures/runner-puppet-worker.mjs', import.meta.url),
    )}" "${control}"\n`,
    { mode: 0o700 },
  );
  const runner = new MachineRunner(
    {
      directory: join(root, name),
      baseUrl: app.ctx.api.url!,
      projectId: owner.projectId,
      credentialEnv,
      // Both machines keep a repository of their own, which is what every legacy version
      // still uses; only one of them also carries Code's driver.
      workspace: { repository: options.repository, baseRef: 'main' },
      profiles: [{ name: 'worker', harness: 'claude', executable, enabled: true, parallelism: 1 }],
    },
    {
      autoPoll: false,
      ...(options.driver
        ? {
            drivers: [
              {
                name: 'code.v2',
                create: (host, transport) =>
                  new CodeWorkspaceDriver(host, transport, { pollMs: 25 }),
              },
            ],
          }
        : {}),
    },
  );
  t.after(async () => {
    await runner.stop();
    if (previous === undefined) delete process.env[credentialEnv];
    else process.env[credentialEnv] = previous;
  });
  const seen = new Set<string>();
  const seenSessions = new Set<string>();
  const until = async <T>(what: string, found: () => T | undefined | Promise<T | undefined>) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      await runner.tick().catch(() => {});
      const value = await found();
      if (value !== undefined) return value;
      assert.ok(Date.now() < deadline, `${name}: ${what}: ${JSON.stringify(runner.snapshot())}`);
      await delay(40);
    }
  };
  return {
    runner,
    until,
    /** Tick until a worker of this machine has started, and say which session it belongs to. */
    async worker(): Promise<{ cwd: string; session: Session }> {
      const directory = await until('a worker starts', () => {
        const next = (existsSync(control) ? readdirSync(control) : []).find(
          (entry) => !seen.has(entry) && existsSync(join(control, entry, 'ready.json')),
        );
        return next && join(control, next);
      });
      seen.add(directory.slice(control.length + 1));
      const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8')) as {
        cwd: string;
      };
      const session = await until('its session is attached', async () =>
        (await stored(app)).find(
          (item) =>
            item.runnerId === runner.snapshot().runnerId &&
            item.closedAt === null &&
            item.workspace?.attachment &&
            !seenSessions.has(item.id),
        ),
      );
      seenSessions.add(session.id);
      return { cwd: ready.cwd, session };
    },
    async accepting(enabled: boolean, parallelism = 1) {
      const presence = (await app.ctx.sessions.projectStatus(owner)).runners.find(
        (item) => item.runnerId === runner.snapshot().runnerId,
      )!;
      await app.ctx.sessions.setRunnerSettings(owner, {
        runnerId: presence.id,
        settings: { platforms: [{ name: 'worker', enabled, parallelism }] },
      });
      await runner.tick();
      await runner.tick();
    },
    capabilities: async () =>
      (await app.ctx.sessions.projectStatus(owner)).runners.find(
        (item) => item.runnerId === runner.snapshot().runnerId,
      )?.capabilities,
    decision: async () =>
      (await app.ctx.sessions.projectStatus(owner)).runners.find(
        (item) => item.runnerId === runner.snapshot().runnerId,
      )?.lastDecision,
  };
}

test(
  'a machine without Code’s driver keeps taking the Git work it always took, and is never offered the work that needs it',
  { timeout: 180_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'merv-coexist-'));
    const operator = gitSource(t);
    const main = operator.commit({ 'README.md': 'The project.\n' }, 'Initial');
    const app = await createApp({ directory: join(root, 'server'), api: true, port: 0 });
    t.after(async () => {
      await app.stop();
      rmSync(root, { recursive: true, force: true });
    });
    const boot = await app.ctx.scope.bootstrap({ projectName: 'Mixed', actorName: 'Owner' });
    const owner: Caller = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    const { code, tasks, sessions, state } = app.ctx;
    await boundProject(state, owner.projectId, main, 'fixture-repository');

    // Two Git tasks made before the import, which are the versions a legacy machine serves.
    const create = async (requestId: string) =>
      await tasks.create(owner, {
        title: `Work ${requestId}`,
        goal: 'Do the work.',
        checks: ['It is done'],
        workspace: 'git',
        requestId,
      });
    const legacyWork = await create('legacy-one');
    const alsoLegacy = await create('legacy-two');
    assert.deepEqual(
      [legacyWork.workflow.version, alsoLegacy.workflow.version],
      [5, 5],
      'before the import, new Git work is the version a legacy machine knows',
    );

    const issue = async (name: string) =>
      (await app.ctx.scope.issueActor(owner, { name, role: 'operator' })).token;
    const legacy = machine(t, app, root, 'legacy', await issue('Legacy'), owner, {
      driver: false,
      repository: operator.repository,
    });
    const modern = machine(t, app, root, 'modern', await issue('Modern'), owner, {
      driver: true,
      repository: operator.repository,
    });
    await legacy.runner.start();
    await modern.runner.start();
    assert.equal(await legacy.capabilities(), undefined, 'an older machine advertises none');
    assert.deepEqual(await modern.capabilities(), ['code.v2']);

    await modern.accepting(false);
    await sessions.setDispatch(owner, { enabled: true });

    // The legacy machine prepares a checkout in its own repository, as it always has.
    const first = await legacy.worker();
    assert.equal(first.session.instanceId, legacyWork.id);
    const attachment = first.session.workspace!.attachment;
    assert.match(attachment.repositoryId, /^repo_/, 'its own repository, which it alone names');
    assert.match(attachment.branch!, /^codex\/merv\//);
    assert.ok(existsSync(join(first.cwd, '.git')));

    // The machine that carries the driver serves the same legacy work the same way: a policy
    // that names no driver still goes to the runner's own repository.
    await modern.accepting(true);
    const second = await modern.worker();
    assert.equal(second.session.instanceId, alsoLegacy.id);
    assert.match(second.session.workspace!.attachment.repositoryId, /^repo_/);
    assert.match(second.session.workspace!.attachment.branch!, /^codex\/merv\//);
    await modern.accepting(false);

    // The project is imported, and new Git work is the version that lives in Code.
    const v2 = (code as unknown as CodeService).v2!;
    const bundle = operator.bundle(main);
    const begun = await code.importRepository(owner, {
      source: 'bundle',
      tip: main,
      bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
      requestId: 'import',
    });
    await v2.putPart(owner, begun.id, 0, bundle.content);
    let imported = begun;
    for (let tries = 0; imported.status === 'prepared' && tries < 200; tries++) {
      ({ operation: imported } = (await v2.call(owner, `uploads/${begun.id}/complete`, {})) as {
        operation: CodeStoreOperation;
      });
      await delay(25);
    }
    assert.equal(imported.status, 'completed');
    const hosted = await create('hosted');
    assert.equal(hosted.workflow.version, 6);

    // With room to spare and nothing but the hosted work left, it is never offered it.
    await legacy.accepting(true, 2);
    await legacy.until('the hosted work is refused to it', async () =>
      (await legacy.decision()) === 'runner_incompatible' ? true : undefined,
    );
    assert.deepEqual(
      (await stored(app)).map((item) => item.instanceId).sort(),
      [legacyWork.id, alsoLegacy.id].sort(),
      'nothing else was offered to any machine',
    );
    await legacy.accepting(false, 2);

    await modern.accepting(true, 2);
    const third = await modern.worker();
    assert.equal(third.session.instanceId, hosted.id);
    assert.equal(third.session.workspace!.attachment.branch, `merv/work/${hosted.id}`);
    assert.equal((await code.unit(owner, hosted.id)).generation, 1);
    assert.notEqual(
      third.session.workspace!.attachment.repositoryId,
      second.session.workspace!.attachment.repositoryId,
      'Code’s repository is not the machine’s own',
    );

    // Nothing was counted against any of it.
    assert.deepEqual(
      await state.read(async (sql) => await sql.all('SELECT * FROM session_dispatch_holds')),
      [],
    );
    assert.equal(operator.git('rev-parse', 'HEAD'), main);
  },
);
