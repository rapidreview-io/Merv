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
import { ThreeStates } from '../states';
import { useActorNames } from './people';
import type { ViewProps } from './index';

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
      <p className="muted">
        A rung shows the machinery stepped through a gate; it never says the work is right.
      </p>
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
        <p>
          This wave reads current research. Existing tasks and experiments can continue; new ones
          are paused until the wave is approved.
        </p>
        <p>
          Agents retrieve evidence as needed. The assignment does not contain a copy of the project
          corpus.
        </p>
        <div className="cluster">
          <Link to="/knowledge">Browse research records</Link>
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
      <p className="faint">Later project edits do not change the evidence used by this wave.</p>
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
        <p className="faint">
          Links open the record's current view. The states and claims above are the frozen
          observations.
        </p>
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
    <form className="card stack claims-form" onSubmit={submit} aria-label="Start a reflection wave">
      <h2 className="section-title">Start a reflection wave</h2>
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
      <p className="faint">
        Open five independent lens assignments over live research. New task and experiment creation
        pauses until approval; existing work continues. One unfinished wave is allowed at a time.
      </p>
      <Failure message={command.error} />
      <div>
        <button className="btn btn--primary" disabled={command.busy}>
          {command.busy ? 'Starting…' : command.retry ? 'Retry same request' : 'Start reflection'}
        </button>
      </div>
    </form>
  );
}

function ReflectionList({ row }: ViewProps) {
  const list = useTool<Reflection[]>('reflection.list', {}, { every: 8000 });
  const { actor } = useSession();
  const navigate = useNavigate();
  const filter = useListFilter(list.data, {
    stateOf: (wave) => wave.workflow.state,
    labels: (wave) => [wave.title],
    ids: (wave) => [wave.id],
  });
  return (
    <ListPage
      load={list}
      noun="reflections"
      placeholder="Title"
      filter={filter}
      opens
      emptyTitle="No reflection waves yet"
      emptyHint="A wave gathers five independent readings of the research so far; a producer starts one here."
      create={{
        label: 'New reflection',
        shown: actor.role === 'producer' || actor.role === 'operator',
        form: () => <CreateReflection onCreated={(wave) => navigate(`${row.path}/${wave.id}`)} />,
      }}
      line={(wave) => ({
        name: <strong>{wave.title}</strong>,
        standing: (
          <ThreeStates
            execution={wave.workflow.state}
            meta={
              <>
                {wave.lenses.filter((lens) => lens.artifact).length} of {wave.lenses.length} lenses
                · attempt {wave.attempt} · <Ago at={wave.createdAt} />
              </>
            }
          />
        ),
      })}
    />
  );
}

function ReflectionDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
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
      standing={`Attempt ${wave.attempt} · workflow revision ${wave.workflow.revision}`}
      state={<StatusPill value={wave.workflow.state} />}
      act={<Guidance id={wave.id} />}
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
          {wave.report ? (
            <KV
              rows={[
                ['Report', <EvidenceLink artifact={wave.report} />],
                [
                  'Change specification',
                  wave.changeSpec ? <EvidenceLink artifact={wave.changeSpec} /> : 'Not submitted',
                ],
              ]}
            />
          ) : (
            <p className="faint">Synthesis opens after all five lenses submit their reports.</p>
          )}
          {wave.workflow.state === 'approved' && (
            <p>
              Reflection approved. Code consolidation is optional.{' '}
              <Link
                to={`/consolidation?sources=${encodeURIComponent([wave.report!.id, wave.changeSpec!.id, ...wave.lenses.flatMap((l) => (l.artifact ? [l.artifact.id] : [])), ...(wave.corpus?.selection.artifacts ?? []).flatMap((a) => (a.status === 'retained' ? [a.id] : []))].join(' '))}&experiments=${encodeURIComponent((wave.experimentIds ?? wave.corpus?.selection.experiments.map((e) => e.id) ?? []).join(' '))}&dependsOn=${encodeURIComponent(wave.id)}`}
              >
                Configure consolidation from these outputs
              </Link>
              .
              {!wave.corpus &&
                ' In a research cycle, advance Research to complete the cycle or start its selected Git consolidation with current research evidence and completed experiments.'}
            </p>
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

function CreateConsolidation({ onCreated }: { onCreated: (record: ConsolidationRecord) => void }) {
  const [sources, setSources] = useState(
    () => new URLSearchParams(window.location.search).get('sources') ?? '',
  );
  const [experiments, setExperiments] = useState(
    () => new URLSearchParams(window.location.search).get('experiments') ?? '',
  );
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState<'none' | 'git'>('none');
  const [dependsOn, setDependsOn] = useState(
    () => new URLSearchParams(window.location.search).get('dependsOn') ?? '',
  );
  const command = useCommand<ConsolidationRecord>({
    tool: 'consolidation.create',
    validate: (value) =>
      !!value && typeof value.id === 'string' && value.workflow?.workflow === 'consolidation',
    onSuccess: onCreated,
  });
  return (
    <form
      className="card stack claims-form"
      aria-label="Start consolidation"
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
      <h2 className="section-title">Start consolidation</h2>
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
      <p className="faint">
        Pins the selected source artifacts and requires a decision for every listed experiment.
        Additional prerequisites must finish successfully before work starts.
      </p>
      <Failure message={command.error} />
      <div>
        <button
          className="btn btn--primary"
          disabled={command.busy || !sources.trim() || !name.trim()}
        >
          {command.busy
            ? 'Starting…'
            : command.retry
              ? 'Retry same request'
              : 'Start consolidation'}
        </button>
      </div>
    </form>
  );
}

function ConsolidationList({ row }: ViewProps) {
  const list = useTool<ConsolidationRecord[]>('consolidation.list', {}, { every: 8000 });
  const { actor } = useSession();
  const navigate = useNavigate();
  const filter = useListFilter(list.data, {
    stateOf: (record) => record.workflow.state,
    labels: (record) => [record.name],
    ids: (record) => [record.id],
  });
  return (
    <ListPage
      load={list}
      noun="consolidations"
      placeholder="Name"
      filter={filter}
      opens
      emptyTitle="No consolidations yet"
      emptyHint="A consolidation turns approved findings into reviewed decisions; a producer starts one here."
      create={{
        label: 'New consolidation',
        shown: actor.role === 'operator' || actor.role === 'producer',
        // Arriving from an approved reflection carries the sources: open on those.
        opened: new URLSearchParams(window.location.search).has('sources'),
        form: () => <CreateConsolidation onCreated={(r) => navigate(`${row.path}/${r.id}`)} />,
      }}
      line={(record) => ({
        name: <strong>{record.name}</strong>,
        standing: (
          <ThreeStates
            execution={record.workflow.state}
            meta={
              <>
                {record.workspace === 'git' ? 'Git' : 'Research'} · {record.experimentIds.length}{' '}
                experiments · <Ago at={record.createdAt} />
              </>
            }
          />
        ),
      })}
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

function ConsolidationDetail({ row }: ViewProps) {
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
        <LoadState {...data} back={{ to: row.path, label: row.label }} />
      </div>
    );
  return (
    <RecordPage
      back={<Link to={row.path}>← {row.label}</Link>}
      kind={row.view.kind}
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
          <p>
            {centralGit === 'not-applicable'
              ? 'Not applicable — this workflow has no Git workspace.'
              : 'Not published to central Git.'}
          </p>
          {record.workspace === 'git' && (
            <p className="faint">
              The workflow retains an exact reviewed code proposal. Completing its review does not
              advance the central branch.
            </p>
          )}
        </>
      }
    />
  );
}

const ReflectionRoutes = splitRoutes(ReflectionList, ReflectionDetail);
const ConsolidationRoutes = splitRoutes(ConsolidationList, ConsolidationDetail);
export const ReflectionsView = (props: ViewProps) => (
  <ReflectionRoutes key={useScopeKey()} {...props} />
);
export const ConsolidationView = (props: ViewProps) => (
  <ConsolidationRoutes key={useScopeKey()} {...props} />
);
