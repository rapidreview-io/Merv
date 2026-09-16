import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ResearchRecord } from '@merv/research/models';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useScopeVersion, useTool } from '../api';
import { useCommand } from '../mutations';
import { LoadState, ObjId, StatusPill } from '../components';
import { useSession } from '../session';
import { ResearchCommand } from './paper';

const ids = (value: string) => value.split(/\s+/).filter(Boolean);

function CreateResearch({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('');
  const [dependencies, setDependencies] = useState('');
  const [consolidationDependencies, setConsolidationDependencies] = useState('');
  const [workspace, setWorkspace] = useState('none');
  const command = useCommand<ResearchRecord>({
    tool: 'research.create',
    validate: (value) =>
      !!value && typeof value.id === 'string' && value.workflow?.workflow === 'research',
    onSuccess: () => {
      setName('');
      setDependencies('');
      setConsolidationDependencies('');
      onSaved();
    },
  });
  return (
    <form
      className="card stack claims-form"
      onSubmit={(event) => {
        event.preventDefault();
        void command.submit({
          name,
          dependsOn: ids(dependencies),
          consolidationDependsOn: workspace === 'git' ? ids(consolidationDependencies) : [],
          consolidationWorkspace: workspace,
        });
      }}
    >
      <h2>Start a research cycle</h2>
      <fieldset disabled={command.locked}>
        <label>
          Name
          <input
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Research prerequisites
          <textarea
            className="textarea mono"
            rows={2}
            value={dependencies}
            onChange={(event) => setDependencies(event.target.value)}
            placeholder="Workflow IDs, separated by spaces"
          />
        </label>
        <label>
          Code changes
          <select
            value={workspace}
            onChange={(event) => {
              setWorkspace(event.target.value);
              if (event.target.value === 'none') setConsolidationDependencies('');
            }}
          >
            <option value="none">No code changes</option>
            <option value="git">Git consolidation</option>
          </select>
        </label>
        {workspace === 'git' && (
          <label>
            Additional consolidation prerequisites
            <textarea
              className="textarea mono"
              rows={2}
              value={consolidationDependencies}
              onChange={(event) => setConsolidationDependencies(event.target.value)}
            />
          </label>
        )}
      </fieldset>
      <p className="faint">
        Define the problem in Living paper. This cycle completes after approved reflection, or
        continues through Git consolidation when code changes are selected. Paper edits are part of
        the scientific reviews.
      </p>
      {command.error && (
        <p className="error-message" role="alert">
          {command.error}
        </p>
      )}
      <div>
        <button className="btn btn--primary" disabled={command.busy || !name.trim()}>
          {command.retry ? 'Retry same request' : 'Create cycle'}
        </button>
      </div>
    </form>
  );
}

function Cycle({ record, reload }: { record: ResearchRecord; reload: () => void }) {
  const { actor } = useSession();
  const guidance = useTool<WorkflowDecision>(
    'workflow.status_and_next',
    { instanceId: record.id },
    { every: 5000 },
  );
  const writable =
    actor.role === 'operator' || (actor.role === 'producer' && record.ownerId === actor.id);
  // The instruction already says it; a blocker that repeats it word for word is noise.
  const blockers = (guidance.data?.blockers ?? []).filter(
    (blocker) => blocker.message !== guidance.data?.instruction,
  );
  return (
    <article className="record stack">
      <div className="cluster">
        <h2>{record.name}</h2>
        <StatusPill value={record.workflow.state} />
        <ObjId id={record.id} />
      </div>
      <p className="faint">
        Revision {record.workflow.revision} ·{' '}
        {record.consolidationWorkspace === 'git'
          ? 'Git consolidation'
          : record.workflow.version < 3
            ? 'Report consolidation (legacy cycle)'
            : 'No code changes'}
      </p>
      <LoadState {...guidance} />
      {guidance.data && !guidance.error && (
        <>
          <p>{guidance.data.instruction}</p>
          {!!blockers.length && (
            <ul>
              {blockers.map((blocker, index) => (
                <li key={index}>{blocker.message}</li>
              ))}
            </ul>
          )}
          {!!guidance.data.dependencies.length && (
            <details>
              <summary>Work dependencies ({guidance.data.dependencies.length})</summary>
              <ul>
                {guidance.data.dependencies.map((item) => (
                  <li key={item.id}>
                    {item.name} <ObjId id={item.id} /> <StatusPill value={item.state} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <div className="cluster">
        <Link to="/paper">
          Living paper{record.problem ? ` · problem revision ${record.problem.revision}` : ''}
        </Link>
        {record.reflectionId && (
          <Link to="/reflections">
            Reflection <ObjId id={record.reflectionId} />
          </Link>
        )}
        {record.consolidationId && (
          <Link to="/consolidation">
            Consolidation <ObjId id={record.consolidationId} />
          </Link>
        )}
      </div>
      {writable && (
        <ResearchCommand
          disabled={record.workflow.state === 'complete'}
          tool="research.advance"
          input={{ researchId: record.id, expectedRevision: record.workflow.revision }}
          label={record.workflow.state === 'complete' ? 'Cycle complete' : 'Advance when ready'}
          onSaved={() => {
            reload();
            guidance.reload();
          }}
        />
      )}
    </article>
  );
}

function ResearchPage() {
  const { actor } = useSession();
  const cycles = useTool<ResearchRecord[]>('research.list', {}, { every: 10000 });
  const [creating, setCreating] = useState(false);
  return (
    <div className="page-stage stack stack--lg">
      {(actor.role === 'operator' || actor.role === 'producer') && (
        <div className="action-row">
          <button
            type="button"
            className="btn"
            aria-expanded={creating}
            onClick={() => setCreating((open) => !open)}
          >
            New cycle
          </button>
        </div>
      )}
      {creating && (
        <CreateResearch
          onSaved={() => {
            setCreating(false);
            cycles.reload();
          }}
        />
      )}
      <LoadState
        {...cycles}
        empty={cycles.data?.length === 0}
        emptyTitle="No research cycles yet"
        emptyHint="A cycle runs from the problem definition to reviewed findings; a producer starts one here."
      />
      {cycles.data?.map((record) => (
        <Cycle key={record.id} record={record} reload={cycles.reload} />
      ))}
    </div>
  );
}

export function ResearchView() {
  const epoch = useScopeVersion();
  const { actor, project } = useSession();
  return <ResearchPage key={`${epoch}:${project.id}:${actor.id}:${actor.role}`} />;
}
