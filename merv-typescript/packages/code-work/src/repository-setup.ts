import { z } from 'zod';
import { check, githubBranchSchema, oidSchema } from '@merv/contracts';
import type { Caller } from '@merv/contracts';
import type {
  CodeRepositoryPreparation,
  CodeRepositoryPrepareInput,
  CodeStoreOperation,
} from '@merv/code/store/protocol';
import type { Code } from './types.js';
import type { CodeService } from './service.js';

type PreparationHost = Pick<Code, 'github' | 'importRepository'> & {
  repositoryState(caller: Caller): ReturnType<CodeService['repositoryState']>;
};

const oid = oidSchema;
export const repositoryPrepareSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    baseBranch: githubBranchSchema,
    headOid: oid,
    expectedMainOid: oid.optional(),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/),
  })
  .strict();

/**
 * Import the selected branch into the project's hosted repository, then integrate it. Retries
 * keep the administrator's exact selection, which the caller has already parsed.
 */
export async function prepareRepository(
  code: PreparationHost,
  caller: Caller,
  input: CodeRepositoryPrepareInput,
  reconcile: (operation: CodeStoreOperation) => Promise<CodeRepositoryPreparation>,
): Promise<CodeRepositoryPreparation> {
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
  const before = await code.repositoryState(caller);
  check(
    before.project?.durability === 'code',
    'code_project_unhosted',
    'This project’s repository is not kept by Code; import it with code.repository.import first',
    409,
  );
  const operation = await code.importRepository(caller, {
    source: 'github',
    ref: `refs/heads/${input.baseBranch}`,
    expectedHead: input.headOid,
    githubBinding: {
      revision: connection.revision,
      repositoryId: connection.repository.id,
      baseBranch: input.baseBranch,
    },
    requestId: `${input.requestId}:import`,
  });
  if (operation.status !== 'completed')
    return {
      state: operation.status === 'prepared' ? 'importing' : 'failed',
      baseBranch: input.baseBranch,
      headOid: input.headOid,
      operation,
    };
  check(
    operation.head === input.headOid,
    'code_branch_changed',
    'The imported head differs from the selected head',
    409,
  );
  return reconcile(operation);
}
