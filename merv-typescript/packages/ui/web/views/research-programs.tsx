import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTool } from '../api';
import {
  Ago,
  Failure,
  Field,
  LoadState,
  RecordPage,
  StatusPill,
  Submit,
  Summary,
  cx,
  words,
} from '../components';
import { ListPage, Tabs, splitRoutes, useListFilter } from '../list-filters';
import { useCommand } from '../mutations';
import { Gate, StageMark } from '../process';
import { useScopeKey, useSession } from '../session';
import type { ShellData } from '../shell-types';
import { ThreeStates } from '../states';
import { ArtifactBody, type Artifact } from './artifacts';
import type { ViewProps } from './index';
import { useActorNames } from './people';
import { ReviewSummary } from './reviews';

/** Where the waves live when no row says otherwise, as the plugin registers them. */
const REFLECTIONS = '/reflections';

// Browser read models intentionally omit server services and authentication types.
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

/** The gate this wave stands at, derived from its own record. */
function WaveGate({ id, children }: { id: string; children?: ReactNode }) {
  const process = useTool<ProcessGraph>('workflow.process', { instanceId: id }, { every: 8000 });
  return <Gate graph={process.error ? undefined : process.data}>{children}</Gate>;
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
            stage={<StageMark shapes={shell.workflows} workflow={item.flow} />}
            meta={item.meta}
          />
        ),
      })}
    />
  );
}

/**
 * A wave read aggregated first: its report, the synthesis, as the document it is with
 * the change specification under it, then a tab for each lens on its own — who wrote
 * it, where it stands, its report in place, and the instructions it was given. Which
 * one is open is in the address, so a reload or a link lands on it.
 */
export function ReflectionDetail({ row, shell }: ViewProps) {
  const { id = '' } = useParams();
  const data = useTool<Reflection>('reflection.get', { reflectionId: id }, { every: 8000 });
  const nameOf = useActorNames();
  const [params, setParams] = useSearchParams();
  const wave = data.error ? undefined : data.data;
  if (!wave)
    return (
      <div className="page-stage">
        <LoadState {...data} back={{ to: row.path, label: row.label }} />
      </div>
    );
  const tabs = [
    ...(wave.report ? [{ value: 'report', label: 'Report' }] : []),
    ...wave.lenses.map((lens) => ({
      value: lens.id,
      label: words(lens.perspective).replace(/^./, (first) => first.toUpperCase()),
    })),
  ];
  const open = tabs.find((tab) => tab.value === params.get('lens'))?.value ?? tabs[0]?.value;
  const lens = wave.lenses.find((item) => item.id === open);
  const choose = (value: string) => {
    const next = new URLSearchParams(params);
    next.set('lens', value);
    setParams(next, { replace: true });
  };
  return (
    <RecordPage
      back={<Link to={row.path}>← {row.label}</Link>}
      kind={row.view.kind}
      name={wave.title}
      state={<StageMark shapes={shell?.workflows} workflow={wave.workflow} />}
      act={<WaveGate id={wave.id} />}
      // Never `Synthesis`: one of the lenses is called that.
      title="Lenses"
      content={
        open && (
          <>
            <div className="tabs tabs--strip">
              <Tabs label="Lenses" options={tabs} value={open} onChange={choose} />
            </div>
            {open === 'report' && wave.report && (
              <>
                <ArtifactBody artifactId={wave.report.id} metadata={wave.report} />
                {wave.changeSpec && (
                  <>
                    <h3 className="ev-role">Change specification</h3>
                    <ArtifactBody artifactId={wave.changeSpec.id} metadata={wave.changeSpec} />
                  </>
                )}
              </>
            )}
            {lens && (
              <div className="stack" key={lens.id}>
                <p className="cluster muted">
                  {nameOf(lens.producerId) && (
                    <>
                      {nameOf(lens.producerId)}
                      <span className="ghost">·</span>
                    </>
                  )}
                  <StatusPill value={lens.workflow.state} />
                </p>
                {lens.artifact && (
                  <ArtifactBody artifactId={lens.artifact.id} metadata={lens.artifact} />
                )}
                <details className="ov-said">
                  <Summary>Instructions</Summary>
                  <p>{lens.instructions}</p>
                </details>
              </div>
            )}
          </>
        )
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
