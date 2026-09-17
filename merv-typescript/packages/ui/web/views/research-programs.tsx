import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ProcessGraph, WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useTool } from '../api';
import { useCommand } from '../mutations';
import { useScopeKey, useSession } from '../session';
import {
  Ago,
  Area,
  Failure,
  Field,
  GateBox,
  KV,
  LoadState,
  RecordPage,
  StatusPill,
  Table,
  col,
  cx,
  relativeTime,
  stamp,
  words,
} from '../components';
import { ListPage, splitRoutes, useListFilter } from '../list-filters';
import { WORK } from '../navigation';
import { ThreeStates } from '../states';
import { useActorNames } from './people';
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
      claims: { id: string; statement: string; status: string }[];
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

/**
 * The ladder the program actually declares, as rungs of text: one rung per state in
 * reading order, the rung it stands on named, a rung it came back to said plainly. A
 * rung records that the machinery stepped through a gate, never that the work is right.
 */
function Ladder({ id }: { id: string }) {
  const process = useTool<ProcessGraph>('workflow.process', { instanceId: id }, { every: 8000 });
  if (!process.data || process.error) return null;
  return (
    <>
      <h3 className="ev-role">How it got here</h3>
      <ol className="ladder">
        {process.data.nodes.map((node) => (
          <li key={node.state} className={cx('ladder-rung', node.current && 'ladder-rung--here')}>
            <span>{words(node.state)}</span>
            <span className="muted">
              {[
                node.current ? 'where it stands now' : null,
                node.entries > 1
                  ? `entered ${node.entries} times`
                  : node.firstEnteredAt
                    ? `entered ${relativeTime(node.firstEnteredAt)}`
                    : 'not entered',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Guidance({ id }: { id: string }) {
  const guidance = useTool<WorkflowDecision>(
    'workflow.status_and_next',
    { instanceId: id },
    { every: 8000 },
  );
  return (
    <>
      <LoadState {...guidance} />
      {guidance.data && !guidance.error && <GateBox decision={guidance.data} />}
    </>
  );
}

function FrozenSources({ source }: { source: Pick<Reflection, 'corpus' | 'paper'> }) {
  const { corpus, paper } = source;
  if (!corpus || !paper)
    return (
      <>
        <h3 className="ev-role">Live research</h3>
        <div className="cluster">
          <Link to={WORK.path}>Browse the wave of work</Link>
          <Link to="/paper">Read the living paper</Link>
        </div>
      </>
    );
  return (
    <>
      <h3 className="ev-role">Frozen sources</h3>
      <p>
        {corpus.selection.experiments.length} experiments · {corpus.selection.tasks.length} tasks ·{' '}
        {corpus.selection.claims.length} claims. Captured {stamp(corpus.createdAt)}.
      </p>
      <details className="stack">
        <summary>Inspect the research snapshot</summary>
        <KV
          rows={[
            ['Source hash', <span className="mono wrap">{corpus.manifestHash}</span>],
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
          title="Claims at capture"
          items={corpus.selection.claims.map((claim) => (
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
        <summary>Living paper at capture</summary>
        {Object.entries(paper.documents).map(([kind, document]) => (
          <section key={kind} className="stack">
            <h3>
              {kind === 'problem' ? 'Problem and scope' : kind[0]!.toUpperCase() + kind.slice(1)} ·
              revision {document.current.revision}
            </h3>
            {document.current.sections.length ? (
              document.current.sections.map((section) => (
                <div key={section.id}>
                  <strong>{section.title}</strong>
                  <p className="prose">{section.content || 'No content at capture.'}</p>
                </div>
              ))
            ) : (
              <p className="faint">No sections at capture.</p>
            )}
          </section>
        ))}
        <p>{paper.citations.length} pinned literature references.</p>
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
          className="input"
          maxLength={300}
          value={title}
          onChange={setTitle}
          placeholder="Project reflection"
        />
      </fieldset>
      <Failure message={command.error} />
      <div>
        <button className="btn btn--primary" disabled={command.busy}>
          {command.busy ? 'Starting…' : command.retry ? 'Retry same request' : 'New reflection'}
        </button>
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
        to: `${waves}/${wave.id}`,
        meta: (
          <>
            {wave.lenses.filter((lens) => lens.artifact).length} of {wave.lenses.length} lenses ·
            attempt {wave.attempt} · <Ago at={wave.createdAt} />
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
        standing: <ThreeStates execution={item.state} meta={item.meta} />,
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
      standing={`Attempt ${wave.attempt} · workflow revision ${wave.workflow.revision}`}
      state={<StatusPill value={wave.workflow.state} />}
      act={
        <>
          <Guidance id={wave.id} />
          {wave.workflow.state === 'approved' &&
            consolidationRow &&
            (actor.role === 'operator' || actor.role === 'producer') && (
              <NewConsolidation wave={wave} path={consolidationRow.path} />
            )}
        </>
      }
      title="Synthesis"
      content={
        <>
          <h3 className="ev-role">Independent perspectives</h3>
          <Table
            rows={wave.lenses}
            keyOf={(lens) => lens.id}
            columns={[
              col<Lens>('lens', 'Perspective', (lens) => (
                <details>
                  <summary>{lens.perspective.replaceAll('_', ' ')}</summary>
                  <p>{lens.instructions}</p>
                </details>
              )),
              col<Lens>('state', 'State', (lens) => <StatusPill value={lens.workflow.state} />),
              col<Lens>('producer', 'Contributor', (lens) =>
                lens.producerId ? nameOf(lens.producerId) : 'Awaiting submission',
              ),
              col<Lens>('report', 'Pinned report', (lens) =>
                lens.artifact ? <EvidenceLink artifact={lens.artifact} /> : 'Not submitted',
              ),
            ]}
          />
          <h3 className="ev-role">Synthesis</h3>
          {wave.report && (
            <KV
              rows={[
                ['Report', <EvidenceLink artifact={wave.report} />],
                [
                  'Change specification',
                  wave.changeSpec ? <EvidenceLink artifact={wave.changeSpec} /> : 'Not submitted',
                ],
              ]}
            />
          )}
        </>
      }
      history={<Ladder id={wave.id} />}
      related={
        <>
          {wave.review && (
            <>
              <h3 className="ev-role">Independent review</h3>
              <div className="cluster">
                <Link to={`/reviews/${wave.review.id}`}>Open independent review</Link>
                <StatusPill value={wave.review.status} />
                <StatusPill value={wave.review.verdict} />
              </div>
              {wave.review.synopsis && <p>{wave.review.synopsis}</p>}
              {nameOf(wave.review.reviewerId) && (
                <p className="faint">Reviewer: {nameOf(wave.review.reviewerId)}</p>
              )}
              {wave.review.returnTo && (
                <p>Return to: {wave.review.returnTo.replaceAll('_', ' ')}</p>
              )}
            </>
          )}
          <FrozenSources source={wave} />
        </>
      }
    />
  );
}

/** Everything an approved wave hands its consolidation, read from the wave itself. */
const outputsOf = (wave: Reflection) => ({
  sources: [
    wave.report?.id,
    wave.changeSpec?.id,
    ...wave.lenses.map((lens) => lens.artifact?.id),
    ...(wave.corpus?.selection.artifacts ?? []).map((item) =>
      item.status === 'retained' ? item.artifact.id : undefined,
    ),
  ]
    .filter(Boolean)
    .join(' '),
  experiments: (
    wave.experimentIds ??
    wave.corpus?.selection.experiments.map((item) => item.id) ??
    []
  ).join(' '),
  dependsOn: wave.id,
});

function CreateConsolidation({
  from,
  onCreated,
}: {
  from: ReturnType<typeof outputsOf>;
  onCreated: (record: ConsolidationRecord) => void;
}) {
  const [sources, setSources] = useState(from.sources);
  const [experiments, setExperiments] = useState(from.experiments);
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState<'none' | 'git'>('none');
  const [dependsOn, setDependsOn] = useState(from.dependsOn);
  const command = useCommand<ConsolidationRecord>({
    tool: 'consolidation.create',
    validate: (value) =>
      !!value && typeof value.id === 'string' && value.workflow?.workflow === 'consolidation',
    onSuccess: onCreated,
  });
  return (
    <form
      className="card stack claims-form"
      aria-label="New consolidation"
      onSubmit={(event) => {
        event.preventDefault();
        void command.submit({
          sourceArtifactIds: [...new Set(sources.split(/\s+/).filter(Boolean))],
          experimentIds: [...new Set(experiments.split(/\s+/).filter(Boolean))],
          name: name.trim(),
          workspace,
          dependsOn: [...new Set(dependsOn.split(/\s+/).filter(Boolean))],
        });
      }}
    >
      <h2 className="section-title">New consolidation</h2>
      <fieldset disabled={command.locked}>
        <Area
          label="Source artifact IDs"
          required
          className="textarea mono"
          rows={3}
          value={sources}
          onChange={setSources}
          placeholder="One retained artifact ID per line"
        />
        <Area
          label="Experiment IDs requiring a decision"
          className="textarea mono"
          rows={2}
          value={experiments}
          onChange={setExperiments}
        />
        <Field
          label="Name"
          className="input"
          required
          maxLength={200}
          value={name}
          onChange={setName}
          placeholder="Consolidate the approved findings"
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
        <Area
          label="Additional prerequisite workflow IDs (optional)"
          className="textarea mono"
          rows={2}
          maxLength={20000}
          value={dependsOn}
          onChange={setDependsOn}
          placeholder="One ID per line"
        />
      </fieldset>
      <Failure message={command.error} />
      <div>
        <button
          className="btn btn--primary"
          disabled={command.busy || !sources.trim() || !name.trim()}
        >
          {command.busy ? 'Starting…' : command.retry ? 'Retry same request' : 'New consolidation'}
        </button>
      </div>
    </form>
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
    />
  );
}

function Submission({ submission }: { submission: ConsolidationSubmission }) {
  // One list names every experiment a decision is about; an unnamed one shows no link text.
  const experiments = useTool<{ id: string; name: string }[]>('experiment.list');
  const named = new Map((experiments.data ?? []).map((item) => [item.id, item.name]));
  return (
    <div className="stack">
      <KV
        rows={[
          ['Submitted', stamp(submission.createdAt)],
          ['Report', <EvidenceLink artifact={submission.report} />],
          ['Review', <Link to={`/reviews/${submission.reviewId}`}>Open the review</Link>],
        ]}
      />
      {submission.decisions.length ? (
        <Table
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
              <span className="prose">{decision.rationale}</span>
            )),
          ]}
        />
      ) : (
        <p className="faint">No experiments were selected for consolidation decisions.</p>
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
          <p>{submission.proposal.summary}</p>
          <KV
            rows={[
              [
                'Exact head',
                <span className="mono wrap">{submission.proposal.receipt.headOid}</span>,
              ],
              ['Base', <span className="mono wrap">{submission.proposal.receipt.baseOid}</span>],
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
      standing={`Workflow revision ${record.workflow.revision} · ${record.workspace === 'git' ? 'Git workspace' : 'Research consolidation'}`}
      state={<StatusPill value={record.workflow.state} />}
      act={<Guidance id={record.id} />}
      title="Synthesis"
      content={
        <>
          <h3 className="ev-role">
            {record.completion
              ? 'Approved decisions and evidence'
              : 'Submitted decisions and evidence'}
          </h3>
          {latest ? (
            <Submission submission={latest} />
          ) : (
            <p className="faint">
              The assigned producer has not submitted a consolidation report yet.
            </p>
          )}
        </>
      }
      history={
        <>
          <Ladder id={record.id} />
          {record.submissions.length > 1 && (
            <details className="stack">
              <summary>Previous submissions ({record.submissions.length - 1})</summary>
              {record.submissions
                .slice(0, -1)
                .reverse()
                .map((submission) => (
                  <div className="stack" key={submission.id}>
                    <h3 className="ev-role">Revision {submission.revision}</h3>
                    <Submission submission={submission} />
                  </div>
                ))}
            </details>
          )}
        </>
      }
      related={
        <>
          <h3 className="ev-role">Retained source artifacts</h3>
          <ul>
            {record.sources.map((artifact) => (
              <li key={artifact.id}>
                <EvidenceLink artifact={artifact} />
              </li>
            ))}
          </ul>
          {record.completion && (
            <p>
              Independent consolidation review completed {stamp(record.completion.completedAt)}.{' '}
              <Link to={`/reviews/${record.completion.reviewId}`}>View approval</Link>.
            </p>
          )}
        </>
      }
      details={
        <>
          <h3 className="ev-role">Central Git status</h3>
          <p>{centralGit === 'not-applicable' ? 'Not applicable' : 'Not published'}</p>
        </>
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
