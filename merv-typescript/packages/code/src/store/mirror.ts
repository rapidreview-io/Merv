import {
  canonical,
  check,
  codeMirrorRetryInputSchema,
  digest,
  MervError,
  newId,
  now,
  type Caller,
  type CodeMirrorStatus,
  type CodeStoreWarning,
  type Scope,
  type State,
  type Transaction,
} from '@merv/contracts';
import { parseCodeInput } from '../input.js';
import type { CodeRepositories } from './repository.js';
import { acceptedRef, workRef } from './refs.js';

/** What the server publishes a ref to, or why it publishes nothing. */
export type MirrorTarget = { repository: string } | { blocked: string };
export interface MirrorUpdate {
  ref: string;
  oid: string;
  /** The value the remote must still hold, or null for a ref that must not exist yet. */
  expectedRemote: string | null;
}
/** `unknown` is a push whose answer was lost; the ref is read again and decided on afresh. */
export type MirrorOutcome = 'ok' | 'rejected' | 'unknown';
/**
 * Everything the mirror does to a repository it does not own. Code names the ref and the
 * commit; whatever implements this carries the credential, which never leaves the server.
 */
export interface MirrorTransport {
  target(projectId: string): Promise<MirrorTarget>;
  lsRemote(projectId: string, ref: string): Promise<string | null>;
  push(projectId: string, update: MirrorUpdate): Promise<MirrorOutcome>;
}

