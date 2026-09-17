import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ResearchRecord } from '@merv/research/models';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useTool } from '../api';
import { useCommand } from '../mutations';
import { Area, Failure, Field, GateBox, LoadState, RecordPage, StatusPill } from '../components';
import { ListPage, splitRoutes, useListFilter } from '../list-filters';
import { ThreeStates } from '../states';
import { useSession } from '../session';
import { ResearchCommand } from './paper';
import type { ViewProps } from './index';

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
        <Field label="Name" required maxLength={200} value={name} onChange={setName} />
        <Area
          label="Research prerequisites"
          className="textarea mono"
          rows={2}
          value={dependencies}
          onChange={setDependencies}
          placeholder="Workflow IDs, separated by spaces"
        />
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
          <Area
            label="Additional consolidation prerequisites"
            className="textarea mono"
            rows={2}
            value={consolidationDependencies}
            onChange={setConsolidationDependencies}
          />
        )}
      </fieldset>
      <p className="faint">
        Define the problem in Living paper. This cycle completes after approved reflection, or
        continues through Git consolidation when code changes are selected. Paper edits are part of
        the scientific reviews.
      </p>
      <Failure message={command.error} />
      <div>
        <button className="btn btn--primary" disabled={command.busy || !name.trim()}>
          {command.retry ? 'Retry same request' : 'Create cycle'}
        </button>
      </div>
    </form>
  );
}

/** How a cycle handles code, in the words the cycle itself was opened with. */
const consolidation = (record: ResearchRecord) =>
  record.consolidationWorkspace === 'git'
    ? 'Git consolidation'
    : record.workflow.version < 3
      ? 'Report consolidation (legacy cycle)'
      : 'No code changes';

function CycleDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const { actor } = useSession();
  const cycle = useTool<ResearchRecord>('research.get', { researchId: id }, { every: 10000 });
  const guidance = useTool<WorkflowDecision>(
    'workflow.status_and_next',
    { instanceId: id },
    { every: 5000 },
  );
  if (!cycle.data)
    return (
      <div className="page-stage">
        <LoadState {...cycle} back={{ to: row.path, label: row.label }} />
      </div>
    );
  const record = cycle.data;
  const writable =
    actor.role === 'operator' || (actor.role === 'producer' && record.ownerId === actor.id);
  return (
    <RecordPage
      back={<Link to={row.path}>← {row.label}</Link>}
      kind={row.view.kind}
      name={record.name}
      standing={`${consolidation(record)} · revision ${record.workflow.revision}`}
      state={<StatusPill value={record.workflow.state} />}
      act={
        <>
          <LoadState {...guidance} />
          {guidance.data && !guidance.error && <GateBox decision={guidance.data} />}
          {writable && (
            <ResearchCommand
              disabled={record.workflow.state === 'complete'}
              tool="research.advance"
              input={{ researchId: record.id, expectedRevision: record.workflow.revision }}
              label={record.workflow.state === 'complete' ? 'Cycle complete' : 'Advance when ready'}
              onSaved={() => {
                cycle.reload();
                guidance.reload();
              }}
            />
          )}
        </>
      }
      related={
        <div className="cluster">
          <Link to="/paper">
            Living paper{record.problem ? ` · problem revision ${record.problem.revision}` : ''}
          </Link>
          {record.reflectionId && <Link to="/reflections">Reflection</Link>}
          {record.consolidationId && <Link to="/consolidation">Consolidation</Link>}
        </div>
      }
    />
  );
}

function CycleList() {
  const { actor } = useSession();
  const cycles = useTool<ResearchRecord[]>('research.list', {}, { every: 10000 });
  const filter = useListFilter(cycles.data, {
    stateOf: (record) => record.workflow.state,
    mine: (record) => record.ownerId === actor.id,
    labels: (record) => [record.name],
    ids: (record) => [record.id],
  });
  return (
    <ListPage
      load={cycles}
      noun="cycles"
      placeholder="Name"
      filter={filter}
      opens
      emptyTitle="No research cycles yet"
      emptyHint="A cycle runs from the problem definition to reviewed findings; a producer starts one here."
      create={{
        label: 'New cycle',
        shown: actor.role === 'operator' || actor.role === 'producer',
        form: (close) => (
          <CreateResearch
            onSaved={() => {
              close();
              cycles.reload();
            }}
          />
        ),
      }}
      line={(record) => ({
        name: <strong>{record.name}</strong>,
        standing: (
          <ThreeStates
            execution={record.workflow.state}
            meta={`${consolidation(record)} · revision ${record.workflow.revision}`}
          />
        ),
      })}
    />
  );
}

export const ResearchView = splitRoutes(CycleList, CycleDetail);
