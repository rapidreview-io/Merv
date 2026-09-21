import { z } from 'zod';
import {
  canonical,
  sessionWorkspaceSchema as workspaceSchema,
  codeCommitCommandSchema,
  codeCommandRecordSchema,
  type CodeCommitCommand,
  type CodeCommandCompletion,
  type CodeCommandRecord,
  codeTransportGrantSchema,
  type CodeTransportInput,
  type CodeTransportGrant,
  type WorkspaceTransport,
} from '@merv/contracts';
import type {
  AutomaticLease,
  RunnerHeartbeat,
  RunnerPresence,
  Session,
  SessionDeferral,
  SessionReleaseOutcome,
  SessionUsageReport,
  SessionWorkspace,
} from '@merv/sessions/types';

/** Codes are safe diagnostics. Response bodies and bearer values never become error messages. */
export class RunnerControlError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'RunnerControlError';
  }
  get unavailable() {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

const label = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !/[\0\r\n]/.test(value));
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
const settingsSchema = z
  .object({
    platforms: z
      .array(
        z
          .object({
            name,
            enabled: z.boolean(),
            model: label.optional(),
            effort: label.optional(),
            parallelism: z.number().int().min(1).max(32),
          })
          .strict(),
      )
      .max(32)
      .refine((items) => new Set(items.map((item) => item.name)).size === items.length),
  })
  .strict();
const presenceSchema = z
  .object({
    runnerId: label,
    desiredVersion: z.number().int().nonnegative().safe(),
    desiredSettings: settingsSchema,
  })
  .passthrough();
const sessionSchema = z
  .object({
    id: z.string().regex(/^session_[A-Za-z0-9_-]+$/),
    projectId: label,
    agentId: label.optional(),
    agentSessionId: label.optional(),
    instanceId: label,
    runnerId: label,
    hostRef: z.string().min(1).max(1024).nullable(),
    expectedRevision: z.number().int().nonnegative().safe(),
    status: z.enum(['offered', 'active', 'released', 'expired']),
    expiresAt: z.string().datetime(),
    hardDeadline: z.string().datetime(),
    assignment: z.object({ label: z.string(), brief: z.string() }).passthrough(),
    execution: z
      .object({
        policy: z.object({ readOnly: z.boolean(), tools: z.array(z.unknown()) }).passthrough(),
      })
      .passthrough(),
    workspace: z
      .object({ attachment: workspaceSchema, result: workspaceSchema.nullable() })
      .strict()
      .optional(),
  })
  .passthrough();
const leaseSchema = z
  .object({ session: z.union([z.null(), sessionSchema]), reason: label })
  .strict();