export interface CodeMirrorConfig {
  /** How often the server looks for refs to publish; zero runs only when it is asked to. */
  mirrorSeconds: number;
  /** How often one ref is retried before it waits for an operator. */
  maxAttempts: number;
  /** The first wait after a failure; it doubles, up to an hour. */
  backoffMs: number;
  /** How long one pass may hold a row before another may take it up. */
  claimSeconds: number;
}
export const defaultMirrorConfig: CodeMirrorConfig = {
  mirrorSeconds: 30,
  maxAttempts: 5,
  backoffMs: 30_000,
  claimSeconds: 120,
};
const MAX_BACKOFF_MS = 3600_000;
const WARNINGS = 20;
const PRINCIPAL = 'system:code';
const kinds = ['mirror-work', 'mirror-accepted', 'mirror-base'] as const;
export type MirrorKind = (typeof kinds)[number];
/** Where a ref of Code's own repository is published under. */
const published = (ref: string) => ref.replace(/^refs\/merv\//, 'refs/heads/merv/');

interface MirrorRow {
  id: string;
  project_id: string;
  unit_id: string | null;
  kind: string;
  payload_json: string;
  status: string;
  phase: string | null;
  attempts: number | string;
  next_at: string | null;
  detail_json: string | null;
  created_at: string;
  updated_at: string | null;
}
interface MirrorPayload {
  format: 1;
  source: 'mirror';
  kind: MirrorKind;
  unitId: string;
  ref: string;
  /** The commit that was asked for; a work ref reads the unit's newest head when it runs. */
  tip: string;
}
const columns =
  'id,project_id,unit_id,kind,payload_json,status,phase,attempts,next_at,detail_json,created_at,updated_at';

/**
 * Ask for a ref to be published. One open row per unit and kind at a time: a ref asked for
 * again while one waits changes nothing, because the row reads the unit's newest head when it
 * runs. Updates therefore coalesce, and a delayed pass can never put an older commit back.
 */
export async function enqueueMirror(
  tx: Transaction,
  projectId: string,
  kind: MirrorKind,
  unitId: string,
  tip: string,
): Promise<void> {
  const ref =
    kind === 'mirror-base'
      ? `refs/merv/bases/${unitId}`
      : kind === 'mirror-work'
        ? workRef(unitId)
        : acceptedRef(unitId);
  const requestId = `${kind}:${unitId}:${tip}`;
  const open = await tx.get<{ id: string }>(
    "SELECT id FROM code_operations WHERE project_id=? AND unit_id=? AND kind=? AND status='prepared'",
    projectId,
    unitId,
    kind,
  );
  if (open) return;
  const done = await tx.get<{ id: string }>(
    'SELECT id FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?',
    projectId,
    PRINCIPAL,
    requestId,
  );
  if (done) return;
  const payload: MirrorPayload = { format: 1, source: 'mirror', kind, unitId, ref, tip };
  const at = now();
  await tx.run(
    'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,created_at,unit_id,phase,next_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    newId('cop'),
    projectId,
    PRINCIPAL,
    requestId,
    kind,
    digest(payload),
    canonical(payload),
    'prepared',
    at,
    unitId,
    'queued',
    at,
    at,
  );
}

/**
 * The asynchronous publication of what Code holds. A handoff is complete the moment Code has
 * the commit, so nothing here is ever on anyone's path: a repository that is away, refusing or
 * has moved by another hand only leaves this work queued, retrying or blocked, and says so.
 *
 * Work refs only ever move forward, which is checked in Code's own repository before a push,
 * and accepted and base refs are only ever created. Nothing here forces, and nothing here deletes.
 */
export class CodeMirrorService {
  private closed = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  readonly config: CodeMirrorConfig;
  constructor(
    private readonly state: State,
    private readonly scope: Scope,
    private readonly repositories: CodeRepositories,
    private readonly transport: MirrorTransport,
    config: Partial<CodeMirrorConfig> = {},
  ) {
    this.config = { ...defaultMirrorConfig, ...config };
  }

  initialize(): void {
    if (!this.config.mirrorSeconds) return;
    this.timer = setInterval(
      () => void this.run().catch(() => {}),
      this.config.mirrorSeconds * 1000,
    );
    this.timer.unref();
  }

  /** One pass over everything due. Refusals stay on their rows; nothing here throws. */
  async run(): Promise<void> {
    if (this.closed) return;
    this.running ??= (async () => {
      try {
        const at = now();
        const due = await this.state.read(
          async (sql) =>
            await sql.all<MirrorRow>(
              `SELECT ${columns} FROM code_operations WHERE status='prepared' AND kind IN ('mirror-work','mirror-accepted','mirror-base') AND phase IN ('queued','retry_wait','running') AND (next_at IS NULL OR next_at<=?) ORDER BY next_at,created_at,id LIMIT 50`,
              at,
            ),
        );
        // A project with nothing linked is left exactly as it is: its refs wait without being
        // touched, so a server that never publishes writes nothing and says so in its status.
        const linked = new Map<string, boolean>();
        for (const row of due) {
          if (this.closed) return;
          if (!linked.has(row.project_id))
            linked.set(
              row.project_id,
              !(
                'blocked' in
                (await this.transport.target(row.project_id).catch(() => ({
                  blocked: 'code_mirror_unavailable',
                })))
              ),
            );
          if (!linked.get(row.project_id)) continue;
          await this.one(row).catch(() => {});
        }
      } finally {
        this.running = undefined;
      }
    })();
    await this.running;
  }

  /** What the project's publication looks like now, and every ref waiting for an operator. */
  async describe(projectId: string): Promise<CodeMirrorStatus> {
    const target = await this.transport.target(projectId);
    const rows = await this.state.read(
      async (sql) =>
        await sql.all<MirrorRow>(
          `SELECT ${columns} FROM code_operations WHERE project_id=? AND status='prepared' AND kind IN ('mirror-work','mirror-accepted','mirror-base') ORDER BY created_at,id LIMIT 200`,
          projectId,
        ),
    );
    const blockedRefs = rows
      .filter((row) => row.phase === 'blocked')
      .map((row) => {
        const detail = this.detail(row);
        return {
          operationId: row.id,
          unitId: row.unit_id,
          ref: (JSON.parse(row.payload_json) as MirrorPayload).ref,
          code: detail.code ?? 'code_mirror_blocked',
          message: detail.message ?? 'This ref was not published',
          at: row.updated_at ?? row.created_at,
        };
      })
      .reverse();
    const waiting = rows.filter((row) => row.phase !== 'blocked');
    const last = rows
      .map((row) => this.detail(row).code)
      .filter((code): code is string => typeof code === 'string');
    return {
      state:
        'blocked' in target
          ? 'off'
          : blockedRefs.length
            ? 'blocked'
            : waiting.some((row) => row.phase === 'retry_wait')
              ? 'retrying'
              : waiting.length
                ? 'pending'
                : 'idle',
      repository: 'blocked' in target ? null : target.repository,
      blockedBy: 'blocked' in target ? target.blocked : null,
      pending: rows.length,
      oldestPendingAt: rows[0]?.created_at ?? null,
      lastError: last.length ? last[last.length - 1] : null,
      blockedRefs,
    };
  }

  /** Put a blocked ref back in the queue. A foreign commit on it is acknowledged, never forced. */
  async retry(caller: Caller, value: unknown): Promise<CodeMirrorStatus> {
    this.assertOpen();
    caller = structuredClone(caller);
    const input = parseCodeInput(codeMirrorRetryInputSchema, value);
    await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'admin', tx);
      check(
        !caller.session,
        'session_forbidden',
        'A leased worker cannot change what the server publishes',
        403,
      );
      const { requestId, ...body } = input;
      const principal = `actor:${caller.actorId}`;
      const previous = await tx.get<{ input_hash: string }>(
        'SELECT input_hash FROM code_operations WHERE project_id=? AND principal_scope=? AND request_id=?',
        caller.projectId,
        principal,
        requestId,
      );
      if (previous) {
        check(
          previous.input_hash === digest(body),
          'request_conflict',
          'This request id was used with different input',
          409,
        );
        return;
      }
      const row = await tx.get<MirrorRow>(
        `SELECT ${columns} FROM code_operations WHERE id=? AND project_id=?`,
        input.operationId,
        caller.projectId,
      );
      check(
        row && kinds.includes(row.kind as MirrorKind) && row.status === 'prepared',
        'code_operation_not_found',
        'No such unfinished mirror operation in this project',
        404,
      );
      check(
        row.phase === 'blocked',
        'code_operation_changed',
        'This mirror operation is not blocked',
        409,
      );
      const detail = this.detail(row);
      // A commit on the published ref that Code did not put there is somebody's work. The
      // operator says they have seen exactly it; the push still only ever fast-forwards.
      check(
        detail.code !== 'code_mirror_diverged' || input.acknowledgeRemote === detail.remote,
        'code_mirror_diverged',
        'The published ref holds a commit Code did not write; name it as acknowledgeRemote once you have kept it somewhere',
        409,
      );
      const at = now();
      await tx.run(
        "UPDATE code_operations SET phase='queued',attempts=0,next_at=?,claim_id=NULL,claim_until=NULL,detail_json=?,updated_at=? WHERE id=? AND status='prepared'",
        at,
        canonical({
          ...detail,
          retriedBy: caller.actorId,
          retriedAt: at,
          ...(input.acknowledgeRemote ? { acknowledged: input.acknowledgeRemote } : {}),
        }),
        at,
        input.operationId,
      );
      await this.warn(
        tx,
        row.project_id,
        null,
        (JSON.parse(row.payload_json) as MirrorPayload).ref,
      );
      await tx.run(
        'INSERT INTO code_operations (id,project_id,principal_scope,request_id,kind,input_hash,payload_json,status,result_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        newId('cop'),
        caller.projectId,
        principal,
        requestId,
        'mirror-retry',
        digest(body),
        canonical(body),
        'completed',
        canonical({ operationId: input.operationId }),
        at,
        at,
      );
    });
    await this.run();
    return await this.describe(caller.projectId);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  private assertOpen(): void {
    check(!this.closed, 'code_unavailable', 'Code is unavailable', 503);
  }

  private detail(row: MirrorRow): Record<string, string | undefined> {
    return JSON.parse(row.detail_json ?? '{}') as Record<string, string | undefined>;
  }

  /** One ref, from claiming it to what its answer leaves on the row. */
  private async one(row: MirrorRow): Promise<void> {
    const payload = JSON.parse(row.payload_json) as MirrorPayload;
    const claim = newId('clm');
    const claimed = await this.state.transaction(async (tx) => {
      const at = new Date();
      const changed = await tx.run(
        "UPDATE code_operations SET phase='running',claim_id=?,claim_until=?,updated_at=? WHERE id=? AND status='prepared' AND (phase IN ('queued','retry_wait') OR (phase='running' AND (claim_until IS NULL OR claim_until<=?)))",
        claim,
        new Date(at.getTime() + this.config.claimSeconds * 1000).toISOString(),
        at.toISOString(),
        row.id,
        at.toISOString(),
      );
      if (changed.changes !== 1) return null;
      if (payload.kind === 'mirror-base') {
        const base = await tx.get<{ health: string }>(
          "SELECT health FROM code_bases WHERE project_id=? AND base_key=? AND state='resolved'",
          row.project_id,
          payload.unitId,
        );
        return base
          ? {
              head_oid: payload.tip,
              mirrored_oid: null,
              quarantine_operation_id: base.health === 'healthy' ? null : row.id,
            }
          : null;
      }
      return await tx.get<{
        head_oid: string | null;
        mirrored_oid: string | null;
        quarantine_operation_id: string | null;
      }>(
        'SELECT head_oid,mirrored_oid,COALESCE(quarantine_base_key,quarantine_operation_id) AS quarantine_operation_id FROM code_units WHERE project_id=? AND unit_id=?',
        row.project_id,
        payload.unitId,
      );
    });
    if (!claimed) return;
    try {
      // A unit whose final capture was refused waits: nothing of it is published while an
      // operator has not decided what becomes of what its machine left.
      if (claimed.quarantine_operation_id !== null)
        return await this.wait(row, claim, {
          code: 'code_capture_quarantined',
          message: 'A capture of this unit is quarantined, so nothing of it is published yet',
        });
      const target =
        payload.kind === 'mirror-work' ? (claimed.head_oid ?? payload.tip) : payload.tip;
      const outcome = await this.publish(row, claim, payload, target, claimed.mirrored_oid);
      if (outcome === 'blocked') return;
      await this.done(row, claim, payload, target, outcome);
    } catch (error) {
      await this.failed(
        row,
        claim,
        error instanceof MervError
          ? { code: error.code, message: error.message }
          : { code: 'code_mirror_failed', message: 'The push could not be made' },
      );
    }
  }

  /**
   * Read the published ref, decide what may be done to it, and do exactly that. An answer
   * that was lost is read again rather than guessed at, and never pushed twice blindly.
   */
  private async publish(
    row: MirrorRow,
    claim: string,
    payload: MirrorPayload,
    target: string,
    mirrored: string | null,
  ): Promise<'ok' | 'blocked' | 'unchanged'> {
    const found = await this.transport.target(row.project_id);
    if ('blocked' in found) {
      await this.wait(row, claim, {
        code: found.blocked,
        message: 'Nothing is published while no repository is linked for it',
      });
      return 'blocked';
    }
    const ref = published(payload.ref);
    for (const attempt of [0, 1]) {
      const remote = await this.transport.lsRemote(row.project_id, ref);
      if (remote === target) return attempt ? 'ok' : 'unchanged';
      const allowed =
        remote === null
          ? true
          : payload.kind === 'mirror-work' && (await this.ancestor(row.project_id, remote, target));
      if (!allowed) {
        await this.blocked(row, claim, {
          code: 'code_mirror_diverged',
          message:
            payload.kind === 'mirror-work'
              ? 'The published branch holds a commit that is not behind what Code has, so no fast-forward can be made'
              : 'The published immutable ref already holds another commit',
          remote: remote ?? '',
          target,
          mirrored: mirrored ?? '',
        });
        return 'blocked';
      }
      const outcome = await this.transport.push(row.project_id, {
        ref,
        oid: target,
        expectedRemote: remote,
      });
      if (outcome === 'ok') return 'ok';
      // Both a refusal and a lost answer are read again: the remote itself says what happened.
      if (attempt)
        throw new MervError(
          'code_mirror_failed',
          outcome === 'rejected'
            ? 'The repository refused the push'
            : 'The push gave no answer that could be read',
          502,
        );
    }
    return 'blocked';
  }

  /** Whether the published commit is behind what Code holds, asked of Code's own repository. */
  private async ancestor(projectId: string, remote: string, target: string): Promise<boolean> {
    const found = await this.repositories.git.run(['merge-base', '--is-ancestor', remote, target], {
      env: this.repositories.environment(projectId),
    });
    return found.code === 0;
  }

  /** The ref is published: record it, and ask again if the unit moved on while this ran. */
  private async done(
    row: MirrorRow,
    claim: string,
    payload: MirrorPayload,
    target: string,
    outcome: 'ok' | 'unchanged',
  ): Promise<void> {
    await this.state.transaction(async (tx) => {
      const at = now();
      const changed = await tx.run(
        "UPDATE code_operations SET status='completed',phase='mirrored',result_json=?,completed_at=?,updated_at=?,claim_id=NULL,claim_until=NULL WHERE id=? AND status='prepared' AND claim_id=?",
        canonical({ ref: published(payload.ref), head: target, pushed: outcome === 'ok' }),
        at,
        at,
        row.id,
        claim,
      );
      if (changed.changes !== 1) return;
      if (payload.kind === 'mirror-work')
        await tx.run(
          'UPDATE code_units SET mirrored_oid=?,mirrored_at=? WHERE project_id=? AND unit_id=?',
          target,
          at,
          row.project_id,
          payload.unitId,
        );
      await this.warn(tx, row.project_id, null, payload.ref);
      const head = await tx.get<{ head_oid: string | null }>(
        'SELECT head_oid FROM code_units WHERE project_id=? AND unit_id=?',
        row.project_id,
        payload.unitId,
      );
      if (payload.kind === 'mirror-work' && head?.head_oid && head.head_oid !== target)
        await enqueueMirror(tx, row.project_id, payload.kind, payload.unitId, head.head_oid);
    });
  }

  /** Nothing is wrong and nothing can be done yet: the ref is looked at again later. */
  private async wait(row: MirrorRow, claim: string, detail: Record<string, string>): Promise<void> {
    const at = now();
    await this.state.transaction(async (tx) => {
      await tx.run(
        "UPDATE code_operations SET phase='retry_wait',next_at=?,detail_json=?,updated_at=?,claim_id=NULL,claim_until=NULL WHERE id=? AND status='prepared' AND claim_id=?",
        new Date(Date.now() + this.config.backoffMs).toISOString(),
        canonical({ ...detail, at }),
        at,
        row.id,
        claim,
      );
    });
  }

  /** A push that failed: it is tried again, and after enough tries it waits for an operator. */
  private async failed(
    row: MirrorRow,
    claim: string,
    detail: Record<string, string>,
  ): Promise<void> {
    const attempts = Number(row.attempts) + 1;
    if (attempts >= this.config.maxAttempts)
      return await this.blocked(row, claim, detail, attempts);
    const at = now();
    await this.state.transaction(async (tx) => {
      await tx.run(
        "UPDATE code_operations SET phase='retry_wait',attempts=?,next_at=?,detail_json=?,updated_at=?,claim_id=NULL,claim_until=NULL WHERE id=? AND status='prepared' AND claim_id=?",
        attempts,
        new Date(
          Date.now() + Math.min(MAX_BACKOFF_MS, this.config.backoffMs * 2 ** (attempts - 1)),
        ).toISOString(),
        canonical({ ...detail, at }),
        at,
        row.id,
        claim,
      );
    });
  }

  /** The ref waits for an operator. The work itself is untouched and goes on. */
  private async blocked(
    row: MirrorRow,
    claim: string,
    detail: Record<string, string>,
    attempts = Number(row.attempts),
  ): Promise<void> {
    const payload = JSON.parse(row.payload_json) as MirrorPayload;
    const at = now();
    await this.state.transaction(async (tx) => {
      const changed = await tx.run(
        "UPDATE code_operations SET phase='blocked',attempts=?,next_at=NULL,detail_json=?,updated_at=?,claim_id=NULL,claim_until=NULL WHERE id=? AND status='prepared' AND claim_id=?",
        attempts,
        canonical({ ...detail, at }),
        at,
        row.id,
        claim,
      );
      if (changed.changes !== 1) return;
      await this.warn(
        tx,
        row.project_id,
        { code: detail.code, message: detail.message, at },
        payload.ref,
      );
      await this.state.appendEvent(tx, {
        projectId: row.project_id,
        actorId: 'system:code',
        type: 'code.mirror_blocked',
        subjectId: payload.unitId,
        data: {
          operationId: row.id,
          unitId: payload.unitId,
          ref: published(payload.ref),
          code: detail.code,
          ...(detail.remote ? { remote: detail.remote } : {}),
        },
      });
    });
  }

  /** One warning per ref on the project, newest last; a ref that came right loses its own. */
  private async warn(
    tx: Transaction,
    projectId: string,
    warning: { code: string; message: string; at: string } | null,
    ref: string,
  ): Promise<void> {
    await warnRef(tx, projectId, warning, published(ref));
  }
}

