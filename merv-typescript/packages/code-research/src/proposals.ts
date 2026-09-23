import { parseCodeInput } from '@merv/code/input';
import {
  canonical,
  check,
  mapAsync,
  newId,
  now,
  recorded,
  visible,
  type Artifact,
  type Artifacts,
  type Caller,
  type Data,
  type Scope,
  type Sql,
  type State,
  type Transaction,
  type WorkflowDispatchAdmission,
} from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { postgresMigrations } from './proposals.postgres.js';
import type { CodeCommands, CodeProposal, CodeProposalInput, CodeProposals } from './types.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const data = z.record(z.unknown()).transform((value) => value as Data);
const inputSchema = z
  .object({
    commandId: identifier,
    summary: z
      .string()
      .min(1)
      .max(12000)
      .refine((value) => visible(value) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)),
    artifactIds: z.array(identifier).min(1).max(64),
    pinnedInputIds: z.array(identifier).max(64).default([]),
    provenance: data.default({}),
    requestId: identifier,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.artifactIds).size !== value.artifactIds.length ||
      new Set(value.pinnedInputIds).size !== value.pinnedInputIds.length ||
      value.pinnedInputIds.some((id) => !value.artifactIds.includes(id))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Artifact IDs must be distinct and pinned inputs must belong to the manifest',
      });
  });
const admissionSchema = z
  .object({ tool: z.string().regex(/^[_A-Za-z][A-Za-z0-9_.-]{0,199}$/), input: data })
  .strict();
const artifactSchema = z
  .object({
    id: identifier,
    projectId: identifier,
    createdBy: identifier,
    title: z.string().min(1).max(300),
    mediaType: z.string().min(1).max(150),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive().max(2_000_000),
    createdAt: z.string().datetime(),
  })
  .strict();
type Row = { proposal_json: string; input_hash: string };

