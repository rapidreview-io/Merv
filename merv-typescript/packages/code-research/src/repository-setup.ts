import { z } from 'zod';
import { check, githubBranchSchema } from '@merv/contracts';
import { parseCodeInput } from '@merv/code/input';
import type {
  Caller,
  CodeRepositoryPreparation,
  CodeRepositoryPrepareInput,
} from '@merv/contracts';
import type { Code } from './types.js';
import type { GitHubBinding } from '@merv/code/github';

type PreparationHost = Pick<Code, 'github' | 'status' | 'importRepository'> & {
  bindLocal(
    caller: Caller,
    input: Parameters<Code['bindLocal']>[1],
    binding?: GitHubBinding,
  ): ReturnType<Code['bindLocal']>;
};

const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const repositoryPrepareSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    baseBranch: githubBranchSchema,
    headOid: oid,
    expectedMainOid: oid.optional(),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/),
  })
  .strict();

/** Compose existing durable operations; retries keep the administrator's exact selection. */
export async function prepareRepository(
  code: PreparationHost,
  caller: Caller,
  value: CodeRepositoryPrepareInput,
): Promise<CodeRepositoryPreparation> {
  caller = structuredClone(caller);
  const input = parseCodeInput(repositoryPrepareSchema, value);
  const connection = await code.github.status(caller);
  check(
    connection.revision === input.expectedRevision && connection.baseBranch === input.baseBranch,
    'github_conflict',
    'The repository or selected branch changed; reload its settings',
    409,
  );
  check(
    connection.repository && connection.automation !== 'off',
    'github_repository_required',
    'Select a repository and enable repository access first',
    409,
  );
  const before = await code.status(caller);
  check(
    before.store,
    'code_store_unavailable',
    'Repository storage is not configured on this server',
    503,
  );
  const repositoryId = `github:${connection.repository.id}`;
  check(
    !before.project || before.project.repositoryId === repositoryId,
    'code_rebind_required',
    'This project already keeps another repository. Preserve its history with code.repository.rebind before preparing this repository',
    409,
  );
  // An already-bound head can be a retry after importing it. Never substitute a branch's
  // newer head for the one the administrator selected, including after an uncertain answer.
  if (before.project?.main.oid !== input.headOid) {
    const branch = (await code.github.branches(caller)).find(
      (branch) => branch.name === input.baseBranch,
    );
    check(
      branch?.sha === input.headOid,
      'code_branch_changed',
      'The selected branch moved; reload its branches and choose its current commit',
      409,
    );
  }
  const selectedBinding = {
    revision: connection.revision,
    repository: connection.repository,
    baseBranch: input.baseBranch,
  };
  const binding = await code.bindLocal(
    caller,
    {
      repositoryId,
      mainOid: input.headOid,
      ...(input.expectedMainOid ? { expectedMainOid: input.expectedMainOid } : {}),
      requestId: `${input.requestId}:bind`,
    },
    selectedBinding,
  );
  check(
    binding.main.oid === input.headOid,
    'code_main_changed',
    'The prepared main changed; reload repository settings',
    409,
  );
  const operation = await code.importRepository(caller, {
    source: 'github',
    ref: `refs/heads/${input.baseBranch}`,
    githubBinding: {
      revision: connection.revision,
      repositoryId: connection.repository.id,
      baseBranch: input.baseBranch,
    },
    requestId: `${input.requestId}:import`,
  });
  const after = await code.status(caller);
  const current = await code.github.status(caller);
  check(
    current.revision === input.expectedRevision && current.baseBranch === input.baseBranch,
    'github_conflict',
    'Repository settings changed during preparation; inspect the current settings before continuing',
    409,
  );
  check(
    after.project?.repositoryId === repositoryId,
    'code_rebind_required',
    'The project repository changed during preparation; inspect its current binding before continuing',
    409,
  );
  check(
    after.project?.main.oid === input.headOid,
    'code_main_changed',
    'The project main changed during preparation; inspect its current state before continuing',
    409,
  );
  // A successful transfer is not enough: the selected commit itself must be retained.
  const ready =
    operation.status === 'completed' && after.project.main.stored && after.store?.hosted;
  return {
    state: ready ? 'ready' : operation.status === 'prepared' ? 'importing' : 'failed',
    baseBranch: input.baseBranch,
    headOid: input.headOid,
    operation,
  };
}
