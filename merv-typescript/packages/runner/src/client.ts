import { nativeMcpConnectionsSchema } from '@merv/contracts';
import type { NativeMcpConnection } from '@merv/sessions/types';
import { z } from 'zod';
import {
  canonical,
  sessionWorkspaceSchema as workspaceSchema,
  codeCommitCommandSchema,
  codeCommandRecordSchema,
  type CodeCommitCommand,
  type CodeCommandCompletion,
  type CodeCommandRecord,
  type WorkspaceTransport,
} from '@merv/contracts';
import type {
  AutomaticLease,
  RunnerHeartbeat,
  RunnerPresence,
  Session,
  SessionDeferral,
  SessionReleaseOutcome,
  SessionTranscript,
  SessionTranscriptDeclaration,
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
  // Recorded once, never replayed. A 404 is final because a server answers 503, never 404,
  // while a route's owning plugin is unmounted; a 401 loops only while presence authenticates.
  get final() {
    const retried = [401, 408, 429].includes(this.status) || retriedCodes.includes(this.code);
    return this.status >= 400 && this.status < 500 && !retried;
  }
}
/** Retried whatever their status. */
const retriedCodes = ['transaction_conflict', 'invalid_control_response'];

const label = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !/[\0\r\n]/.test(value));
// Replies ignore fields a server adds (`runner.1`). Tuned values are validated again as a
// profile before use; only the list's own bounds are checked here.
const settingsSchema = z.object({
  platforms: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
        enabled: z.boolean(),
        model: z.string().optional(),
        effort: z.string().optional(),
        parallelism: z.number().int().min(1).max(32),
      }),
    )
    .max(32)
    .refine((items) => new Set(items.map((item) => item.name)).size === items.length),
});
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
      .optional(),
  })
  .passthrough();
