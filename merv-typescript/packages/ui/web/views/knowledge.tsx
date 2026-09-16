import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTool, type Project } from '../api';
import { LoadState, ObjId, PageHeader, StatusPill, Table } from '../components';
import type { ViewProps } from './index';

interface Records {
  project: Project;
  claims: { id: string; statement: string; status: string; revision: number }[];
  tasks: { id: string; title: string; workflow: { state: string; revision: number } }[];
  experiments: { id: string; name: string; workflow: { state: string; revision: number } }[];
  publication: { status: 'none' };
}
interface Reference {
  ref: string;
  status: 'resolved' | 'missing' | 'unsupported' | 'unpublished';
  kind: string | null;
  id: string | null;
  label?: string;
  revision?: number;
  state?: string;
  hash?: string;
  capture?: {
    status: string;
    provenance: { sessionId: string; instanceId: string; revision: number };
    workspace: { headOid?: string; treeOid?: string } | null;
  };
}

function ReferenceLookup() {
  const [text, setText] = useState('');
  const [refs, setRefs] = useState<string[] | null>(null);
  const [error, setError] = useState<string>();
  const lookup = useTool<Reference[]>(refs ? 'project.references' : null, { refs: refs ?? [] });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = text.split(/\s+/).filter(Boolean);
    if (!next.length || next.length > 200) {
      setError('Enter between 1 and 200 references, separated by spaces or new lines.');
      return;
    }
    setError(undefined);
    setRefs(next);
    lookup.reload();
  };
  return (
    <section className="stack">
      <h2 className="section-title">Check references</h2>
      <form className="card stack claims-form" onSubmit={submit}>
        <label>
          Record IDs or references
          <textarea
            className="textarea mono"
            rows={3}
            value={text}
            maxLength={40200}
            onChange={(event) => setText(event.target.value)}
            placeholder="claim:claim_… artifact:art_… published-graph"
          />
        </label>
        <p className="faint">
          Use record IDs or a kind followed by an ID, such as task: or session-final:. This reads
          metadata for the selected project.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div>
          <button className="btn" disabled={lookup.loading || !text.trim()}>
            Check references
          </button>
        </div>
      </form>
      <LoadState {...lookup} />
      {lookup.data && !lookup.error && (
        <div className="stack">
          {lookup.data.map((item, index) => (
            <article className="card stack" key={`${index}:${item.ref}`}>
              <div className="cluster">
                <strong className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {item.ref}
                </strong>
                <StatusPill value={item.status} />
              </div>
              {item.label && <p style={{ overflowWrap: 'anywhere' }}>{item.label}</p>}
              {item.state && (
                <p>
                  State: <StatusPill value={item.state} />
                  {item.revision !== undefined && ` · revision ${item.revision}`}
                </p>
              )}
              {item.hash && (
                <p className="mono faint" style={{ overflowWrap: 'anywhere' }}>
                  {item.hash}
                </p>
              )}
              {item.status === 'unpublished' && <p>No published Reflection is available.</p>}
              {item.status === 'missing' && (
                <p>This record is not available in the selected project.</p>
              )}
              {item.status === 'unsupported' && <p>This reference kind is not supported.</p>}
              {item.capture && (
                <>
                  <p>
                    Exact capture from session <ObjId id={item.capture.provenance.sessionId} />,
                    work item <ObjId id={item.capture.provenance.instanceId} />, revision{' '}
                    {item.capture.provenance.revision}.
                  </p>
                  {item.capture.workspace?.headOid && (
                    <p className="mono" style={{ overflowWrap: 'anywhere' }}>
                      Commit: {item.capture.workspace.headOid}
                    </p>
                  )}
                  {item.capture.workspace?.treeOid && (
                    <p className="mono" style={{ overflowWrap: 'anywhere' }}>
                      Tree: {item.capture.workspace.treeOid}
                    </p>
                  )}
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function KnowledgeView({ row }: ViewProps) {
  const records = useTool<Records>('project.records', {}, { every: 10000 });
  const inventory = records.data
    ? [
        ...records.data.claims.map((claim) => ({
          id: claim.id,
          name: claim.statement,
          kind: 'Claim',
          state: claim.status,
          revision: claim.revision,
          path: '/claims',
        })),
        ...records.data.tasks.map((task) => ({
          id: task.id,
          name: task.title,
          kind: 'Task',
          state: task.workflow.state,
          revision: task.workflow.revision,
          path: `/tasks/${task.id}`,
        })),
        ...records.data.experiments.map((experiment) => ({
          id: experiment.id,
          name: experiment.name,
          kind: 'Experiment',
          state: experiment.workflow.state,
          revision: experiment.workflow.revision,
          path: `/experiments/${experiment.id}`,
        })),
      ]
    : [];
  return (
    <div className="page-stage stack stack--lg">
      <PageHeader
        title={row.label}
        summary="All claims, tasks and experiments in this project, including completed and closed work."
      />
      <LoadState {...records} />
      {records.data && !records.error && (
        <>
          <section className="stack">
            <h2 className="section-title">Project Introduction</h2>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {records.data.project.summary || 'No Introduction has been set.'}
            </p>
          </section>
          <section className="stack">
            <h2 className="section-title">Research inventory</h2>
            <p className="faint">
              {records.data.claims.length} claims · {records.data.tasks.length} tasks ·{' '}
              {records.data.experiments.length} experiments
            </p>
            {inventory.length ? (
              <Table
                rows={inventory}
                keyOf={(item) => item.id}
                columns={[
                  { key: 'kind', label: 'Kind', render: (item) => item.kind },
                  {
                    key: 'name',
                    label: 'Record',
                    render: (item) => (
                      <div className="stack">
                        <Link to={item.path}>{item.name}</Link>
                        <ObjId id={item.id} />
                      </div>
                    ),
                  },
                  {
                    key: 'state',
                    label: 'State',
                    render: (item) => <StatusPill value={item.state} />,
                  },
                  { key: 'revision', label: 'Revision', render: (item) => item.revision },
                ]}
              />
            ) : (
              <p className="empty">No research records yet.</p>
            )}
          </section>
          <section className="stack">
            <h2 className="section-title">Published Reflection</h2>
            <p>
              No published Reflection is available. This inventory shows source records; it does not
              establish that they have been reviewed together.
            </p>
          </section>
        </>
      )}
      <ReferenceLookup />
    </div>
  );
}
