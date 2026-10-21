import { gitTransport } from './git-http.js';
import type { TaskCreate, Tasks } from '@merv/tasks/types';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  effectiveWorkspace,
  type Caller,
  type Data,
  type Transaction,
  type WorkspaceHandle,
} from '@merv/contracts';
import type { Session, Sessions, WorkSession } from '@merv/sessions/types';
import { live, ownEnd } from '@merv/sessions/rules';
import type { Code } from '@merv/code-work/types';
import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import { waitForManagedCode } from './managed-code.js';

type Host = {
  sessions: Sessions;
  codeWork?: Code;
  code?: unknown;
  domainEvents?: { drain(): Promise<void> };
  events?: unknown;
};

/** Public creation, after the actual managed repository has finished initializing. */
export async function currentTask(
  host: Pick<Host, 'codeWork' | 'code'> & { tasks: Tasks },
  caller: Caller,
  input: TaskCreate,
  transaction?: Transaction,
) {
  await waitForManagedCode((host.codeWork ?? host.code) as Code, caller);
  return host.tasks.create(caller, input, transaction);
}

export const createCurrentTask = currentTask;

/**
 * Play a runner through the real Code driver and authenticated native Git remote.
 * Test agents make ordinary Git commits; submission capture never fabricates receipts.
 * Dispose before closing the host services; the caller owns the temporary directory.
 */
export function currentWork(host: Host, options: { directory: string; source: Caller }) {
  // Read on every call: a reloaded Code Work is a new service.
  const current = () => (host.codeWork ?? host.code) as Code;
  const code = current();
  const events = (host.domainEvents ?? host.events) as { drain?(): Promise<void> } | undefined;
  assert.ok(code?.v2, 'Current work requires managed Code');
  const transports: ReturnType<typeof gitTransport>[] = [];
  const held = new Set<Awaited<ReturnType<typeof attach>>>();
  const prefix = randomBytes(8).toString('hex');
  let sequence = 0;
  const request = () => `current-work-${prefix}-${++sequence}`;

  async function lease(
    task: { id: string; workflow: { revision: number } },
    source = options.source,
  ) {
    const runnerId = request();
    await host.sessions.dispatch.heartbeatRunner(source, {
      runnerId,
      machine: {
        hostname: 'current-work-test',
        system: process.platform,
        architecture: process.arch,
      },
      platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 1 }],
      capacity: 1,
      capabilities: ['code.git.1'],
    });
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await host.sessions.offer(source, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
      runnerId,
      requestId: request(),
      secret,
    });
    const result = await attach(session, source);
    result.worker = await host.sessions.authenticate(secret);
    result.token = secret;
    return result;
  }

  /** Attach an already offered lease, without activating or authenticating its worker. */
  async function attach(offered: Session, source = options.source) {
    // Only a work visit has a workspace to attach.
    const session = offered as WorkSession;
    const runnerId = session.runnerId;
    const directory = join(options.directory, request());
    mkdirSync(directory, { recursive: true });
    let stopped = false;
    const launch = { id: request(), sessionId: session.id, runDirectory: directory };
    const control = { sessionId: session.id, runnerId, hostRef: launch.id };
    if (effectiveWorkspace(session.execution.policy).mode === 'none') {
      await host.sessions.attach(source, control);
      const result = {
        source,
        session,
        worker: undefined as unknown as Caller,
        token: '',
        driver: undefined as unknown as CodeWorkspaceDriver,
        launch,
        control,
        workspace: {
          path: directory,
          retain: false,
          readOnly: session.execution.policy.readOnly,
          status: 'ready',
        } as WorkspaceHandle,
        stop: () => {
          stopped = true;
        },
      };
      held.add(result);
      return result;
    }
    const http = gitTransport(current, source);
    transports.push(http);
    const driver = new CodeWorkspaceDriver(
      { directory, path: join(directory, 'ledger.sqlite'), terminal: () => stopped },
      http.transport,
    );
    const workspace = await driver.prepare(launch, session);
    await host.sessions.attach(source, { ...control, workspace: workspace.snapshot! });
    const result = {
      source,
      session,
      worker: undefined as unknown as Caller,
      token: '',
      driver,
      launch,
      control,
      workspace,
      stop: () => {
        stopped = true;
      },
    };
    held.add(result);
    return result;
  }

  type Held = Awaited<ReturnType<typeof lease>>;
  async function run<T>(
    lease: Held,
    tool: string,
    input: Data,
    handler: (caller: Caller, bound: Data) => T | Promise<T>,
  ): Promise<T> {
    assert.ok(lease.worker, 'Authenticate the attached worker before invoking its tools');
    return host.sessions.invocations.run(
      await host.sessions.invocations.prepare(lease.worker, tool, input),
      handler,
    );
  }

  async function commit(
    lease: Held,
    files: Record<string, string> = { 'evidence.txt': request() },
  ) {
    assert.ok(lease.driver, 'Only Git work has a commit driver');
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(lease.workspace.path, path)), { recursive: true });
      writeFileSync(join(lease.workspace.path, path), content);
    }
    const access = lease.driver.agentGit(lease.launch.id);
    const git = async (...args: string[]) =>
      (
        await promisify(execFile)('git', args, {
          cwd: lease.workspace.path,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: `http.${access.url}.extraHeader`,
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`merv:${access.token}`).toString('base64')}`,
            GIT_CONFIG_KEY_1: 'http.followRedirects',
            GIT_CONFIG_VALUE_1: 'false',
          },
        })
      ).stdout.trim();
    await git('add', '-A');
    await git('commit', '-qm', 'Agent commits workflow test evidence');
    await git('push', 'merv', 'HEAD');
    return await git('rev-parse', 'HEAD');
  }

  async function release(lease: Held) {
    if (!held.has(lease)) return;
    lease.stop();
    try {
      // Some authority tests close the server session directly. They are not a runner
      // handoff, so teardown must not try to acquire new capture authority afterward.
      const session = await host.sessions.get(lease.source, lease.session.id);
      if (!live(session) && !ownEnd(session.closeReason)) return;
      // As the runner does: what the session left is captured before its release, while its
      // writer generation is live, and the release is always sent (a landed handoff is recorded
      // as that, whoever releases it).
      const captured = lease.driver ? await lease.driver.capture(lease.launch) : undefined;
      await host.sessions.release(lease.source, {
        sessionId: lease.session.id,
        runnerId: lease.control.runnerId,
      });
      await events?.drain?.();
      if (lease.driver) {
        const workspace = captured ?? (await lease.driver.capture(lease.launch));
        if (workspace)
          await host.sessions.workspaceResult(lease.source, { ...lease.control, workspace });
        await lease.driver.close(lease.launch);
        await events?.drain?.();
      }
    } catch (error) {
      if (process.env.MERV_GIT_TEST_DEBUG) console.error(error);
      // Revocation tests intentionally remove the runner's authority. Cleanup can dispose
      // its local ledger, but cannot acquire replacement authority to write final captures.
      if (
        !['forbidden', 'credential_revoked', 'session_completed', 'session_closed'].includes(
          (error as { code?: string }).code ?? '',
        )
      )
        throw error;
    } finally {
      lease.driver?.dispose();
      held.delete(lease);
    }
  }

  return {
    lease,
    attach,
    run,
    commit,
    release,
    request,
    async close() {
      const results = await Promise.allSettled([...held].map(release));
      await Promise.all(transports.map((t) => t.close()));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    },
  };
}
