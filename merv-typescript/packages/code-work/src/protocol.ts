import { z } from 'zod';
import {
  check,
  NATIVE_CODE_DRIVER as CODE_DRIVER,
  effectiveWorkspace,
  MervError,
  type Caller,
  type State,
  oidPattern,
} from '@merv/contracts';
import { idSchema as id } from '@merv/contracts/schemas';
import { codePushFenceSchema, type CodeWorkspaceManifest } from '@merv/code/store/protocol';
import { live, ownEnd } from '@merv/sessions/rules';
import type { Session, Sessions } from '@merv/sessions/types';
import { pendingMerge } from '@merv/code/pending-merge';
import { parseCodeInput } from '@merv/code/input';
import type { CodeStore } from '@merv/code/store/operations';
import { workBranch } from '@merv/code/store/refs';
import type { CodeWriterService } from '@merv/code/writers';
import type { CodeGitRemote } from '@merv/code/store/http';
import type { CodeSubmissionService } from './submissions.js';

/** The session a machine names as its own. */
const codeWorkspaceManifestInputSchema = z.strictObject({
  sessionId: id,
  runnerId: id,
  hostRef: id.optional(),
});

/**
 * Workspace control metadata alongside ordinary Git transport. The API forwards a route and an opaque
 * body; everything is decided here. A machine proves a session is its own the way it does for
 * session control: Sessions only hands a session to the source that leased it, and the runner and
 * launch it names must be the ones the session records.
 */
export class CodeWorkspaceProtocol {
  constructor(
    private readonly state: State,
    private readonly sessions: Sessions,
    private readonly writers: CodeWriterService,
    private readonly store: CodeStore,
    private readonly git: CodeGitRemote,
    private readonly submissions: CodeSubmissionService,
  ) {}

  async call(caller: Caller, route: string, body: unknown): Promise<unknown> {
    caller = structuredClone(caller);
    check(!caller.session, 'session_forbidden', 'A leased worker cannot control workspaces', 403);
    if (caller.managed?.cleanup)
      check(
        [
          'submission-status',
          'end',
          'submissions',
          'capture-credential',
          'shutdown-credential',
          'pushed',
        ].includes(route),
        'managed_shutdown_only',
        'Only shutdown capture is available',
        403,
      );
    if (route === 'workspace')
      return await this.manifest(caller, parseCodeInput(codeWorkspaceManifestInputSchema, body));
    if (route === 'git-credential') {
      const input = parseCodeInput(codeWorkspaceManifestInputSchema, body);
      const manifest = await this.manifest(caller, input);
      return await this.git.issue(caller, {
        ...input,
        unitId: manifest.unitId,
        generation: manifest.generation,
        leaseId: input.sessionId,
        mode: manifest.mode,
      });
    }
    if (route === 'capture-credential') {
      const input = parseCodeInput(
        codeWorkspaceManifestInputSchema.extend({ stopped: z.literal(true) }),
        body,
      );
      const session = await this.controlled(caller, input, 'any');
      const row = await this.state.read((sql) =>
        this.writers.row(sql, caller.projectId, session.instanceId),
      );
      check(
        row && row.writer_session_id === session.id,
        'code_generation_stale',
        'Another writer owns this branch',
        409,
      );
      return await this.git.issueCapture(caller, {
        ...input,
        unitId: session.instanceId,
        generation: Number(row.generation),
        leaseId: session.id,
      });
    }
    if (route === 'pushed') {
      const input = parseCodeInput(
        codePushFenceSchema.extend({
          kind: z.enum(['checkpoint', 'final']),
          commandId: id.optional(),
        }),
        body,
      );
      check(
        !caller.managed?.cleanup || input.kind === 'final',
        'managed_shutdown_only',
        'Shutdown may acknowledge only final capture',
        403,
      );
      await this.controlled(caller, input, 'any');
      return { operation: await this.git.acknowledge(caller, input) };
    }
    if (route === 'submission-status' || route === 'end' || route === 'shutdown-credential') {
      const input = parseCodeInput(codeWorkspaceManifestInputSchema, body);
      const session = await this.controlled(caller, input, 'any');
      const row = await this.state.read((sql) =>
        this.writers.row(sql, caller.projectId, session.instanceId),
      );
      check(
        row && row.writer_session_id === session.id,
        'code_generation_stale',
        'Another writer owns this branch',
        409,
      );
      const head = row.head_oid ?? this.writers.base(row);
      const requested = await this.submissions.requested(caller.projectId, session.id);
      if (route === 'submission-status')
        return {
          requested,
          head,
          cleanup: !!caller.managed?.cleanup,
          writerClosed: row.writer_state === 'closed',
          frozen: requested && (await this.submissions.frozen(caller.projectId, session.id)),
        };
      if (route === 'shutdown-credential')
        return await this.git.issueShutdown(caller, {
          ...input,
          unitId: session.instanceId,
          generation: Number(row.generation),
          leaseId: session.id,
        });
      check(
        !requested,
        'code_submission_required',
        'Seal the requested submission before ending this writer',
        409,
      );
      await this.state.transaction((tx) =>
        this.writers.settle(
          tx,
          {
            projectId: caller.projectId,
            unitId: session.instanceId,
            sessionId: session.id,
            generation: Number(row.generation),
            leaseId: session.id,
            expectedHead: head,
            moves: false,
          },
          !live(session) && ownEnd(session.closeReason),
        ),
      );
      return { head };
    }
    if (route === 'submissions') return { capture: await this.submissions.freeze(caller, body) };
    throw new MervError('not_found', 'Unknown Code route', 404);
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
    check(live(session), 'session_closed', 'The assignment is closed', 409);
    const policy = session.execution.policy;
    const workspace = effectiveWorkspace(policy);
    check(
      workspace.mode !== 'none' && workspace.driver === CODE_DRIVER,
      'code_workspace_required',
      'This assignment does not use a workspace from Code’s repository',
      409,
    );
    const stored = await this.state.read((sql) => this.store.stored(sql, caller.projectId));
    check(
      stored,
      'code_base_pending',
      'This project’s repository has not been imported into Code',
      409,
    );
    const shared = {
      projectRef: caller.projectId,
      ...stored,
      unitId: session.instanceId,
      remote: `/git/${caller.projectId}.git`,
    };
    let manifest: CodeWorkspaceManifest;
    if (policy.readOnly) {
      const name = workspace.base.startsWith('reference:')
        ? workspace.base.slice('reference:'.length)
        : '';
      // An inquiry visit has no workspace, so names no commit.
      const head = session.kind !== 'inquiry' ? session.execution.references[name] : undefined;
      check(
        typeof head === 'string' && oidPattern.test(head),
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
      const submissionId =
        session.kind === 'inquiry' ? undefined : session.execution.references.submission;
      if (typeof submissionId === 'string') {
        const capture = await this.submissions.capture(caller, submissionId);
        check(
          capture.status === 'ready' &&
            capture.workspace?.submission &&
            capture.workspace.headOid === head,
          'code_submission_pending',
          'The producer has not frozen its submitted code yet',
          409,
        );
        manifest.submission = capture.workspace.submission;
      }
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
      const pending = await this.state.read((sql) =>
        pendingMerge(sql, caller.projectId, session.instanceId),
      );
      manifest = {
        ...shared,
        generation: Number(unit.generation),
        mode: 'write',
        ...(pending ? { pendingMerge: pending } : {}),
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