export class RunnerClient {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly projectId: string,
    private readonly bearer: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new RunnerControlError('invalid_runner_url', 400);
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      )
    )
      throw new RunnerControlError('invalid_runner_url', 400);
    this.baseUrl = url.origin;
  }
  /**
   * `bytes` sends one part instead of JSON; `octets` expects bytes back. Both belong to the
   * bundle routes, whose bodies are larger and slower than any control call.
   */
  private async request(
    path: string,
    body?: unknown,
    transfer?: { bytes?: Uint8Array; octets?: boolean },
  ): Promise<any> {
    let response: Response;
    const signal = AbortSignal.timeout(
      transfer ? Math.max(this.timeoutMs, 30_000) : this.timeoutMs,
    );
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: transfer?.bytes ? 'PUT' : body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.bearer}`,
          'x-merv-project-id': this.projectId,
          ...(transfer?.bytes
            ? { 'content-type': 'application/octet-stream' }
            : body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
        },
        ...(transfer?.bytes
          ? { body: new Blob([transfer.bytes as Uint8Array<ArrayBuffer>]) }
          : body === undefined
            ? {}
            : { body: JSON.stringify(body) }),
        redirect: 'error',
        credentials: 'omit',
        signal,
      });
    } catch {
      throw new RunnerControlError('control_unavailable', 0);
    }
    let raw = '';
    try {
      if (!response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      // Sessions admits four frozen packets of up to 512 KiB each. The complete
      // reply also carries session metadata and workspace receipts.
      const limit = response.ok
        ? transfer?.octets
          ? 4 * 1024 * 1024 + 65_536
          : 4 * 1024 * 1024
        : 1024 * 1024;
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > limit) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(next.value);
        }
        if (response.ok && transfer?.octets) return Buffer.concat(chunks);
        raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(chunks),
        );
      } finally {
        reader.releaseLock();
      }
    } catch {
      throw new RunnerControlError(
        'invalid_control_response',
        [401, 403].includes(response.status) ? response.status : 0,
      );
    }
    let value: any;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new RunnerControlError(
        'invalid_control_response',
        [401, 403].includes(response.status) ? response.status : 0,
      );
    }
    if (!response.ok) {
      const code =
        typeof value?.error?.code === 'string' &&
        /^[a-zA-Z0-9_]{1,100}$/.test(value.error.code) &&
        !value.error.code.includes(this.bearer) &&
        !/^m[sk]_/.test(value.error.code)
          ? value.error.code
          : 'control_request_failed';
      throw new RunnerControlError(code, response.status);
    }
    return value;
  }
  /**
   * The bundle routes as a workspace driver uses them. The bodies are the driver's and the
   * server plugin's own business: this client authenticates, bounds and forwards them.
   */
  workspaceTransport(): WorkspaceTransport {
    const route = (value: string) => value.split('/').map(encodeURIComponent).join('/');
    return {
      call: async (path, body) => await this.request(`/code/v2/${route(path)}`, body, {}),
      putPart: async (operationId, offset, bytes) =>
        await this.request(
          `/code/v2/uploads/${encodeURIComponent(operationId)}/parts/${offset}`,
          undefined,
          { bytes },
        ),
      readPart: async (exportId, input) =>
        (await this.request(`/code/v2/downloads/${encodeURIComponent(exportId)}/read`, input, {
          octets: true,
        })) as Uint8Array,
    };
  }
  private session(
    value: unknown,
    expected: { id?: string; runnerId: string; hostRef?: string; statuses?: Session['status'][] },
  ): Session {
    const result = sessionSchema.safeParse(value);
    if (
      !result.success ||
      result.data.projectId !== this.projectId ||
      result.data.runnerId !== expected.runnerId ||
      (expected.id !== undefined && result.data.id !== expected.id) ||
      (expected.hostRef !== undefined && result.data.hostRef !== expected.hostRef) ||
      (expected.statuses !== undefined && !expected.statuses.includes(result.data.status))
    )
      throw new RunnerControlError('invalid_control_response', 0);
    return result.data as unknown as Session;
  }
  async presence(input: RunnerHeartbeat): Promise<RunnerPresence> {
    input = { ...input };
    const result = presenceSchema.safeParse(
      (await this.request('/sessions/runners/heartbeat', input))?.runner,
    );
    if (!result.success || result.data.runnerId !== input.runnerId)
      throw new RunnerControlError('invalid_control_response', 0);
    return result.data as unknown as RunnerPresence;
  }
  async lease(input: AutomaticLease): Promise<{ session: Session | null; reason: string }> {
    input = { ...input };
    const result = leaseSchema.safeParse(await this.request('/sessions/lease', input));
    if (!result.success) throw new RunnerControlError('invalid_control_response', 0);
    const value = result.data;
    return {
      session:
        value.session === null ? null : this.session(value.session, { runnerId: input.runnerId }),
      reason: value.reason,
    };
  }
  async get(id: string, runnerId: string): Promise<Session> {
    return this.session((await this.request(`/sessions/${encodeURIComponent(id)}`))?.session, {
      id,
      runnerId,
    });
  }
  async attach(
    id: string,
    runnerId: string,
    hostRef: string,
    workspace?: SessionWorkspace,
  ): Promise<Session> {
    const expected = workspaceSchema.safeParse(workspace);
    const session = this.session(
      (
        await this.request(`/sessions/${encodeURIComponent(id)}/attach`, {
          runnerId,
          hostRef,
          ...(workspace ? { workspace } : {}),
        })
      )?.session,
      { id, runnerId, hostRef, statuses: ['offered', 'active'] },
    );
    if (workspace) {
      const actual = workspaceSchema.safeParse(session.workspace?.attachment);
      if (
        !actual.success ||
        !expected.success ||
        JSON.stringify(actual.data) !== JSON.stringify(expected.data)
      )
        throw new RunnerControlError('invalid_control_response', 0);
    }
    return session;
  }
  async workspaceResult(
    id: string,
    runnerId: string,
    hostRef: string,
    workspace: SessionWorkspace,
  ): Promise<Session> {
    const expected = workspaceSchema.safeParse(workspace);
    const session = this.session(
      (
        await this.request(`/sessions/${encodeURIComponent(id)}/workspace-result`, {
          runnerId,
          hostRef,
          workspace,
        })
      )?.session,
      { id, runnerId, hostRef },
    );
    const actual = workspaceSchema.safeParse(session.workspace?.result);
    if (
      !actual.success ||
      !expected.success ||
      JSON.stringify(actual.data) !== JSON.stringify(expected.data)
    )
      throw new RunnerControlError('invalid_control_response', 0);
    return session;
  }
  async heartbeat(id: string, runnerId: string): Promise<Session> {
    return this.session(
      (await this.request(`/sessions/${encodeURIComponent(id)}/heartbeat`, { runnerId }))?.session,
      { id, runnerId, statuses: ['active'] },
    );
  }
  async nextCodeCommand(session: Session, hostRef: string): Promise<CodeCommitCommand | null> {
    session = structuredClone(session);
    const value = await this.request('/code/commands/next', {
      sessionId: session.id,
      runnerId: session.runnerId,
      hostRef,
    });
    if (value?.command === null) return null;
    const parsed = codeCommitCommandSchema.safeParse(value?.command);
    if (!parsed.success) throw new RunnerControlError('invalid_control_response', 0);
    const command = parsed.data;
    if (
      command.projectId !== this.projectId ||
      command.sessionId !== session.id ||
      command.actorId !== session.actorId ||
      command.instanceId !== session.instanceId ||
      command.expectedRevision !== session.expectedRevision ||
      command.runnerId !== session.runnerId ||
      command.hostRef !== hostRef ||
      canonical(command.workspace) !== canonical(session.workspace?.attachment)
    )
      throw new RunnerControlError('invalid_control_response', 0);
    return command;
  }
  async completeCodeCommand(
    command: CodeCommitCommand,
    outcome: { receipt: NonNullable<CodeCommandRecord['receipt']> } | { error: string },
  ): Promise<CodeCommandRecord> {
    ({ command, outcome } = structuredClone({ command, outcome }));
    const input: CodeCommandCompletion = {
      sessionId: command.sessionId,
      runnerId: command.runnerId,
      hostRef: command.hostRef,
      commandId: command.id,
      ...outcome,
    };
    const parsed = codeCommandRecordSchema.safeParse(
      (await this.request('/code/commands/complete', input))?.operation,
    );
    if (
      !parsed.success ||
      canonical(parsed.data.command) !== canonical(command) ||
      ('receipt' in outcome
        ? parsed.data.status !== 'succeeded' ||
          canonical(parsed.data.receipt) !== canonical(outcome.receipt)
        : parsed.data.status !== 'failed' || parsed.data.error !== outcome.error)
    )
      throw new RunnerControlError('invalid_control_response', 0);
    return parsed.data;
  }
  async release(
    id: string,
    runnerId: string,
    outcome: SessionReleaseOutcome,
    reason: string,
    usage?: SessionUsageReport,
    /** Named with a deferred preparation, and only then: why the checkout was put off. */
    deferral?: SessionDeferral,
  ): Promise<Session> {
    return this.session(
      (
        await this.request(`/sessions/${encodeURIComponent(id)}/release`, {
          runnerId,
          outcome,
          reason,
          ...(deferral ? { deferral } : {}),
          ...(usage ? { usage } : {}),
        })
      )?.session,
      { id, runnerId, statuses: ['released', 'expired'] },
    );
  }
  /**
   * A session its own handoff closed has nothing left to release, yet that is the session
   * with usage worth reporting. The release route accepts the report alone and changes
   * nothing else about a session that has already ended.
   */
  async reportUsage(id: string, runnerId: string, usage: SessionUsageReport): Promise<Session> {
    return this.session(
      (await this.request(`/sessions/${encodeURIComponent(id)}/release`, { runnerId, usage }))
        ?.session,
      { id, runnerId, statuses: ['released', 'expired'] },
    );
  }
  async transportGrant(input: CodeTransportInput): Promise<CodeTransportGrant> {
    input = structuredClone(input);
    const parsed = codeTransportGrantSchema.safeParse(
      await this.request('/code/transport/grant', input),
    );
    if (
      !parsed.success ||
      parsed.data.repository.split('/').some((p) => p === '.' || p === '..') ||
      (input.operation === 'fetch'
        ? parsed.data.target !== null
        : parsed.data.target?.headOid !==
          (input.operation === 'checkpoint' ? input.receipt.headOid : input.workspace.headOid))
    )
      throw new RunnerControlError('invalid_control_response', 0);
    return parsed.data;
  }
  async verifyTransport(input: CodeTransportInput): Promise<void> {
    if ((await this.request('/code/transport/verify', input))?.verified !== true)
      throw new RunnerControlError('invalid_control_response', 0);
  }
  async revokeGrant(grant: CodeTransportGrant): Promise<void> {
    // Revoke this short-lived, one-repository token even when Git failed. Expiry bounds a failed revocation.
    try {
      const response = await this.fetcher('https://api.github.com/installation/token', {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${grant.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2026-03-10',
        },
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
    } catch {
      /* Never log a secret or obscure the result of the fixed Git operation. */
    }
  }
  async syncPublications(): Promise<void> {
    await this.request('/code/publications/sync', {});
  }
}