const leaseSchema = z.object({ session: z.union([z.null(), sessionSchema]), reason: label });
const transcriptSchema = z.object({
  transcript: z
    .object({
      sessionId: z.string(),
      sha256: z.string(),
      size: z.number(),
      uploadedAt: z.string().nullable(),
      upload: z
        .object({ url: z.string().url(), headers: z.record(z.string()), expiresAt: z.string() })
        .optional(),
    })
    .passthrough(),
});
/** Where a bearer or transcript may go: https, or plain http to this machine only. */
const secureUrl = (url: URL) =>
  url.protocol === 'https:' ||
  (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));

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
      !secureUrl(url)
    )
      throw new RunnerControlError('invalid_runner_url', 400);
    this.baseUrl = url.origin;
  }
  /**
   * `bytes` sends one part instead of JSON; `octets` expects bytes back. Both belong to the
   * bundle routes, whose bodies are larger and slower than any control call.
   */
  private readonly launchConnectionHosts = new Map<string, string>();
  supportsLaunchConnections(id: string, hostRef: string): boolean {
    return this.launchConnectionHosts.get(id) === hostRef;
  }
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
      if (
        response.status === 404 &&
        code === 'not_found' &&
        value?.error?.message === 'Unknown endpoint' &&
        path.endsWith('/launch-connections')
      )
        throw new RunnerControlError('unknown_launch_connections_route', 404);
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
    const result = presenceSchema.safeParse(
      (await this.request('/sessions/runners/heartbeat', input))?.runner,
    );
    if (!result.success || result.data.runnerId !== input.runnerId)
      throw new RunnerControlError('invalid_control_response', 0);
    return result.data as unknown as RunnerPresence;
  }
  async lease(input: AutomaticLease): Promise<{ session: Session | null; reason: string }> {
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
    const reply = await this.request(`/sessions/${encodeURIComponent(id)}/attach`, {
      runnerId,
      hostRef,
      ...(workspace ? { workspace } : {}),
    });
    const session = this.session(reply?.session, {
      id,
      runnerId,
      hostRef,
      statuses: ['offered', 'active'],
    });
    if (workspace) {
      const actual = workspaceSchema.safeParse(session.workspace?.attachment);
      if (
        !actual.success ||
        !expected.success ||
        JSON.stringify(actual.data) !== JSON.stringify(expected.data)
      )
        throw new RunnerControlError('invalid_control_response', 0);
    }
    if (reply?.launchConnections === true) this.launchConnectionHosts.set(id, hostRef);
    else this.launchConnectionHosts.delete(id);
    return session;
  }
  /** New runners do not probe this route on older servers: attach advertises support. */
  async launchConnections(
    id: string,
    runnerId: string,
    hostRef: string,
  ): Promise<NativeMcpConnection[]> {
    let value: unknown;
    try {
      value = await this.request(`/sessions/${encodeURIComponent(id)}/launch-connections`, {
        runnerId,
        hostRef,
      });
    } catch (error) {
      if (
        error instanceof RunnerControlError &&
        error.status === 404 &&
        error.code === 'unknown_launch_connections_route'
      )
        return [];
      throw error;
    }
    const parsed = z.object({ connections: nativeMcpConnectionsSchema }).strict().safeParse(value);
    if (!parsed.success) throw new RunnerControlError('invalid_control_response', 0);
    return parsed.data.connections;
  }
  /** Private response remains in memory and never enters the durable launch record. */
  async huggingfaceAccess(
    id: string,
    runnerId: string,
    hostRef: string,
  ): Promise<{ token: string; endpoint: string } | null> {
    const value = await this.request(`/sessions/${encodeURIComponent(id)}/huggingface-access`, {
      runnerId,
      hostRef,
    });
    const parsed = z
      .object({
        access: z
          .object({
            token: z
              .string()
              .min(1)
              .max(4096)
              .regex(/^[A-Za-z0-9_.-]+$/),
            endpoint: z
              .string()
              .url()
              .refine((value) => {
                const url = new URL(value);
                return (
                  url.protocol === 'https:' &&
                  !url.port &&
                  /^[a-z0-9.-]+$/.test(url.hostname) &&
                  value === `https://${url.hostname}/hf` &&
                  url.pathname === '/hf' &&
                  !url.search &&
                  !url.hash &&
                  !url.username &&
                  !url.password
                );
              }),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .safeParse(value);
    if (!parsed.success) throw new RunnerControlError('invalid_control_response', 0);
    return parsed.data.access;
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
  async nextCodeCommand(
    session: Pick<
      Session,
      'id' | 'runnerId' | 'actorId' | 'instanceId' | 'expectedRevision' | 'workspace'
    >,
    hostRef: string,
  ): Promise<CodeCommitCommand | null> {
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
  /**
   * Close the session, or, once it is closed, report what it used. With no `outcome` a live
   * session closes as `released`, which counts against nothing. `deferral` goes only with a
   * deferred preparation: why the checkout was put off.
   */
  async release(
    id: string,
    runnerId: string,
    input: {
      outcome?: SessionReleaseOutcome;
      reason?: string;
      usage?: SessionUsageReport;
      deferral?: SessionDeferral;
    },
  ): Promise<Session> {
    const body = { runnerId, ...input }; // JSON leaves out what is undefined
    return this.session(
      (await this.request(`/sessions/${encodeURIComponent(id)}/release`, body))?.session,
      { id, runnerId, statuses: ['released', 'expired'] },
    );
  }
  /** Declare the launch's transcript, or with `deliver` confirm it stored or get its PUT. */
  async transcript(
    id: string,
    runnerId: string,
    input: SessionTranscriptDeclaration,
  ): Promise<SessionTranscript> {
    const t = transcriptSchema.safeParse(
      await this.request(`/sessions/${encodeURIComponent(id)}/transcript`, { runnerId, ...input }),
    ).data?.transcript;
    // It names this session and file; a delivery not yet stored carries a PUT to https or loopback.
    if (
      !t ||
      t.sessionId !== id ||
      t.sha256 !== input.sha256 ||
      (input.deliver && !t.uploadedAt && !(t.upload && secureUrl(new URL(t.upload.url))))
    )
      throw new RunnerControlError('invalid_control_response', 0);
    return t;
  }
  /** The store's signed PUT: its own headers and the bytes, never a Merv bearer. 412 is stored. */
  async putSigned(
    upload: { url: string; headers: Record<string, string> },
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetcher(upload.url, {
        method: 'PUT',
        headers: upload.headers,
        body: bytes as Uint8Array<ArrayBuffer>,
        redirect: 'error',
        credentials: 'omit',
        signal,
      });
      await response.body?.cancel();
    } catch {
      throw new RunnerControlError('transcript_upload_failed', 0);
    }
    if (!response.ok && response.status !== 412)
      throw new RunnerControlError('transcript_upload_failed', 0);
  }
}
