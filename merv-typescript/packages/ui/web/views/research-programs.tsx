import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ProcessGraph } from '@merv/contracts/workflow-guidance';
import { useTool } from '../api';
import { useCommand } from '../mutations';
import { useScopeKey, useSession } from '../session';
import {
  Ago,
  Failure,
  Field,
  KV,
  LoadState,
  OpenedForm,
  RecordPage,
  Ruled,
  Short,
  Stamp,
  StatusPill,
  Submit,
  Summary,
  col,
  cx,
  timeRows,
  useArtifacts,
  words,
} from '../components';
import { Gate, RowDiagram } from '../process';
import { ListPage, splitRoutes, useListFilter } from '../list-filters';
import { Markdown, RecordText, useRecordNames } from '../markdown';
import { RecordPicker, filePick, useWorkPicks, type Pickable } from '../record-picker';
import { ThreeStates } from '../states';
import { useActorNames } from './people';
import { ReviewSummary } from './reviews';
import type { ShellData } from '../shell-types';
import type { ViewProps } from './index';

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
interface FrozenSource {
  corpus: {
    id: string;
    createdAt: string;
    manifestHash: string;
    selection: {
      project: { name: string };
      experiments: { id: string; name: string; workflow: Workflow }[];
      tasks: { id: string; title: string; workflow: Workflow }[];
      claims?: { id: string; statement: string; status: string }[];
      artifacts: (
        { id: string; status: 'retained'; artifact: Artifact } | { id: string; status: 'missing' }
      )[];
    };
  } | null;
  paper: {
    documents: Record<
      string,
      { current: { revision: number; sections: { id: string; title: string; content: string }[] } }
    >;
    citations: { id: string; title: string; year: number | null; identifier: string }[];
  } | null;
}
interface Reflection extends FrozenSource {
  experimentIds: string[];
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
interface ConsolidationSubmission {
  id: string;
  revision: number;
  createdAt: string;
  reviewId: string;
  report: Artifact;
  evidence: Artifact[];
  decisions: { experimentId: string; decision: string; rationale: string }[];
  proposal: {
    id: string;
    summary: string;
    receipt: { headOid: string; baseOid: string };
    manifestArtifact: Artifact;
  } | null;
}
interface ConsolidationRecord {
  id: string;
  name: string;
  createdAt: string;
  workspace: 'none' | 'git';
  workflow: Workflow;
  sources: Artifact[];
  experimentIds: string[];
  submissions: ConsolidationSubmission[];
  completion: {
    submissionId: string;
    reviewId: string;
    completedAt: string;
    centralGit: 'not-published' | 'not-applicable';
  } | null;
}

type Lens = Reflection['lenses'][number];
type Decision = ConsolidationSubmission['decisions'][number];

/** One band of the frozen snapshot: a heading over its list, or nothing at all. */
function Band({ title, items }: { title: string; items: ReactNode[] }) {
  if (!items.length) return null;
  return (
    <div className="stack">
      <h3>{title}</h3>
      <ul>{items}</ul>
    </div>
  );
}

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

function FrozenSources({ source }: { source: Pick<Reflection, 'corpus' | 'paper'> }) {
  const { corpus, paper } = source;
  // A wave that froze nothing reads the live project, which the rail already leads to.
  if (!corpus || !paper) return null;
  return (
    <>
      <h3 className="ev-role">Frozen sources</h3>
      <p>
        {corpus.selection.experiments.length} experiments · {corpus.selection.tasks.length} tasks ·{' '}
        <Stamp at={corpus.createdAt} />
      </p>
      <details className="stack">
        <Summary>Research snapshot</Summary>
        <KV
          rows={[
            ['Source hash', <Short value={corpus.manifestHash} />],
            ['Project', corpus.selection.project.name],
          ]}
        />
        <Band
          title="Experiments"
          items={corpus.selection.experiments.map((experiment) => (
            <li key={experiment.id}>
              <Link to={`/experiments/${experiment.id}`}>{experiment.name}</Link> ·{' '}
              {experiment.workflow.state}
            </li>
          ))}
        />
        <Band
          title="Tasks"
          items={corpus.selection.tasks.map((task) => (
            <li key={task.id}>
              <Link to={`/tasks/${task.id}`}>{task.title}</Link> · {task.workflow.state}
            </li>
          ))}
        />
        <Band
          title="Archived claims at capture"
          items={(corpus.selection.claims ?? []).map((claim) => (
            <li key={claim.id}>
              {claim.statement} · {claim.status}
            </li>
          ))}
        />
        <Band
          title="Exact evidence"
          items={corpus.selection.artifacts.map((entry) => (
            <li key={entry.id}>
              {entry.status === 'retained' ? (
                <EvidenceLink artifact={entry.artifact} />
              ) : (
                'Unavailable at capture'
              )}
            </li>
          ))}
        />
      </details>
      <details className="stack">
        <Summary>Paper at capture</Summary>
        {/* A document nothing was written in by then is not drawn, nor a section left blank. */}
        {Object.entries(paper.documents)
          .filter(([, document]) => document.current.sections.length)
          .map(([kind, document]) => (
            <section key={kind} className="stack">
              <h3>
                {kind === 'problem' ? 'Problem and scope' : kind[0]!.toUpperCase() + kind.slice(1)}
              </h3>
              {document.current.sections.map((section) => (
                <div key={section.id}>
                  <strong>{section.title}</strong>
                  {section.content && <Markdown source={section.content} />}
                </div>
              ))}
            </section>
          ))}
        {paper.citations.length > 0 && (
          <h3>
            References <span className="section-n">{paper.citations.length}</span>
          </h3>
        )}
        {paper.citations.length > 0 && (
          <ul>
            {paper.citations.map((citation) => (
              <li key={citation.id}>
                {citation.title}{' '}
                <span className="faint">
                  {citation.year ?? ''} · {citation.identifier}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </>
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
    <form className="card stack claims-form" onSubmit={submit} aria-label="New reflection">
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

/** One phase of a wave: the reflection itself, and the consolidation it led to. */
interface Phase {
  id: string;
  kind: 'reflections' | 'consolidation';
  name: string;
  state: string;
  flow: Workflow;
  to: string;
  meta: ReactNode;
}

/**
 * The reflection waves, each followed by the consolidation that carries it into
 * code. A consolidation no wave names is still listed, at the end, never hidden.
 */
function ReflectionList({ shell }: { shell: ShellData }) {
  const list = useTool<Reflection[]>('reflection.list', {}, { every: 8000 });
  const { actor } = useSession();
  const navigate = useNavigate();
  // The list is mounted from both rows, so it asks the shell where the waves live.
  const waves = shell.rows.find((entry) => entry.view.kind === 'reflections')?.path ?? REFLECTIONS;
  const consolidationRow = shell.rows.find((entry) => entry.view.kind === 'consolidation');
  const works = useTool<ConsolidationRecord[]>(
    consolidationRow ? 'consolidation.list' : null,
    {},
    { every: 8000 },
  );
  const phase = (record: ConsolidationRecord): Phase => ({
    id: record.id,
    kind: 'consolidation',
    name: record.name,
    state: record.workflow.state,
    flow: record.workflow,
    to: `${consolidationRow!.path}/${record.id}`,
    meta: (
      <>
        {record.workspace === 'git' ? 'Git' : 'Research'} · {record.experimentIds.length}{' '}
        experiments · <Ago at={record.createdAt} />
      </>
    ),
  });
  // The one field that pairs them: a consolidation pins the wave's own report as a source.
  const carries = (wave: Reflection) =>
    wave.report &&
    (works.data ?? []).find((record) =>
      record.sources.some((source) => source.id === wave.report!.id),
    );
  const paired = new Set<string>();
  const items: Phase[] = (list.data ?? []).flatMap((wave) => {
    const next = carries(wave);
    if (next) paired.add(next.id);
    return [
      {
        id: wave.id,
        kind: 'reflections' as const,
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
      },
      ...(next ? [phase(next)] : []),
    ];
  });
  const rest = (works.data ?? []).filter((record) => !paired.has(record.id)).map(phase);
  const filter = useListFilter([...items, ...rest], {
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
  const consolidationRow = shell.rows.find((entry) => entry.view.kind === 'consolidation');
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
      act={
        <WaveGate id={wave.id} kind={row.view.kind}>
          {wave.workflow.state === 'approved' &&
            consolidationRow &&
            (actor.role === 'operator' || actor.role === 'producer') && (
              <NewConsolidation wave={wave} path={consolidationRow.path} />
            )}
        </WaveGate>
      }
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
        (wave.review || (wave.corpus && wave.paper)) && (
          <>
            {wave.review && (
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
            )}
            <FrozenSources source={wave} />
          </>
        )
      }
    />
  );
}

/** One option an id, in the order given, the first naming of it kept. */
const unique = (options: Pickable[]) => {
  const seen = new Set<string>();
  return options.filter((option) => !seen.has(option.id) && seen.add(option.id));
};

/** Everything an approved wave hands its consolidation, read from the wave itself. */
export const outputsOf = (wave: Reflection) => ({
  files: [
    wave.report,
    wave.changeSpec,
    ...wave.lenses.map((lens) => lens.artifact),
    ...(wave.corpus?.selection.artifacts ?? []).map((item) =>
      item.status === 'retained' ? item.artifact : null,
    ),
  ]
    .filter((artifact): artifact is Artifact => !!artifact)
    .map(filePick),
  experiments:
    wave.experimentIds ?? wave.corpus?.selection.experiments.map((item) => item.id) ?? [],
  wave: {
    id: wave.id,
    name: wave.title,
    kind: 'reflections',
    state: wave.workflow.state,
  } satisfies Pickable,
});

/**
 * Every field that names a record is a picker over the records of that kind, opened
 * on what the wave itself hands over: its files, the experiments it read, and the
 * wave as the one thing the consolidation waits on. The tool is still sent ids.
 */
export function CreateConsolidation({
  from,
  onCreated,
  onCancel,
}: {
  from: ReturnType<typeof outputsOf>;
  onCreated: (record: ConsolidationRecord) => void;
  onCancel: () => void;
}) {
  const [sources, setSources] = useState(() => unique(from.files).map((item) => item.id));
  const [experiments, setExperiments] = useState(from.experiments);
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState<'none' | 'git'>('none');
  const [dependsOn, setDependsOn] = useState([from.wave.id]);
  const artifacts = useArtifacts();
  // A decision may be about an experiment that failed, so this list leaves none out.
  const listed = useTool<{ id: string; name: string; workflow: Workflow }[]>('experiment.list');
  const work = useWorkPicks();
  const command = useCommand<ConsolidationRecord>({
    tool: 'consolidation.create',
    validate: (value) =>
      !!value && typeof value.id === 'string' && value.workflow?.workflow === 'consolidation',
    onSuccess: onCreated,
  });
  return (
    <OpenedForm
      className="card stack claims-form"
      aria-label="New consolidation"
      onClose={onCancel}
      locked={command.locked}
      onSubmit={(event) => {
        event.preventDefault();
        void command.submit({
          sourceArtifactIds: sources,
          experimentIds: experiments,
          name: name.trim(),
          workspace,
          dependsOn,
        });
      }}
    >
      <h2 className="section-title">New consolidation</h2>
      <fieldset disabled={command.locked}>
        <Field label="Name" required maxLength={200} value={name} onChange={setName} />
        <RecordPicker
          label="Source files"
          // The wave's own files are named even where the one list no longer reaches them.
          options={unique([...from.files, ...[...artifacts.values()].map(filePick)])}
          value={sources}
          onChange={setSources}
        />
        <RecordPicker
          label="Experiments requiring a decision"
          options={(listed.data ?? []).map((item) => ({
            id: item.id,
            name: item.name,
            kind: 'experiments',
            state: item.workflow.state,
          }))}
          loading={listed.loading}
          value={experiments}
          onChange={setExperiments}
        />
        <label>
          Work environment
          <select
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value as 'none' | 'git')}
          >
            <option value="none">Research report and decisions</option>
            <option value="git">Git workspace for code changes</option>
          </select>
        </label>
        <RecordPicker
          label="Prerequisites"
          options={unique([from.wave, ...work.options])}
          loading={work.loading}
          value={dependsOn}
          onChange={setDependsOn}
        />
      </fieldset>
      <Failure message={command.error} />
      <div className="cluster">
        <Submit
          busy={command.busy}
          retry={command.retry}
          saving="Starting…"
          disabled={!sources.length || !name.trim()}
        />
        <button type="button" className="btn" disabled={command.busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </OpenedForm>
  );
}

/**
 * The last phase a wave can open, offered where every other move is: the record's
 * Act slot, once the reflection is approved, carrying the wave's own outputs.
 */
function NewConsolidation({ wave, path }: { wave: Reflection; path: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  if (!open)
    return (
      <div>
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          New consolidation
        </button>
      </div>
    );
  return (
    <CreateConsolidation
      from={outputsOf(wave)}
      onCreated={(record) => navigate(`${path}/${record.id}`)}
      onCancel={() => setOpen(false)}
    />
  );
}

function Submission({ submission }: { submission: ConsolidationSubmission }) {
  // One list names every experiment a decision is about; an unnamed one shows no link text.
  const experiments = useTool<{ id: string; name: string }[]>('experiment.list');
  const named = new Map((experiments.data ?? []).map((item) => [item.id, item.name]));
  // What an agent wrote may point at a record; it says its name, and asks only if it does.
  const names = useRecordNames(
    [...submission.decisions.map((item) => item.rationale), submission.proposal?.summary].join(
      '\n',
    ),
  );
  return (
    <div className="stack">
      <KV
        rows={[
          ['Submitted', <Stamp at={submission.createdAt} />],
          ['Report', <EvidenceLink artifact={submission.report} />],
          ['Review', <Link to={`/reviews/${submission.reviewId}`}>Open the review</Link>],
        ]}
      />
      {submission.decisions.length > 0 && (
        <Ruled
          label="Decisions"
          template="minmax(0, 1fr) 140px minmax(0, 2fr)"
          rows={submission.decisions}
          keyOf={(decision) => decision.experimentId}
          columns={[
            col<Decision>('experiment', 'Experiment', (decision) => (
              <Link to={`/experiments/${decision.experimentId}`}>
                {named.get(decision.experimentId)}
              </Link>
            )),
            col<Decision>('decision', 'Decision', (decision) =>
              decision.decision.replaceAll('_', ' '),
            ),
            col<Decision>('rationale', 'Rationale', (decision) => (
              <span className="prose">
                <RecordText text={decision.rationale} names={names} />
              </span>
            )),
          ]}
        />
      )}
      {submission.evidence.length > 0 && (
        <ul>
          {submission.evidence.map((artifact) => (
            <li key={artifact.id}>
              <EvidenceLink artifact={artifact} />
            </li>
          ))}
        </ul>
      )}
      {submission.proposal && (
        <div className="stack">
          <h3 className="ev-role">Sealed code proposal</h3>
          <p>
            <RecordText text={submission.proposal.summary} names={names} />
          </p>
          <KV
            rows={[
              ['Head', <Short value={submission.proposal.receipt.headOid} />],
              ['Base', <Short value={submission.proposal.receipt.baseOid} />],
              ['Manifest', <EvidenceLink artifact={submission.proposal.manifestArtifact} />],
            ]}
          />
        </div>
      )}
    </div>
  );
}

function ConsolidationDetail({ shell }: ViewProps) {
  const reflections = shell.rows.find((entry) => entry.view.kind === 'reflections');
  const back = reflections?.path ?? REFLECTIONS;
  const { id = '' } = useParams();
  const data = useTool<ConsolidationRecord>(
    'consolidation.get',
    { consolidationId: id },
    { every: 8000 },
  );
  const record = data.error ? undefined : data.data;
  const latest = record?.completion
    ? record.submissions.find((submission) => submission.id === record.completion!.submissionId)
    : record?.submissions.at(-1);
  const centralGit =
    record?.completion?.centralGit ??
    (record?.workspace === 'none' ? 'not-applicable' : 'not-published');
  if (!record)
    return (
      <div className="page-stage">
        <LoadState {...data} back={{ to: back, label: 'Reflections' }} />
      </div>
    );
  return (
    <RecordPage
      back={<Link to={back}>← Reflections</Link>}
      kind="consolidation"
      name={record.name}
      standing={record.workspace === 'git' ? 'Git workspace' : 'Research consolidation'}
      state={<StatusPill value={record.workflow.state} />}
      act={<WaveGate id={record.id} kind="consolidation" />}
      title="Synthesis"
      content={
        latest ? (
          <>
            <h3 className="ev-role">
              {record.completion
                ? 'Approved decisions and evidence'
                : 'Submitted decisions and evidence'}
            </h3>
            <Submission submission={latest} />
          </>
        ) : undefined
      }
      history={
        record.submissions.length > 1 ? (
          <details className="stack">
            <Summary>Previous submissions ({record.submissions.length - 1})</Summary>
            {record.submissions
              .slice(0, -1)
              .reverse()
              .map((submission) => (
                <div className="stack" key={submission.id}>
                  <Submission submission={submission} />
                </div>
              ))}
          </details>
        ) : undefined
      }
      // The approving review is already the link beside the submission it approved.
      related={
        <>
          <h3 className="ev-role">Source files</h3>
          <ul>
            {record.sources.map((artifact) => (
              <li key={artifact.id}>
                <EvidenceLink artifact={artifact} />
              </li>
            ))}
          </ul>
        </>
      }
      details={
        <KV
          rows={[
            ['Central Git', <StatusPill value={centralGit} />],
            ...timeRows(record.createdAt, record.workflow.updatedAt),
            !!record.completion && ['Completed', <Stamp at={record.completion.completedAt} />],
          ]}
        />
      }
    />
  );
}

const ReflectionRoutes = splitRoutes(ReflectionList, ReflectionDetail);
// The consolidation is the last phase of a wave, so it opens beside the waves.
const ConsolidationRoutes = splitRoutes(ReflectionList, ConsolidationDetail, REFLECTIONS);
export const ReflectionsView = (props: ViewProps) => (
  <ReflectionRoutes key={useScopeKey()} {...props} />
);
export const ConsolidationView = (props: ViewProps) => (
  <ConsolidationRoutes key={useScopeKey()} {...props} />
);
