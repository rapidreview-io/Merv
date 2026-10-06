import type { TaskCreate, Tasks } from '@merv/tasks/types';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  effectiveWorkspace,
  type Caller,
  type Data,
  type Transaction,
  type WorkspaceHandle,
} from '@merv/contracts';
import type { Sessions, Session } from '@merv/sessions/types';
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
 * Play a runner through the real Code driver: leases, checkouts, Git bundles, commit
 * admission and final captures are all production operations. No receipts are fabricated.
 * Dispose before closing the host services; the caller owns the temporary directory.
 */
export function currentWork(host: Host, options: { directory: string; source: Caller }) {
  const code = (host.codeWork ?? host.code) as Code;
  const events = (host.domainEvents ?? host.events) as { drain?(): Promise<void> } | undefined;
  assert.ok(code?.v2, 'Current work requires managed Code');
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
      capabilities: ['code.v2'],
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
  async function attach(session: Session, source = options.source) {
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
    const driver = new CodeWorkspaceDriver(
      { directory, path: join(directory, 'ledger.sqlite'), terminal: () => stopped },
      {
        call: (route, body) => code.v2!.call(source, route, body),
        putPart: (id, offset, bytes) => code.v2!.putPart(source, id, offset, Buffer.from(bytes)),
        readPart: (id, input) => code.v2!.readPart!(source, id, input),
      },
      { pollMs: 10 },
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
    const queued = await run(
      lease,
      'code.commit',
      {
        expectedHead: lease.driver.get(lease.launch.id)!.snapshot!.headOid,
        message: 'Retain current workflow test evidence',
        requestId: request(),
      },
      (caller, bound) => code.commit(caller, bound as unknown as Parameters<Code['commit']>[1]),
    );
    const command = await code.nextCommand(lease.source, lease.control);
    assert.equal(command?.id, queued.command.id);
    const receipt = await lease.driver.checkpointCommit(lease.launch, command!);
    await code.completeCommand(lease.source, {
      ...lease.control,
      commandId: command!.id,
      receipt,
    });
    lease.driver.acknowledgeCommit(command!.id);
    return command!.id;
  }

  async function release(lease: Held) {
    if (!held.has(lease)) return;
    lease.stop();
    try {
      const session = await host.sessions.get(lease.source, lease.session.id);
      if (!session.closedAt)
        await host.sessions.release(lease.source, {
          sessionId: lease.session.id,
          runnerId: lease.control.runnerId,
        });
      await events?.drain?.();
      if (lease.driver) {
        const workspace = await lease.driver.capture(lease.launch);
        if (workspace)
          await host.sessions.workspaceResult(lease.source, { ...lease.control, workspace });
        await lease.driver.close(lease.launch);
        await events?.drain?.();
      }
    } catch (error) {
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
      for (const lease of held) await release(lease);
    },
  };
}
