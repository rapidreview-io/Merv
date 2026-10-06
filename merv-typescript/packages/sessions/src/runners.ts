import { z } from 'zod';
import {
  recorded,
  canonical,
  MervError,
  check,
  newId,
  type Caller,
  type Transaction,
} from '@merv/contracts';
import type { DispatchDecision, RunnerHeartbeat, RunnerPresence, RunnerSettings } from './types.js';
import { isoNow, ownerOf, readFirst } from './common.js';
import { capabilitiesSchema, label, platformTuning, runnerPlatformSchema } from './rules.js';
import type { DispatchContext } from './dispatch.js';

// What a runner says of itself and what the server publishes to it: presence, heartbeats and
// settings. SessionDispatch (dispatch.ts) runs these with itself as their context.
const platformsSchema = z
  .array(runnerPlatformSchema)
  .max(32)
  .refine(
    (items) => new Set(items.map((item) => item.name)).size === items.length,
    'Platform names must be distinct',
  );
const settingsSchema = z
  .object({
    platforms: z
      .array(z.object(platformTuning).strict())
      .max(32)
      .refine((items) => new Set(items.map((item) => item.name)).size === items.length),
  })
  .strict();
export const heartbeatSchema = z
  .object({
    runnerId: label,
    machine: z.object({ hostname: label, system: label, architecture: label }).strict(),
    platforms: platformsSchema,
    capacity: z.number().int().min(0).max(256),
    appliedVersion: z.number().int().nonnegative().safe().optional(),
    capabilities: capabilitiesSchema.optional(),
  })
  .strict();
/** How long a runner's last heartbeat keeps it present. */
export const freshForMs = 45_000;
export const rented =
  'SELECT 1 FROM session_managed_runners m WHERE m.project_id=r.project_id AND m.runner_id=r.runner_id';
export interface RunnerRow {
  id: string;
  project_id: string;
  owner_hash: string;
  runner_id: string;
  source_json: string;
  presence_json: string;
  desired_version: number;
  settings_json: string;
  last_seen_at: string;
  last_decision: DispatchDecision | null;
  last_decision_at: string | null;
  decision_since: string | null;
}
/** Whether the caller's own runner last said it has a capability. No presence means no. */
export async function capable(
  ctx: DispatchContext,
  caller: Caller,
  runnerId: string,
  capability: string,
  tx: Transaction,
): Promise<boolean> {
  const runner = await tx.get<RunnerRow>(
    'SELECT * FROM session_runners WHERE owner_hash=? AND runner_id=?',
    (await ownerOf(ctx.scope, caller, tx)).hash,
    runnerId,
  );
  return (
    !!runner &&
    ((JSON.parse(runner.presence_json) as RunnerHeartbeat).capabilities ?? []).includes(capability)
  );
}
/** Whether the key a runner registered with may still read the project. */
export async function authorized(
  ctx: DispatchContext,
  sourceJson: string,
  tx: Transaction,
): Promise<boolean> {
  try {
    await ctx.scope.requireDelegation(JSON.parse(sourceJson), 'read', tx);
    return true;
  } catch (error) {
    if (error instanceof MervError && (error.status === 401 || error.status === 403)) return false;
    throw error;
  }
}
export async function presence(
  ctx: DispatchContext,
  row: RunnerRow,
  tx: Transaction,
): Promise<RunnerPresence> {
  // Only a runner heard from lately can be live, so only its key is checked.
  const live =
    Date.parse(row.last_seen_at) + freshForMs > ctx.clock() &&
    (await authorized(ctx, row.source_json, tx));
  return {
    ...JSON.parse(row.presence_json),
    id: row.id,
    lastSeenAt: row.last_seen_at,
    live,
    desiredVersion: row.desired_version,
    desiredSettings: JSON.parse(row.settings_json),
    lastDecision: row.last_decision ?? null,
    lastDecisionAt: row.last_decision_at ?? null,
    decisionSince: row.decision_since ?? null,
  };
}
function fresh(ctx: DispatchContext, at: string | null, ms: number): boolean {
  return at !== null && Date.parse(at) + ms > ctx.clock();
}
/**
 * The answer this runner's last lease request received, kept where the runner is. A
 * repeated answer keeps the moment it was first given, so a refusal says how long it has
 * held. A runner that was already repeating its answer before the moment was kept starts
 * counting now, or its refusal would stay silent. One statement: every right-hand side
 * reads the row as it was.
 */
