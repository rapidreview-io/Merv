import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTool } from '../api';
import {
  Ago,
  Failure,
  Field,
  KV,
  LoadState,
  RecordPage,
  Ruled,
  StatusPill,
  Submit,
  Summary,
  col,
  cx,
  words,
} from '../components';
import { ListPage, splitRoutes, useListFilter } from '../list-filters';
import { useCommand } from '../mutations';
import { Gate, RowDiagram } from '../process';
import { useScopeKey, useSession } from '../session';
import type { ShellData } from '../shell-types';
import { ThreeStates } from '../states';
import type { ViewProps } from './index';
import { useActorNames } from './people';
import { ReviewSummary } from './reviews';

/** Where the waves live when no row says otherwise, as the plugin registers them. */
const REFLECTIONS = '/reflections';

// Browser read models intentionally omit server services and authentication types.
interface Artifact {
  id: string;
  title: string;
  hash: string;
}
interface Workflow {
  workflow: string;
  state: string;
  revision: number;
  updatedAt?: string;
}
interface Reflection {
  id: string;
  title: string;
  attempt: number;
  createdAt: string;
  workflow: Workflow;
  lenses: {
    id: string;
    perspective: string;
    instructions: string;
    workflow: Workflow;
    producerId: string | null;
    artifact: Artifact | null;
  }[];
  report: Artifact | null;
  changeSpec: Artifact | null;
  review: {
    id: string;
    status: string;
    verdict: string | null;
    synopsis: string | null;
    reviewerId: string | null;
    returnTo?: string;
  } | null;
}
type Lens = Reflection['lenses'][number];

function EvidenceLink({ artifact }: { artifact: Artifact }) {
  return (
    <Link to={`/artifacts/${artifact.id}`} title={`${artifact.id}\nSHA-256 ${artifact.hash}`}>
      {artifact.title}
    </Link>
  );
}

/** The gate this wave stands at, derived from its own record. */
function WaveGate({ id, kind, children }: { id: string; kind: string; children?: ReactNode }) {
  const process = useTool<ProcessGraph>('workflow.process', { instanceId: id }, { every: 8000 });
  return (
    <Gate graph={process.error ? undefined : process.data} kind={kind}>
      {children}
    </Gate>
  );
}