/**
 * One warning per ref on the project, newest last; a ref that came right loses its own.
 * `warnings_json` is the one mutable column of the binding row, and it is already what a
 * reader looks at, so trouble that stops nothing needs no storage of its own.
 */
export async function warnRef(
  tx: Transaction,
  projectId: string,
  warning: { code: string; message: string; at: string } | null,
  ref: string,
): Promise<void> {
  const row = await tx.get<{ warnings_json: string }>(
    'SELECT warnings_json FROM code_projects WHERE project_id=?',
    projectId,
  );
  if (!row) return;
  const kept = (JSON.parse(row.warnings_json) as CodeStoreWarning[]).filter(
    (item) => item.ref !== ref,
  );
  const next = warning ? [...kept, { ...warning, ref }] : kept;
  await tx.run(
    'UPDATE code_projects SET warnings_json=?,updated_at=? WHERE project_id=?',
    canonical(next.slice(-WARNINGS)),
    now(),
    projectId,
  );
}

/** What a project's work is published to, and the App credential for it, both server-side. */
export interface MirrorAuthority {
  target(projectId: string): Promise<{ id: number; fullName: string } | { blocked: string }>;
  /** Runs the one Git child with a credential minted for it and given up again after it. */
  token<T>(projectId: string, use: (token: string) => Promise<T>): Promise<T>;
}

