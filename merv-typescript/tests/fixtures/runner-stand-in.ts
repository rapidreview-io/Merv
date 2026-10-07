import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import type { WorkspaceDriverFactory } from '@merv/contracts';
import { MachineRunner, type RunnerConfig } from '@merv/runner';
import { LocalLedger } from '../../packages/runner/src/ledger.js';

/**
 * A machine runner against a stand-in Sessions server: what each answer does to the runner,
 * with no application behind it.
 */
export const projectId = 'project_fixture';
const baseUrl = 'http://127.0.0.1:9';
export type Body = Record<string, any>;
interface Call {
  path: string;
  body: Body | undefined;
}
export class Refusal {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {}
}
export const launchId = (sessionId: string) =>
  `launch_${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;

export function offer(
  name: string,
  patch: { brief?: string; workspace?: unknown; assignment?: Body; expiresAt?: string } = {},
) {
  const instanceId = `instance_${name}`;
  const common = { instanceId, projectId, actorId: 'actor_fixture', revision: 0 };
  return {
    id: `session_${name}`,
    projectId,
    actorId: 'actor_fixture',
    instanceId,
    runnerId: '',
    hostRef: null as string | null,
    expectedRevision: 0,
    status: 'offered',
    closeReason: null as string | null,
    outcome: null as string | null,
    expiresAt: patch.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    hardDeadline: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    assignment: {
      ...common,
      label: 'Work',
      brief: patch.brief ?? 'Do the work.',
      execution: { readOnly: false },
      ...patch.assignment,
    },
    execution: {
      ...common,
      policy: {
        readOnly: false,
        tools: [],
        ...(patch.workspace ? { workspace: patch.workspace } : {}),
      },
      references: {},
    },
  } as Body;
}

/**
 * Sessions as a runner sees it: presence, lease, the session controls and Code's next command.
 * `refuse` answers any call with a refusal first, as a failing or unloaded route would.
 */
export function server(
  lease: (body: Body) => Body | null | string | Refusal,
  settings: { version: number; platforms: unknown[] } = { version: 0, platforms: [] },
  refuse: (path: string, body: Body | undefined) => Refusal | undefined = () => undefined,
  clock: () => number = Date.now,
) {
  const calls: Call[] = [];
  const sessions = new Map<string, Body>();
  const reply = (value: unknown, status = 200) => Response.json(value, { status });
  const refusal = (answer: Refusal) =>
    reply({ error: { code: answer.code, message: answer.code } }, answer.status);
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : undefined;
    calls.push({ path, body });
    const refused = refuse(path, body);
    if (refused) return refusal(refused);
    if (path === '/sessions/runners/heartbeat')
      return reply({
        runner: {
          runnerId: body!.runnerId,
          desiredVersion: settings.version,
          desiredSettings: { platforms: settings.platforms },
        },
      });
    if (path === '/code/commands/next') return reply({ command: null });
    if (path === '/sessions/lease') {
      const answer = lease(body!);
      if (answer instanceof Refusal) return refusal(answer);
      // A string is a decline's reason; null declines with no candidates.
      if (answer === null || typeof answer === 'string')
        return reply({ session: null, reason: answer ?? 'no_candidates' });
      const session = sessions.get(answer.id) ?? { ...answer, runnerId: body!.runnerId };
      sessions.set(session.id, session);
      return reply({ session, reason: 'leased' });
    }
    const [, , id, action] = path.split('/');
    // As a server from before transcripts answers: final, so a launch that printed calls once.
    if (action === 'transcript')
      return reply({ error: { code: 'not_found', message: 'No route' } }, 404);
    const session = sessions.get(decodeURIComponent(id ?? ''));
    if (!session) return reply({ error: { code: 'session_not_found', message: 'No' } }, 404);
    if (action === 'launch-connections') return reply({ connections: [] });
    // A tick's poll: the server answers its control fields, which the runner picks out.
    if (action === 'control') return reply({ control: session });
    if (action === 'attach') {
      session.hostRef = body!.hostRef;
      if (body!.workspace) session.workspace = { attachment: body!.workspace, result: null };
    } else if (action === 'release' && ['offered', 'active'].includes(session.status)) {
      session.status = 'released';
      session.closeReason = body!.reason ?? 'released';
      session.outcome = body!.outcome ?? 'released';
    } else if (action === 'workspace-result') session.workspace.result = body!.workspace;
    else if (action === 'heartbeat' && session.status === 'active') {
      // As Sessions renews: a slide of at least 15 minutes, or any slide to the hard deadline.
      const hard = Date.parse(session.hardDeadline);
      const slid = Math.min(clock() + 4 * 3_600_000, hard);
      if (slid - Date.parse(session.expiresAt) >= (slid === hard ? 1 : 900_000))
        session.expiresAt = new Date(slid).toISOString();
    }
    return reply({
      session,
      ...(action === 'attach' ? { prompt: 'Stand-in worker prompt.' } : {}),
    });
  };
  const leases = (platform: string) =>
    calls.filter(
      (call) => call.path === '/sessions/lease' && call.body?.platform.name === platform,
    );
  const releases = (sessionId: string) =>
    calls.filter((call) => call.path === `/sessions/${sessionId}/release`);
  return { fetch, calls, sessions, leases, releases };
}

export function machine(
  t: TestContext,
  profiles: RunnerConfig['profiles'],
  fetcher: typeof fetch,
  options: {
    config?: Partial<RunnerConfig>;
    drivers?: WorkspaceDriverFactory[];
    clock?: () => number;
    resetAssignment?: () => Promise<void>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'merv-stand-in-'));
  const credentialEnv = `MERV_STAND_IN_${process.pid}`;
  process.env[credentialEnv] = `mk_${'l'.repeat(43)}`;
  const config: RunnerConfig = {
    directory: join(root, 'machine'),
    baseUrl,
    projectId,
    credentialEnv,
    profiles,
    ...options.config,
  };
  const runners: MachineRunner[] = [];
  t.after(async () => {
    for (const runner of runners) await runner.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const make = (drivers = options.drivers ?? []) => {
    const runner = new MachineRunner(config, {
      autoPoll: false,
      fetch: fetcher,
      drivers,
      resetAssignment: options.resetAssignment,
      ...(options.clock ? { clock: options.clock } : {}),
    });
    runners.push(runner);
    return runner;
  };
  /** The runner's own ledger, opened beside it; the same binding a runner derives. */
  const ledger = () =>
    new LocalLedger({
      directory: config.directory,
      binding: {
        baseUrl,
        projectId,
        sourceId: createHash('sha256').update(process.env[credentialEnv]!).digest('hex'),
      },
    });
  return { root, config, make, ledger };
}
export const node = (name: string, source = 'process.exit(0)', parallelism = 1) => ({
  name,
  harness: 'command' as const,
  executable: process.execPath,
  args: ['-e', source],
  enabled: true,
  parallelism,
});
export async function until(runner: MachineRunner, condition: () => boolean, label: string) {
  const end = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > end) assert.fail(`${label}: ${JSON.stringify(runner.snapshot())}`);
    await runner.tick();
    await delay(25);
  }
}
/** A launch that ended before this runner started, as an earlier controller left it. */
export const ended = (
  directory: string,
  id: string,
  end: { status?: string; reason?: string | null; exitCode?: number } = {},
) => {
  const db = new DatabaseSync(join(directory, 'ledger.sqlite'));
  db.prepare('UPDATE launches SET status=?,reason=?,exit_code=? WHERE id=?').run(
    end.status ?? 'stopped',
    end.reason === undefined ? 'cancelled_before_spawn' : end.reason,
    end.exitCode ?? null,
    id,
  );
  db.close();
};
export const metadata = (directory: string, id: string) => {
  const db = new DatabaseSync(join(directory, 'ledger.sqlite'));
  try {
    return JSON.parse(
      String(db.prepare('SELECT metadata_json FROM launches WHERE id=?').get(id)!.metadata_json),
    );
  } finally {
    db.close();
  }
};
