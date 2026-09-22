import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  CodeRepositoryPreparation,
  CodeRepositoryPrepareInput,
} from '@merv/contracts/code-store';
import type { CodeProjectStatus } from '@merv/contracts/code';
import type { GitHubBranch, GitHubStatus } from '@merv/contracts/types';
import { accountRequest, call, useTool } from '../api';
import { useCommand } from '../mutations';
import { Short } from '../components';

/** One repeatable setup operation, with the user's branch and commit frozen before sending. */
export function GitHubPreparation({ status }: { status: GitHubStatus }) {
  const read = useTool<CodeProjectStatus>('code.status');
  const [input, setInput] = useState<CodeRepositoryPrepareInput>();
  const [result, setResult] = useState<CodeRepositoryPreparation>();
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const command = useCommand<CodeRepositoryPreparation>({
    tool: 'code.repository.prepare',
    idempotent: true,
    validate: (value) =>
      ['ready', 'importing', 'failed'].includes(value?.state) && !!value.operation,
    onSuccess: setResult,
  });
  useEffect(() => {
    if (result?.state !== 'importing' || command.busy || command.error || !input) return;
    const timer = setTimeout(() => {
      void command.submit({ ...input });
    }, 3000);
    return () => clearTimeout(timer);
  }, [result, command.busy, command.error, input]);
  const prepare = async () => {
    if (input && (command.retry || result?.state === 'importing')) {
      await command.submit({ ...input });
      return;
    }
    setSelecting(true);
    setError(undefined);
    try {
      const [{ branches }, current] = await Promise.all([
        accountRequest<{ branches: GitHubBranch[] }>('/code/github/branches', {
          scoped: true,
          credentials: 'same-origin',
        }),
        call<CodeProjectStatus>('code.status'),
      ]);
      if (!live.current) return;
      const branch = branches.find((branch) => branch.name === status.baseBranch);
      if (!branch) throw new Error('Reload repository settings to select the current branch.');
      const selected: CodeRepositoryPrepareInput = {
        expectedRevision: status.revision,
        baseBranch: branch.name,
        headOid: branch.sha,
        ...(current.project ? { expectedMainOid: current.project.main.oid } : {}),
        requestId: crypto.randomUUID(),
      };
      setInput(selected);
      setResult(undefined);
      await command.submit({ ...selected });
    } catch (failure) {
      if (live.current)
        setError(failure instanceof Error ? failure.message : 'Could not read the selected branch');
    } finally {
      if (live.current) setSelecting(false);
    }
  };
  return (
    <section className="stack" aria-label="Repository preparation">
      <h3>Research repository</h3>
      <p className="muted">
        Prepare <strong>{status.baseBranch}</strong> as the starting point for new work. Existing
        work keeps its original base.
      </p>
      {result?.state === 'ready' ? (
        <p>
          Ready at <Short value={result.headOid} />. <Link to="/code">View changes</Link>
        </p>
      ) : (
        <>
          <button
            className="btn"
            disabled={selecting || command.busy || read.loading || !read.data}
            onClick={() => void prepare()}
          >
            {selecting || command.busy
              ? 'Preparing…'
              : command.retry
                ? 'Retry same preparation'
                : result?.state === 'importing'
                  ? 'Check preparation'
                  : result?.state === 'failed'
                    ? 'Start preparation again'
                    : 'Prepare repository'}
          </button>
          {result?.state === 'importing' && (
            <p role="status">
              Importing {result.baseBranch}. This updates automatically.{' '}
              {result.operation.waiting?.message}
            </p>
          )}
          {result?.state === 'failed' && (
            <p role="alert">
              Preparation stopped:{' '}
              {result.operation.error ?? 'the selected commit was not retained'}. Check the import
              findings on the <Link to="/code">Code page</Link>, correct the cause, then start
              again.
            </p>
          )}
        </>
      )}
      {(error || command.error || read.error) && (
        <p role="alert">{error ?? command.error ?? read.error?.message}</p>
      )}
    </section>
  );
}
