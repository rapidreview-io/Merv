import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTool } from '../api';
import { Area, Failure, KindLabel, LoadState, StatusPill, kindOf } from '../components';
import { ListPage, useListFilter } from '../list-filters';
import { ThreeStates } from '../states';

interface Records {
  claims: { id: string; statement: string; status: string; revision: number }[];
  tasks: { id: string; title: string; workflow: { state: string; revision: number } }[];
  experiments: { id: string; name: string; workflow: { state: string; revision: number } }[];
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
      <form className="card stack claims-form" onSubmit={submit}>
        <Area
          label="Record IDs or references"
          className="textarea mono"
          rows={3}
          maxLength={40200}
          value={text}
          onChange={setText}
          placeholder="claim:claim_… artifact:art_… task:task_…"
        />
        <p className="faint">
          Use record IDs or a kind followed by an ID, such as task: or session-final:. This reads
          metadata for the selected project.
        </p>
        <Failure message={error} />
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
            <article className="record stack" key={`${index}:${item.ref}`}>
              <KindLabel kind="knowledge" />
              <div className="cluster">
                <strong className="mono wrap">{item.ref}</strong>
                <StatusPill value={item.status} />
              </div>
              {item.label && <p className="wrap">{item.label}</p>}
              {item.state && (
                <p>
                  State: <StatusPill value={item.state} />
                  {item.revision !== undefined && ` · revision ${item.revision}`}
                </p>
              )}
              {item.hash && <p className="mono faint wrap">{item.hash}</p>}
              {item.status === 'unpublished' && <p>No published Reflection is available.</p>}
              {item.status === 'missing' && (
                <p>This record is not available in the selected project.</p>
              )}
              {item.status === 'unsupported' && <p>This reference kind is not supported.</p>}
              {item.capture && (
                <>
                  <p>Exact capture at revision {item.capture.provenance.revision}.</p>
                  {item.capture.workspace?.headOid && (
                    <p className="mono wrap">Commit: {item.capture.workspace.headOid}</p>
                  )}
                  {item.capture.workspace?.treeOid && (
                    <p className="mono wrap">Tree: {item.capture.workspace.treeOid}</p>
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

export function KnowledgeView() {
  const records = useTool<Records>('project.records', {}, { every: 10000 });
  const inventory = records.data
    ? [
        ...records.data.claims.map((claim) => ({
          id: claim.id,
          name: claim.statement,
          kind: 'claims',
          state: claim.status,
          revision: claim.revision,
          path: '/claims',
        })),
        ...records.data.tasks.map((task) => ({
          id: task.id,
          name: task.title,
          kind: 'tasks',
          state: task.workflow.state,
          revision: task.workflow.revision,
          path: `/tasks/${task.id}`,
        })),
        ...records.data.experiments.map((experiment) => ({
          id: experiment.id,
          name: experiment.name,
          kind: 'experiments',
          state: experiment.workflow.state,
          revision: experiment.workflow.revision,
          path: `/experiments/${experiment.id}`,
        })),
      ]
    : [];
  const filter = useListFilter(inventory, {
    stateOf: (item) => item.state,
    labels: (item) => [item.name, kindOf(item.kind).label],
    ids: (item) => [item.id],
  });
  return (
    <ListPage
      load={records}
      noun="records"
      placeholder="Name or kind"
      filter={filter}
      emptyTitle="No research records yet"
      emptyHint="Every claim, task and experiment anyone opens in this project is listed here, closed work included."
      create={{ label: 'Check references', plain: true, form: () => <ReferenceLookup /> }}
      // A record here is read where it lives, so the row names it and its own page opens it.
      line={(item) => ({
        kind: item.kind,
        name: (
          <Link className="row-link" to={item.path}>
            {item.name}
          </Link>
        ),
        standing: <ThreeStates execution={item.state} meta={`revision ${item.revision}`} />,
      })}
    />
  );
}