export async function decided(
  ctx: DispatchContext,
  ownerHash: string,
  runnerId: string,
  decision: DispatchDecision,
  tx: Transaction,
): Promise<void> {
  const time = isoNow(ctx.clock);
  const old = await tx.get<RunnerRow>(
    'SELECT * FROM session_runners WHERE owner_hash=? AND runner_id=?',
    ownerHash,
    runnerId,
  );
  // The same answer is refreshed at most every 15 s, so an idle poll writes nothing.
  if (old?.last_decision === decision && fresh(ctx, old.last_decision_at, 15_000)) return;
  await tx.run(
    'UPDATE session_runners SET decision_since=CASE WHEN last_decision=? THEN COALESCE(decision_since,?) ELSE ? END,last_decision=?,last_decision_at=? WHERE owner_hash=? AND runner_id=?',
    decision,
    time,
    time,
    decision,
    time,
    ownerHash,
    runnerId,
  );
}
export async function heartbeatRunner(
  ctx: DispatchContext,
  caller: Caller,
  input: RunnerHeartbeat,
): Promise<RunnerPresence> {
  ctx.enter();
  caller = structuredClone(caller);
  const parsed = heartbeatSchema.safeParse(input);
  check(
    parsed.success,
    'invalid_runner',
    'Runner heartbeat must use the closed machine, platform and capacity schema',
  );
  input = parsed.data;
  return await readFirst(ctx.state, async (tx) => {
    const managed = !!caller.managed;
    const source = managed ? await ctx.hooks.managed.heartbeat(caller, input, tx) : caller;
    // A runner is a durable presence that will take work: registering one is a write, or a
    // review for Fleet's review director, which takes only reviews.
    await ctx.scope.require(source, source.service ? 'review' : 'write', tx);
    const owner = await ownerOf(ctx.scope, source, tx);
    const old = await tx.get<RunnerRow>(
      'SELECT * FROM session_runners WHERE owner_hash=? AND runner_id=?',
      owner.hash,
      input.runnerId,
    );
    check(
      (input.appliedVersion ?? 0) <= (old?.desired_version ?? 0),
      'invalid_settings_version',
      'Runner cannot acknowledge unpublished settings',
    );
    const id = old?.id ?? newId('runner'),
      time = isoNow(ctx.clock);
    // Fresh for 45 s, an unchanged presence (parsed, so the same text) is recorded every 10 s.
    if (old?.presence_json === JSON.stringify(input) && fresh(ctx, old.last_seen_at, 10_000))
      return await presence(ctx, old, tx);
    if (old)
      await tx.run(
        'UPDATE session_runners SET presence_json=?,last_seen_at=? WHERE id=?',
        JSON.stringify(input),
        time,
        id,
      );
    else {
      // A machine Fleet rents is a new runner each time; Fleet's own caps bound those.
      check(
        managed ||
          (await tx.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM session_runners r WHERE project_id=? AND NOT EXISTS (${rented})`,
            source.projectId,
          ))!.n < 1000,
        'runner_limit',
        'Project runner limit reached',
        409,
      );
      await tx.run(
        'INSERT INTO session_runners(id,project_id,owner_hash,runner_id,source_json,presence_json,settings_json,last_seen_at) VALUES(?,?,?,?,?,?,?,?)',
        id,
        source.projectId,
        owner.hash,
        input.runnerId,
        JSON.stringify(owner.source),
        JSON.stringify(input),
        JSON.stringify({ platforms: [] }),
        time,
      );
      await recorded(ctx.state, tx, source, 'session.runner_registered', id, { runnerRef: id });
    }
    return await presence(
      ctx,
      (await tx.get<RunnerRow>('SELECT * FROM session_runners WHERE id=?', id))!,
      tx,
    );
  });
}
export async function setRunnerSettings(
  ctx: DispatchContext,
  caller: Caller,
  input: { runnerId: string; settings: RunnerSettings },
): Promise<RunnerPresence> {
  ctx.enter(caller);
  caller = structuredClone(caller);
  const parsed = z.object({ runnerId: label, settings: settingsSchema }).strict().safeParse(input);
  check(
    parsed.success,
    'invalid_runner_settings',
    'Runner settings accept only named platform tuning',
  );
  input = parsed.data;
  return await ctx.state.transaction(async (tx) => {
    await ctx.ordinary(caller, 'admin', tx);
    const row = await tx.get<RunnerRow>(
      'SELECT * FROM session_runners WHERE id=? AND project_id=?',
      input.runnerId,
      caller.projectId,
    );
    check(row, 'runner_not_found', 'Runner not found in this project', 404);
    const platforms = (JSON.parse(row.presence_json) as RunnerHeartbeat).platforms;
    check(
      input.settings.platforms.every((item) =>
        platforms.some((platform) => platform.name === item.name),
      ),
      'unknown_platform',
      'Runner settings may tune only an advertised platform',
    );
    if (canonical(JSON.parse(row.settings_json)) !== canonical(input.settings)) {
      await tx.run(
        'UPDATE session_runners SET settings_json=?,desired_version=desired_version+1 WHERE id=?',
        JSON.stringify(input.settings),
        row.id,
      );
      await recorded(ctx.state, tx, caller, 'session.runner_settings_changed', row.id, {
        runnerRef: row.id,
        desiredVersion: row.desired_version + 1,
      });
    }
    return await presence(
      ctx,
      (await tx.get<RunnerRow>('SELECT * FROM session_runners WHERE id=?', row.id))!,
      tx,
    );
  });
}
