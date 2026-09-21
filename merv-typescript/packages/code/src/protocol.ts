import {
  check,
  codeDownloadBeginSchema,
  codeDownloadReadSchema,
  codeUploadBeginSchema,
  codeUploadFinalizeSchema,
  codeWorkspaceManifestInputSchema,
  effectiveWorkspace,
  MervError,
  type Caller,
  type CodeWorkspaceManifest,
  type State,
} from '@merv/contracts';
import type { Session, Sessions } from '@merv/sessions/types';
import { parseCodeInput } from './input.js';
import type { CodeStore } from './store/operations.js';
import { workBranch } from './store/refs.js';
import { CODE_DRIVER } from './units.js';
import type { CodeWriterService } from './writers.js';

/**
 * The second workspace protocol, as machines speak it. The API forwards a route and an opaque
 * body; everything is decided here. A machine proves a session is its own the way it does for
 * commands: Sessions only hands a session to the source that leased it, and the runner and
 * launch it names must be the ones the session records.
 */
export class CodeWorkspaceProtocol {
  constructor(
    private readonly state: State,
    private readonly sessions: Sessions,
    private readonly writers: CodeWriterService,
    private readonly store: CodeStore,
  ) {}

  async call(caller: Caller, route: string, body: unknown): Promise<unknown> {
    caller = structuredClone(caller);
    check(!caller.session, 'session_forbidden', 'A leased worker cannot move bundles', 403);
    if (route === 'workspace')
      return await this.manifest(caller, parseCodeInput(codeWorkspaceManifestInputSchema, body));
    if (route === 'uploads') {
      const input = parseCodeInput(codeUploadBeginSchema, body);
      const session = await this.controlled(caller, input, 'refused');
      check(
        ['offered', 'active'].includes(session.status),
        'session_closed',
        'Only the final capture is taken after a session ended',
        409,
      );
      const command = await this.state.read(
        async (sql) =>
          await sql.get<{ status: string }>(
            'SELECT status FROM code_commands WHERE id=? AND project_id=? AND session_id=?',
            input.commandId,
            caller.projectId,
            session.id,
          ),
      );
      check(
        command?.status === 'dispatched',
        'code_command_not_found',
        'An upload delivers a commit command this session was handed',
        404,
      );
      return { operation: await this.store.beginUpload(caller, input) };
    }
    if (route === 'finalize') {
      const input = parseCodeInput(codeUploadFinalizeSchema, body);
      // Deliberately indifferent to whether the session is live: this is the one thing a
      // machine still owes after its session closed, and it may owe it exactly once. A
      // session that never attached has no launch to compare; its final can move nothing.
      const session = await this.controlled(caller, input, 'any');
      check(
        session.hostRef !== null || input.bundle === null,
        'session_forbidden',
        'A session that never attached has nothing to hand over',
        403,
      );
      return { operation: await this.store.beginUpload(caller, input) };
    }
    if (route === 'downloads') {
      const input = parseCodeInput(codeDownloadBeginSchema, body);
      const manifest = await this.manifest(caller, input);
      return {
        download: await this.store.export(caller, {
          sessionId: input.sessionId,
          head: manifest.head,
          haves: input.haves,
        }),
      };
    }
    const operation = /^uploads\/([A-Za-z0-9_]{1,80})(\/complete)?$/.exec(route);
    if (!operation) throw new MervError('not_found', 'Unknown Code route', 404);
    return {
      operation: operation[2]
        ? await this.store.complete(caller, operation[1])
        : await this.store.operation(caller, operation[1]),
    };
  }

  async putPart(caller: Caller, operationId: string, offset: number, bytes: Buffer) {
    return await this.store.putPart(caller, operationId, offset, bytes);
  }

  async readPart(caller: Caller, exportId: string, value: unknown): Promise<Buffer> {
    caller = structuredClone(caller);
    check(!caller.session, 'session_forbidden', 'A leased worker cannot move bundles', 403);
    const input = parseCodeInput(codeDownloadReadSchema, value);
    await this.controlled(caller, input, 'offered');
    return await this.store.readExport(caller, exportId, input);
  }

  private async controlled(
    caller: Caller,
    input: { sessionId: string; runnerId: string; hostRef?: string },
    unattached: 'refused' | 'offered' | 'any',
  ): Promise<Session> {
    const session = await this.sessions.get(caller, input.sessionId);
    check(
      session.runnerId === input.runnerId &&
        (session.hostRef === input.hostRef ||
          (session.hostRef === null &&
            (unattached === 'any' || (unattached === 'offered' && session.status === 'offered')))),
      'session_forbidden',
      'This session belongs to another runner or launch',
      403,
    );
    return session;
  }

  /**
   * What a machine must prepare for a session: exactly the newest commit Code admitted for a
   * writer, exactly the referenced commit for a reader. It only reads, so it may be asked any
   * number of times, and a machine that then fails to prepare leaves nothing to clean up.
   */
  private async manifest(
    caller: Caller,
    input: { sessionId: string; runnerId: string; hostRef?: string },
  ): Promise<CodeWorkspaceManifest> {
    const session = await this.controlled(caller, input, 'offered');
    check(
      ['offered', 'active'].includes(session.status),
      'session_closed',
      'The assignment is closed',
      409,
    );
    const policy = session.execution.policy;
    const workspace = effectiveWorkspace(policy);
    check(
      workspace.mode !== 'none' && workspace.driver === CODE_DRIVER,
      'code_workspace_required',
      'This assignment does not use a workspace from Code’s repository',
      409,
    );
    const project = await this.state.read(
      async (sql) =>
        await sql.get<{ repository_id: string; store_json: string | null }>(
          'SELECT repository_id,store_json FROM code_projects WHERE project_id=?',
          caller.projectId,
        ),
    );
    check(
      project?.store_json,
      'code_base_pending',
      'This project’s repository has not been imported into Code',
      409,
    );
    const shared = {
      projectRef: caller.projectId,
      repositoryId: project.repository_id,
      objectFormat: (JSON.parse(project.store_json) as { objectFormat: 'sha1' | 'sha256' })
        .objectFormat,
      unitId: session.instanceId,
    };
    let manifest: CodeWorkspaceManifest;
    if (policy.readOnly) {
      const name = workspace.base.startsWith('reference:')
        ? workspace.base.slice('reference:'.length)
        : '';
      const head = session.execution.references[name];
      check(
        typeof head === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head),
        'code_workspace_required',
        'A read-only checkout from Code’s repository names the commit it reads',
        409,
      );
      manifest = {
        ...shared,
        generation: null,
        mode: 'read',
        head,
        base: head,
        branch: null,
        prerequisites: [],
      };
    } else {
      const unit = await this.state.read((sql) =>
        this.writers.row(sql, caller.projectId, session.instanceId),
      );
      check(
        unit?.base_json && unit.writer_session_id === session.id,
        'code_generation_stale',
        'Another writer generation owns this unit now',
        409,
      );
      check(
        ['reserved', 'active'].includes(unit.writer_state),
        'code_writer_closed',
        'This writer generation has closed',
        409,
      );
      const base = this.writers.base(unit);
      manifest = {
        ...shared,
        generation: Number(unit.generation),
        mode: 'write',
        head: unit.head_oid ?? base,
        base,
        branch: workBranch(session.instanceId),
        prerequisites: [],
      };
    }
    check(
      await this.store.contains(caller.projectId, manifest.head),
      'code_base_pending',
      'Code’s repository does not hold the commit this checkout starts from',
      409,
    );
    return manifest;
  }
}
