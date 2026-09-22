import {
  canonical,
  check,
  codeTransportInputSchema,
  effectiveWorkspace,
  type Caller,
  type State,
  type CodeTransportInput,
  type CodeTransportGrant,
  type Transaction,
  type CodeCommandCompletion,
} from '@merv/contracts';
import type { Sessions } from '@merv/sessions/types';
import type { CodeCommands } from './types.js';
import { CodeGitHubService, type GitHubBinding } from '@merv/code/github';
import { parseCodeInput } from '@merv/code/input';

interface Workspace {
  project_id: string;
  session_id: string;
  host_ref: string;
  binding_json: string;
  base_oid: string;
}
interface Push {
  id: string;
  session_id: string;
  input_json: string;
  target_json: string;
  verified: number;
}
const schema = `CREATE TABLE code_github_workspaces (
  session_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,host_ref TEXT NOT NULL,binding_json TEXT NOT NULL,base_oid TEXT NOT NULL
);
CREATE TABLE code_github_pushes (
  id TEXT PRIMARY KEY,session_id TEXT NOT NULL,input_json TEXT NOT NULL,target_json TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0
);`;

/** Authenticated machine transport. Every destination is frozen before a token is lent. */
export class CodeTransportService {
  constructor(
    private state: State,
    private sessions: Sessions,
    private commands: CodeCommands,
    private github: CodeGitHubService,
  ) {}
  async initialize() {
    await this.state.migrate('code_github_transport', [
      { version: 1, sql: schema, postgres: schema },
    ]);
  }
  private async session(caller: Caller, input: CodeTransportInput) {
    check(
      !caller.session,
      'session_forbidden',
      'Worker credentials cannot control Git transport',
      403,
    );
    const session = await this.sessions.get(caller, input.sessionId);
    check(
      session.runnerId === input.runnerId &&
        (session.hostRef === input.hostRef ||
          (input.operation === 'fetch' &&
            ['offered', 'active'].includes(session.status) &&
            session.hostRef === null)),
      'session_forbidden',
      'Git transport belongs to another runner or launch',
      403,
    );
    check(
      effectiveWorkspace(session.execution.policy).mode !== 'none',
      'code_workspace_required',
      'This assignment does not use Git',
      409,
    );
    const workspacePolicy = effectiveWorkspace(session.execution.policy);
    check(
      workspacePolicy.mode === 'none' || workspacePolicy.driver !== 'code.v2',
      'code_transport_forbidden',
      'Hosted work uses Code bundle transport; GitHub credentials stay on the server',
      403,
    );
    if (input.operation === 'fetch')
      check(
        ['offered', 'active'].includes(session.status),
        'session_closed',
        'The assignment is closed',
        409,
      );
    else
      check(
        !session.execution.policy.readOnly && session.workspace,
        'code_read_only',
        'The assignment cannot publish code',
        403,
      );
    return session;
  }
  private async workspace(caller: Caller, input: CodeTransportInput) {
    const row = await this.state.read((sql) =>
      sql.get<Workspace>(
        'SELECT * FROM code_github_workspaces WHERE session_id=?',
        input.sessionId,
      ),
    );
    if (row)
      check(
        row.project_id === caller.projectId && row.host_ref === input.hostRef,
        'github_conflict',
        'Git workspace binding changed',
        409,
      );
    return row;
  }
  private async prepare(caller: Caller, input: CodeTransportInput) {
    const session = await this.session(caller, input);
    let row = await this.workspace(caller, input);
    if (!row) {
      check(
        input.operation === 'fetch',
        'github_workspace_required',
        'Prepare the GitHub workspace before pushing',
        409,
      );
      const selected = await this.github.automation(
        caller,
        'read',
        undefined,
        async (client, token, binding) => ({
          binding,
          baseOid: (await client.branch(token, binding.repository.fullName, binding.baseBranch))
            .sha,
        }),
      );
      await this.state.transaction(async (tx) => {
        await this.session(caller, input);
        await this.github.assertBinding(caller, selected.binding, tx, 'read');
        await tx.run(
          'INSERT INTO code_github_workspaces VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING',
          input.sessionId,
          caller.projectId,
          input.hostRef,
          canonical(selected.binding),
          selected.baseOid,
        );
      });
      row = (await this.workspace(caller, input))!;
    }
    const binding = JSON.parse(row.binding_json) as GitHubBinding;
    let target: CodeTransportGrant['target'] = null;
    let pushId: string | undefined;
    if (input.operation !== 'fetch') {
      const attached = session.workspace!.attachment;
      const result = input.operation === 'checkpoint' ? input.receipt : input.workspace;
      check(
        result.repositoryId === `github:${binding.repository.id}` &&
          result.repositoryId === attached.repositoryId &&
          result.workspaceId === attached.workspaceId &&
          result.baseOid === attached.baseOid &&
          /^[a-f0-9]{40}$/.test(result.headOid) &&
          result.treeOid &&
          /^[a-f0-9]{40}$/.test(result.treeOid),
        'code_receipt_conflict',
        'Git result does not match its attached repository',
        409,
      );
      if (input.operation === 'checkpoint') {
        const operation = await this.commands.operation(caller, input.receipt.commandId);
        check(
          operation.command.sessionId === session.id &&
            ['dispatched', 'succeeded'].includes(operation.status) &&
            operation.command.expectedHead === input.receipt.parentOid &&
            (operation.receipt === null ||
              canonical(operation.receipt) === canonical(input.receipt)),
          'code_receipt_conflict',
          'Git result does not match the dispatched command',
          409,
        );
        pushId = input.receipt.commandId;
      } else {
        check(
          input.workspace.mode === attached.mode && input.workspace.branch === attached.branch,
          'code_receipt_conflict',
          'Git capture does not match its attachment',
          409,
        );
        pushId = `capture:${session.id}`;
      }
      target = {
        branch:
          input.operation === 'checkpoint'
            ? `merv/checkpoints/${input.receipt.commandId}`
            : `merv/captures/${session.id}`,
        headOid: result.headOid,
        treeOid: result.treeOid!,
      };
      await this.state.transaction(async (tx) => {
        await this.session(caller, input);
        await this.github.assertBinding(caller, binding, tx, 'write');
        await tx.run(
          'INSERT INTO code_github_pushes(id,session_id,input_json,target_json) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING',
          pushId!,
          session.id,
          canonical(input),
          canonical(target),
        );
        const saved = (await tx.get<Push>('SELECT * FROM code_github_pushes WHERE id=?', pushId!))!;
        check(
          saved.session_id === session.id &&
            saved.input_json === canonical(input) &&
            saved.target_json === canonical(target),
          'github_conflict',
          'This Git operation already has a different immutable target',
          409,
        );
      });
    }
    return { row, binding, target, pushId };
  }
  async grant(caller: Caller, value: CodeTransportInput): Promise<CodeTransportGrant> {
    caller = structuredClone(caller);
    const input = parseCodeInput(codeTransportInputSchema, value);
    const { row, binding, target } = await this.prepare(caller, input);
    let cleanup: (() => Promise<void>) | undefined;
    try {
      const result = await this.github.automation(
        caller,
        target ? 'write' : 'read',
        binding,
        async (client, _token, current) => {
          await this.session(caller, input);
          const secret = await client.installationToken(current.repository, !!target);
          cleanup = () => client.revokeInstallationToken(secret.token);
          await this.session(caller, input);
          return {
            repositoryId: `github:${current.repository.id}`,
            repository: current.repository.fullName,
            revision: current.revision,
            baseBranch: current.baseBranch,
            baseOid: row.base_oid,
            target,
            ...secret,
          };
        },
      );
      cleanup = undefined;
      return result;
    } finally {
      if (cleanup) await cleanup().catch(() => {});
    }
  }
  async verify(caller: Caller, value: CodeTransportInput) {
    caller = structuredClone(caller);
    const input = parseCodeInput(codeTransportInputSchema, value);
    check(input.operation !== 'fetch', 'invalid_code_input', 'Only a push has a remote receipt');
    const { binding, target, pushId } = await this.prepare(caller, input);
    await this.github.automation(caller, 'write', binding, async (client, token) => {
      const branch = await client.branch(token, binding.repository.fullName, target!.branch);
      const commit = await client.commit(token, binding.repository.fullName, target!.headOid);
      check(
        branch.sha === target!.headOid && commit.tree === target!.treeOid,
        'github_push_mismatch',
        'GitHub does not contain the exact recorded commit and tree',
        409,
      );
      await this.state.transaction(async (tx) => {
        await this.session(caller, input);
        await this.github.assertBinding(caller, binding, tx, 'write');
        await tx.run('UPDATE code_github_pushes SET verified=1 WHERE id=?', pushId!);
      });
    });
    return { verified: true };
  }
  async requireCheckpoint(input: CodeCommandCompletion, tx: Transaction) {
    if (!input.receipt?.repositoryId.startsWith('github:')) return;
    const row = await tx.get<Push>('SELECT * FROM code_github_pushes WHERE id=?', input.commandId);
    check(
      row?.verified === 1 &&
        row.session_id === input.sessionId &&
        canonical(JSON.parse(row.input_json).receipt) === canonical(input.receipt),
      'github_push_required',
      'Verify the checkpoint on GitHub before completing the command',
      409,
    );
  }
  async bindingForProposal(sessionId: string, tx: Transaction): Promise<GitHubBinding | null> {
    const row = await tx.get<Workspace>(
      'SELECT * FROM code_github_workspaces WHERE session_id=?',
      sessionId,
    );
    return row ? JSON.parse(row.binding_json) : null;
  }
}