/**
 * The real transport: `git push` from the project's own repository. The credential exists only
 * in the environment of that one child, never in an argument, a configuration file or on disk,
 * and no machine is ever lent it. Only https is allowed, and only the ref Code names is touched.
 */
export class GitMirrorTransport implements MirrorTransport {
  constructor(
    private readonly repositories: CodeRepositories,
    private readonly authority: MirrorAuthority,
    private readonly timeoutMs = 120_000,
  ) {}

  async target(projectId: string): Promise<MirrorTarget> {
    const found = await this.authority.target(projectId);
    return 'blocked' in found ? found : { repository: found.fullName };
  }

  async lsRemote(projectId: string, ref: string): Promise<string | null> {
    const found = await this.authority.target(projectId);
    if ('blocked' in found)
      throw new MervError('code_mirror_unavailable', 'Nothing is linked to publish to', 503);
    const result = await this.authority.token(
      projectId,
      async (token) =>
        await this.repositories.git.run(
          ['ls-remote', '--exit-code', this.url(found.fullName), ref],
          {
            env: { ...this.repositories.environment(projectId), ...header(token) },
            protocol: 'https',
            timeoutMs: this.timeoutMs,
          },
        ),
    );
    // Two is the repository answering that it has no such ref; anything else it could not say.
    if (result.code === 2) return null;
    if (result.code !== 0)
      throw new MervError(
        'code_mirror_failed',
        `The repository could not be read: ${result.stderr.split('\n')[0] ?? ''}`.trim(),
        502,
      );
    const line = result.stdout
      .toString('utf8')
      .split('\n')
      .find((value) => value.trim().endsWith(ref));
    return line ? (/^([0-9a-f]{40,64})\b/.exec(line.trim())?.[1] ?? null) : null;
  }

  async push(projectId: string, update: MirrorUpdate): Promise<MirrorOutcome> {
    const found = await this.authority.target(projectId);
    if ('blocked' in found)
      throw new MervError('code_mirror_unavailable', 'Nothing is linked to publish to', 503);
    return await this.authority.token(projectId, async (token) => {
      const result = await this.repositories.git.run(
        [
          'push',
          '--porcelain',
          `--force-with-lease=${update.ref}:${update.expectedRemote ?? ''}`,
          this.url(found.fullName),
          `${update.oid}:${update.ref}`,
        ],
        {
          env: { ...this.repositories.environment(projectId), ...header(token) },
          protocol: 'https',
          timeoutMs: this.timeoutMs,
        },
      );
      if (result.code === 0) return 'ok';
      // A refusal names the ref; anything else is an answer that could not be read.
      return result.stdout.toString('utf8').includes(`!\t`) || /\[rejected\]/.test(result.stderr)
        ? 'rejected'
        : 'unknown';
    });
  }

  private url(fullName: string): string {
    return `https://github.com/${fullName}.git`;
  }
}
/** The credential of one Git child: an environment entry, and nowhere else. */
const header = (token: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
});