function CreateReflection({ onCreated }: { onCreated: (wave: Reflection) => void }) {
  const [title, setTitle] = useState('');
  const command = useCommand<Reflection>({
    tool: 'reflection.create',
    validate: (value) =>
      !!value && typeof value.id === 'string' && value.workflow?.workflow === 'reflection',
    onSuccess: onCreated,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void command.submit(title.trim() ? { title: title.trim() } : {});
  };
  return (
    <form className="card stack entry-form" onSubmit={submit} aria-label="New reflection">
      <h2 className="section-title">New reflection</h2>
      <fieldset disabled={command.locked}>
        <Field
          label="Title (optional)"
          maxLength={300}
          value={title}
          onChange={setTitle}
          placeholder="Project reflection"
        />
      </fieldset>
      <Failure message={command.error} />
      <div>
        <Submit busy={command.busy} retry={command.retry} saving="Starting…" />
      </div>
    </form>
  );
}

/** A reflection wave in the list. */
interface Phase {
  id: string;
  kind: 'reflections';
  name: string;
  state: string;
  flow: Workflow;
  to: string;
  meta: ReactNode;
}

/** Reflection waves; research tracks any resulting consolidation as an ordinary task. */
function ReflectionList({ shell }: { shell: ShellData }) {
  const list = useTool<Reflection[]>('reflection.list', {}, { every: 8000 });
  const { actor } = useSession();
  const navigate = useNavigate();
  // The list is mounted from both rows, so it asks the shell where the waves live.
  const waves = shell.rows.find((entry) => entry.view.kind === 'reflections')?.path ?? REFLECTIONS;
  const items: Phase[] = (list.data ?? []).map((wave) => ({
    id: wave.id,
    kind: 'reflections',
    name: wave.title,
    state: wave.workflow.state,
    flow: wave.workflow,
    to: `${waves}/${wave.id}`,
    meta: (
      <>
        {wave.lenses.filter((lens) => lens.artifact).length} of {wave.lenses.length} lenses ·{' '}
        <Ago at={wave.createdAt} />
      </>
    ),
  }));
  const filter = useListFilter(items, {
    stateOf: (item) => item.state,
    labels: (item) => [item.name],
    ids: (item) => [item.id],
  });
  return (
    <ListPage
      load={list}
      noun="reflections"
      placeholder="Title"
      filter={filter}
      emptyTitle="No reflection waves yet"
      create={{
        label: 'New reflection',
        shown: actor.role === 'producer' || actor.role === 'operator',
        form: () => <CreateReflection onCreated={(wave) => navigate(`${waves}/${wave.id}`)} />,
      }}
      line={(item) => ({
        kind: item.kind,
        name: (
          <Link className={cx('row-link', item.id === filter.openId && 'row-open')} to={item.to}>
            <strong>{item.name}</strong>
          </Link>
        ),
        standing: (
          <ThreeStates
            execution={item.state}
            diagram={<RowDiagram shapes={shell.workflows} workflow={item.flow} kind={item.kind} />}
            meta={item.meta}
          />
        ),
      })}
    />
  );
}

function ReflectionDetail({ row, shell }: ViewProps) {
  const { id = '' } = useParams();
  const { actor } = useSession();
  const data = useTool<Reflection>('reflection.get', { reflectionId: id }, { every: 8000 });
  const nameOf = useActorNames();
  const wave = data.error ? undefined : data.data;
  if (!wave)
    return (
      <div className="page-stage">
        <LoadState {...data} back={{ to: row.path, label: row.label }} />
      </div>
    );
  return (
    <RecordPage
      back={<Link to={row.path}>← {row.label}</Link>}
      kind={row.view.kind}
      name={wave.title}
      state={<StatusPill value={wave.workflow.state} />}
      act={<WaveGate id={wave.id} kind={row.view.kind} />}
      // The section is the synthesis once there is one; until then it is only its lenses.
      title={wave.report ? 'Synthesis' : 'Perspectives'}
      content={
        <>
          {wave.report && <h3 className="ev-role">Independent perspectives</h3>}
          <Ruled
            label="Perspectives"
            template="minmax(0, 1.6fr) 120px minmax(0, 1fr) minmax(0, 1.4fr)"
            rows={wave.lenses}
            keyOf={(lens) => lens.id}
            columns={[
              col<Lens>('lens', 'Perspective', (lens) => (
                <details>
                  <Summary>{lens.perspective.replaceAll('_', ' ')}</Summary>
                  <p>{lens.instructions}</p>
                </details>
              )),
              col<Lens>('state', 'State', (lens) => <StatusPill value={lens.workflow.state} />),
              col<Lens>('producer', 'Contributor', (lens) => nameOf(lens.producerId)),
              col<Lens>('report', 'Report', (lens) =>
                lens.artifact ? <EvidenceLink artifact={lens.artifact} /> : null,
              ),
            ]}
          />
          {wave.report && (
            <KV
              rows={[
                ['Report', <EvidenceLink artifact={wave.report} />],
                !!wave.changeSpec && [
                  'Change specification',
                  <EvidenceLink artifact={wave.changeSpec} />,
                ],
              ]}
            />
          )}
        </>
      }
      related={
        wave.review && (
          <>
            <h3 className="ev-role">Review</h3>
            <ReviewSummary review={wave.review} />
            {(nameOf(wave.review.reviewerId) || wave.review.returnTo) && (
              <p className="muted">
                {[
                  nameOf(wave.review.reviewerId),
                  wave.review.returnTo && `Returned to ${words(wave.review.returnTo)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </>
        )
      }
    />
  );
}

const ReflectionRoutes = splitRoutes(ReflectionList, ReflectionDetail);
export const ReflectionsView = (props: ViewProps) => (
  <ReflectionRoutes key={useScopeKey()} {...props} />
);