/** Immutable code facts sealed by an admitting domain command, without owning its workflow. */
export class CodeProposalService implements CodeProposals {
  private closed = false;
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private readonly commands: CodeCommands,
    private readonly state: State,
    private readonly scope: Scope,
    private readonly sessions: Sessions,
    private readonly artifacts: Artifacts,
  ) {
    this.initialize = async () => {
      await state.migrate('code_proposals', [
        {
          version: 1,
          sql: postgresMigrations[1],
        },
      ]);
    };
  }

  async seal(
    caller: Caller,
    value: CodeProposalInput,
    binding: WorkflowDispatchAdmission,
    tx: Transaction,
  ): Promise<CodeProposal> {
    caller = this.capture(caller);
    this.state.assertTransaction(tx);
    const input = parseCodeInput(inputSchema, value);
    const admission = parseCodeInput(admissionSchema, binding);
    check(
      caller.session?.invocationId,
      'session_invocation',
      "Sealing requires the domain command's existing session invocation",
      403,
    );
    await this.scope.require(caller, 'write', tx);
    await this.sessions.validate(caller, admission.tool, admission.input);
    const session = await this.sessions.describe(caller);
    check(session.status === 'active', 'session_closed', 'Sealing requires an active worker', 409);
    check(
      !session.execution.policy.readOnly,
      'code_read_only',
      'A read-only session cannot seal code',
      403,
    );
    check(
      session.hostRef && session.workspace && session.workspace.result === null,
      'code_workspace_closed',
      'Sealing requires an attached workspace before final capture',
      409,
    );
    const operation = await this.commands.operation(caller, input.commandId);
    check(
      operation.status === 'succeeded' && operation.receipt,
      'code_commit_required',
      'Sealing requires a successful commit operation',
      409,
    );
    const { command, receipt } = operation;
    check(
      command.sessionId === session.id &&
        command.actorId === caller.actorId &&
        command.projectId === caller.projectId &&
        command.instanceId === session.instanceId &&
        command.expectedRevision === session.expectedRevision &&
        command.runnerId === session.runnerId &&
        command.hostRef === session.hostRef &&
        canonical(command.workspace) === canonical(session.workspace.attachment) &&
        session.execution.instanceId === command.instanceId &&
        session.execution.actorId === caller.actorId &&
        session.execution.projectId === caller.projectId &&
        session.execution.revision === command.expectedRevision &&
        receipt.commandId === command.id &&
        receipt.repositoryId === command.workspace.repositoryId &&
        receipt.workspaceId === command.workspace.workspaceId &&
        receipt.baseOid === command.workspace.baseOid &&
        receipt.parentOid === command.expectedHead,
      'code_proposal_binding',
      'Commit, workspace and workflow must belong to this exact worker assignment',
      409,
    );
    const inputHash = createHash('sha256')
      .update(canonical({ format: 1, input, admission }))
      .digest('hex');
    const previous = await tx.get<Row>(
      'SELECT proposal_json,input_hash FROM code_proposals WHERE project_id=? AND session_id=? AND request_id=?',
      caller.projectId,
      session.id,
      input.requestId,
    );
    if (previous) {
      check(
        previous.input_hash === inputHash,
        'code_proposal_conflict',
        'The request ID already identifies different proposal input or admission',
        409,
      );
      return JSON.parse(previous.proposal_json) as CodeProposal;
    }
    check(
      input.pinnedInputIds.length < input.artifactIds.length,
      'code_proposal_output_required',
      'A proposal requires at least one worker-authored evidence output',
      409,
    );
    const artifacts = await mapAsync(
      input.artifactIds,
      async (id) => await this.pinArtifact(caller, id, tx),
    );
    check(
      artifacts.every(
        (artifact) =>
          input.pinnedInputIds.includes(artifact.id) || artifact.createdBy === caller.actorId,
      ),
      'code_proposal_authorship',
      'Evidence outputs must be authored by the current worker',
      403,
    );
    const revision = Number(
      (await tx.get<{ revision: number }>(
        'SELECT COALESCE(MAX(revision),0)+1 AS revision FROM code_proposals WHERE project_id=? AND instance_id=?',
        caller.projectId,
        session.instanceId,
      ))!.revision,
    );
    check(
      Number.isSafeInteger(revision) && revision > 0,
      'code_proposal_revision',
      'Proposal revision is exhausted',
      409,
    );
    const manifest = {
      format: 1,
      id: newId('codeprop'),
      projectId: caller.projectId,
      instanceId: session.instanceId,
      revision,
      createdAt: now(),
      producer: { actorId: caller.actorId, sessionId: session.id, source: session.source },
      workflow: {
        name: session.execution.workflow,
        version: session.execution.version,
        state: session.execution.state,
        revision: session.execution.revision,
        policyHash: session.execution.policyHash,
        registrationId: session.execution.registrationId,
      },
      command,
      receipt,
      summary: input.summary,
      artifacts,
      pinnedInputIds: input.pinnedInputIds,
      provenance: input.provenance,
      admission,
    };
    const content = canonical(manifest);
    const manifestHash = createHash('sha256').update(content).digest('hex');
    await this.scope.require(caller, 'write', tx);
    await this.sessions.validate(caller, admission.tool, admission.input);
    const manifestArtifact = parseCodeInput(
      artifactSchema,
      await this.artifacts.create(
        caller,
        {
          title: `Code proposal ${revision}: ${session.execution.workflow}`,
          content,
          mediaType: 'application/json',
        },
        tx,
      ),
    );
    check(
      manifestArtifact.projectId === caller.projectId &&
        manifestArtifact.createdBy === caller.actorId &&
        manifestArtifact.hash === manifestHash &&
        manifestArtifact.size === Buffer.byteLength(content),
      'code_proposal_artifact',
      'The proposal manifest must retain the original worker and exact canonical content',
      409,
    );
    await this.scope.require(caller, 'write', tx);
    await this.sessions.validate(caller, admission.tool, admission.input);
    const { format: _format, ...facts } = manifest;
    const proposal: CodeProposal = { ...facts, manifestHash, manifestArtifact };
    const encoded = canonical(proposal);
    await tx.run(
      'INSERT INTO code_proposals(id,project_id,instance_id,revision,session_id,request_id,input_hash,proposal_json) VALUES(?,?,?,?,?,?,?,?)',
      proposal.id,
      caller.projectId,
      session.instanceId,
      revision,
      session.id,
      input.requestId,
      inputHash,
      encoded,
    );
    await recorded(this.state, tx, caller, 'code.proposal_sealed', proposal.id, {
      commandId: command.id,
      instanceId: session.instanceId,
      proposalRevision: revision,
      expectedRevision: session.expectedRevision,
      policyHash: session.execution.policyHash,
      manifestArtifactId: manifestArtifact.id,
      manifestHash,
    });
    return JSON.parse(encoded) as CodeProposal;
  }

  async proposal(
    caller: Caller,
    proposalId: string,
    transaction?: Transaction,
  ): Promise<CodeProposal> {
    caller = this.capture(caller);
    const id = parseCodeInput(identifier, proposalId);
    return await this.read(caller, transaction, async (tx) => {
      const row = await tx.get<Row>(
        'SELECT proposal_json,input_hash FROM code_proposals WHERE id=? AND project_id=?',
        id,
        caller.projectId,
      );
      check(row, 'code_proposal_not_found', 'Code proposal not found in this project', 404);
      return JSON.parse(row.proposal_json) as CodeProposal;
    });
  }
  async proposals(
    caller: Caller,
    instanceId?: string,
    transaction?: Transaction,
  ): Promise<CodeProposal[]> {
    caller = this.capture(caller);
    const id = instanceId === undefined ? undefined : parseCodeInput(identifier, instanceId);
    return await this.read(caller, transaction, async (tx) => {
      return (
        await tx.all<Row>(
          `SELECT proposal_json,input_hash FROM code_proposals WHERE project_id=?${id ? ' AND instance_id=?' : ''} ORDER BY _merv_rowid DESC LIMIT 100`,
          caller.projectId,
          ...(id ? [id] : []),
        )
      ).map((row) => JSON.parse(row.proposal_json) as CodeProposal);
    });
  }
  private async read<T>(
    caller: Caller,
    tx: Transaction | undefined,
    read: (sql: Sql) => T,
  ): Promise<T> {
    if (tx) this.state.assertTransaction(tx);
    await this.scope.require(caller, 'read', tx);
    return tx ? read(tx) : await this.state.read(read);
  }
  private async pinArtifact(caller: Caller, id: string, tx: Transaction): Promise<Artifact> {
    const artifact = parseCodeInput(artifactSchema, await this.artifacts.get(caller, id, tx));
    check(
      artifact.projectId === caller.projectId && artifact.id === id,
      'code_proposal_artifact',
      'Evidence must belong to this project',
      403,
    );
    const read = await this.artifacts.read(caller, id);
    check(
      canonical(parseCodeInput(artifactSchema, read.artifact)) === canonical(artifact) &&
        typeof read.content === 'string' &&
        (read.encoding === 'utf8' || read.encoding === 'base64'),
      'code_proposal_artifact',
      'Evidence metadata changed while sealing',
      409,
    );
    const bytes = Buffer.from(read.content, read.encoding);
    check(
      bytes.length === artifact.size &&
        createHash('sha256').update(bytes).digest('hex') === artifact.hash,
      'code_proposal_artifact',
      'Evidence bytes do not match their immutable metadata',
      409,
    );
    return artifact;
  }
  close(): void {
    this.closed = true;
  }
  private capture(caller: Caller): Caller {
    check(!this.closed, 'code_unavailable', 'Code proposals are unavailable', 503);
    return structuredClone(caller);
  }
}
