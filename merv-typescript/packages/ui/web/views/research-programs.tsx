import { useState, type FormEvent } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { WorkflowDecision } from '@merv/contracts/workflow-guidance';
import { useScopeVersion, useTool } from '../api';
import { useCommand } from '../mutations';
import { useSession } from '../session';
import { KV, LoadState, ObjId, PageHeader, StatusPill, Table, relativeTime } from '../components';
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
  graph: Artifact | null;
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

function EvidenceLink({ artifact }: { artifact: Artifact }) {
  return (
    <Link to={`/artifacts/${artifact.id}`} title={`${artifact.id}\nSHA-256 ${artifact.hash}`}>
      {artifact.title}
    </Link>
  );
}

function Guidance({ id }: { id: string }) {
  const guidance = useTool<WorkflowDecision>(
    'workflow.status_and_next',
    { instanceId: id },
    { every: 8000 },
  );
  return (
    <section className="stack" aria-label="Workflow guidance">
      <h2 className="section-title">What happens next</h2>
      <LoadState {...guidance} />
      {guidance.data && !guidance.error && (
        <>
          <p>{guidance.data.instruction}</p>
          {guidance.data.blockers.length > 0 && (
            <ul className="checks">
              {guidance.data.blockers.map((blocker, i) => (
                <li key={i}>{blocker.message}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function FrozenSources({ source }: { source: Pick<Reflection, 'corpus' | 'paper'> }) {
  const { corpus, paper } = source;
  if (!corpus || !paper)
    return (
      <section className="card stack" aria-label="Live research">
        <h2 className="section-title">Live research</h2>
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
      </section>
    );
  return (
    <section className="stack" aria-label="Frozen research sources">
      <h2 className="section-title">Frozen sources</h2>
      <p>
        {corpus.selection.experiments.length} experiments · {corpus.selection.tasks.length} tasks ·{' '}
        {corpus.selection.claims.length} claims. Captured{' '}
        {new Date(corpus.createdAt).toLocaleString()}.
      </p>
      <p className="faint">Later project edits do not change the evidence used by this wave.</p>
      <details className="card stack">
        <summary>Inspect the research snapshot</summary>
        <KV
          rows={[
            ['Snapshot', <ObjId id={corpus.id} />],
            [
              'Source hash',
              <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                {corpus.manifestHash}
              </span>,
            ],
            ['Project', corpus.selection.project.name],
          ]}
        />
        {corpus.selection.experiments.length > 0 && (
          <div className="stack">
            <h3>Experiments</h3>
            <ul>
              {corpus.selection.experiments.map((experiment) => (
                <li key={experiment.id}>
                  <Link to={`/experiments/${experiment.id}`}>{experiment.name}</Link> ·{' '}
                  {experiment.workflow.state}
                </li>
              ))}
            </ul>
          </div>
        )}
        {corpus.selection.tasks.length > 0 && (
          <div className="stack">
            <h3>Tasks</h3>
            <ul>
              {corpus.selection.tasks.map((task) => (
                <li key={task.id}>
                  <Link to={`/tasks/${task.id}`}>{task.title}</Link> · {task.workflow.state}
                </li>
              ))}
            </ul>
          </div>
        )}
        {corpus.selection.claims.length > 0 && (
          <div className="stack">
            <h3>Claims at capture</h3>
            <ul>
              {corpus.selection.claims.map((claim) => (
                <li key={claim.id}>
                  {claim.statement} · {claim.status}
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="faint">
          Links open the record's current view. The states and claims above are the frozen
          observations.
        </p>
        {corpus.selection.artifacts.length > 0 && (
          <div className="stack">
            <h3>Exact evidence</h3>
            <ul>
              {corpus.selection.artifacts.map((entry) => (
                <li key={entry.id}>
                  {entry.status === 'retained' ? (
                    <EvidenceLink artifact={entry.artifact} />
                  ) : (
                    <>
                      <ObjId id={entry.id} /> · unavailable at capture
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </details>
      <details className="card stack">
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
                  <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {section.content || 'No content at capture.'}
                  </p>
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
    </section>
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
        <label>
          Title (optional)
          <input
            className="input"
            value={title}
            maxLength={300}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Project reflection"
          />
        </label>
      </fieldset>
      <p className="faint">
        Open five independent lens assignments over live research. New task and experiment creation
        pauses until approval; existing work continues. One unfinished wave is allowed at a time.
      </p>
      {command.error && (
        <p role="alert" className="error-message">
          {command.error}
        </p>
      )}
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
  const [creating, setCreating] = useState(false);
  return (
    <div className="page-stage stack stack--lg">
      {(actor.role === 'producer' || actor.role === 'operator') && (
        <div className="action-row">
          <button
            type="button"
            className="btn btn--primary"
            aria-expanded={creating}
            onClick={() => setCreating((open) => !open)}
          >
            New reflection
          </button>
        </div>
      )}
      {creating && <CreateReflection onCreated={(wave) => navigate(`${row.path}/${wave.id}`)} />}
      <LoadState
        {...list}
        empty={list.data?.length === 0}
        emptyTitle="No reflection waves yet"
        emptyHint="A wave gathers five independent readings of the research so far; a producer starts one here."
      />
      {list.data && !list.error && list.data.length > 0 && (
        <Table
          rows={list.data}
          keyOf={(wave) => wave.id}
          onRow={(wave) => wave.id}
          columns={[
            { key: 'title', label: 'Reflection', render: (wave) => <strong>{wave.title}</strong> },
            {
              key: 'state',
              label: 'Stage',
              render: (wave) => <StatusPill value={wave.workflow.state} />,
            },
            {
              key: 'lenses',
              label: 'Lenses',
              render: (wave) =>
                `${wave.lenses.filter((lens) => lens.artifact).length} / ${wave.lenses.length}`,
            },
            { key: 'attempt', label: 'Attempt', render: (wave) => wave.attempt },
            {
              key: 'created',
              label: 'Started',
              render: (wave) => <span title={wave.createdAt}>{relativeTime(wave.createdAt)}</span>,
            },
          ]}
        />
      )}
    </div>
  );
}

function ReflectionDetail({ row }: ViewProps) {
  const { id = '' } = useParams();
  const data = useTool<Reflection>('reflection.get', { reflectionId: id }, { every: 8000 });
  const nameOf = useActorNames();
  const wave = data.error ? undefined : data.data;
  return (
    <div className="page-stage stack stack--lg">
      <LoadState {...data} back={{ to: row.path, label: row.label }} />
      {wave && (
        <>
          <PageHeader
            eyebrow={<Link to={row.path}>← {row.label}</Link>}
            kind={row.view.kind}
            title={wave.title}
            summary={`Attempt ${wave.attempt} · workflow revision ${wave.workflow.revision}`}
            actions={<StatusPill value={wave.workflow.state} />}
          />
          <Guidance id={wave.id} />
          <section className="stack">
            <h2 className="section-title">Independent perspectives</h2>
            <Table
              rows={wave.lenses}
              keyOf={(lens) => lens.id}
              columns={[
                {
                  key: 'lens',
                  label: 'Perspective',
                  render: (lens) => (
                    <details>
                      <summary>{lens.perspective.replaceAll('_', ' ')}</summary>
                      <p>{lens.instructions}</p>
                      <ObjId id={lens.id} />
                    </details>
                  ),
                },
                {
                  key: 'state',
                  label: 'State',
                  render: (lens) => <StatusPill value={lens.workflow.state} />,
                },
                {
                  key: 'producer',
                  label: 'Contributor',
                  render: (lens) =>
                    lens.producerId
                      ? (nameOf(lens.producerId) ?? <ObjId id={lens.producerId} />)
                      : 'Awaiting submission',
                },
                {
                  key: 'report',
                  label: 'Pinned report',
                  render: (lens) =>
                    lens.artifact ? <EvidenceLink artifact={lens.artifact} /> : 'Not submitted',
                },
              ]}
            />
          </section>
          <section className="stack">
            <h2 className="section-title">Synthesis and review</h2>
            {wave.report ? (
              <KV
                rows={[
                  ['Report', <EvidenceLink artifact={wave.report} />],
                  [
                    'Project graph',
                    wave.graph ? <EvidenceLink artifact={wave.graph} /> : 'Not submitted',
                  ],
                  [
                    'Change specification',
                    wave.changeSpec ? <EvidenceLink artifact={wave.changeSpec} /> : 'Not submitted',
                  ],
                ]}
              />
            ) : (
              <p className="faint">Synthesis opens after all five lenses submit their reports.</p>
            )}
            {wave.review && (
              <div className="card stack">
                <div className="cluster">
                  <Link to={`/reviews/${wave.review.id}`}>Open independent review</Link>
                  <StatusPill value={wave.review.status} />
                  <StatusPill value={wave.review.verdict} />
                </div>
                {wave.review.synopsis && <p>{wave.review.synopsis}</p>}
                {wave.review.reviewerId && (
                  <p className="faint">
                    Reviewer:{' '}
                    {nameOf(wave.review.reviewerId) ?? <ObjId id={wave.review.reviewerId} />}
                  </p>
                )}
                {wave.review.returnTo && (
                  <p>Return to: {wave.review.returnTo.replaceAll('_', ' ')}</p>
                )}
              </div>
            )}
            {wave.workflow.state === 'approved' && (
              <p>
                Reflection approved. Code consolidation is optional.{' '}
                <Link
                  to={`/consolidation?sources=${encodeURIComponent([wave.report!.id, wave.graph!.id, wave.changeSpec!.id, ...wave.lenses.flatMap((l) => (l.artifact ? [l.artifact.id] : [])), ...(wave.corpus?.selection.artifacts ?? []).flatMap((a) => (a.status === 'retained' ? [a.id] : []))].join(' '))}&experiments=${encodeURIComponent((wave.experimentIds ?? wave.corpus?.selection.experiments.map((e) => e.id) ?? []).join(' '))}&dependsOn=${encodeURIComponent(wave.id)}`}
                >
                  Configure consolidation from these outputs
                </Link>
                .
                {!wave.corpus &&
                  ' In a research cycle, advance Research to complete the cycle or start its selected Git consolidation with current research evidence and completed experiments.'}
              </p>
            )}
          </section>
          <FrozenSources source={wave} />
        </>
      )}
    </div>
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
        <label>
          Source artifact IDs
          <textarea
            required
            className="textarea mono"
            rows={3}
            value={sources}
            onChange={(event) => setSources(event.target.value)}
            placeholder="One retained artifact ID per line"
          />
        </label>
        <label>
          Experiment IDs requiring a decision
          <textarea
            className="textarea mono"
            rows={2}
            value={experiments}
            onChange={(event) => setExperiments(event.target.value)}
          />
        </label>
        <label>
          Name
          <input
            className="input"
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Consolidate the approved findings"
          />
        </label>
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
        <label>
          Additional prerequisite workflow IDs (optional)
          <textarea
            className="textarea mono"
            rows={2}
            value={dependsOn}
            maxLength={20000}
            onChange={(event) => setDependsOn(event.target.value)}
            placeholder="One ID per line"
          />
        </label>
      </fieldset>
      <p className="faint">
        Pins the selected source artifacts and requires a decision for every listed experiment.
        Additional prerequisites must finish successfully before work starts.
      </p>
      {command.error && (
        <p role="alert" className="error-message">
          {command.error}
        </p>
      )}
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
  // Arriving from an approved reflection carries the sources: open the form on those.
  const [creating, setCreating] = useState(() =>
    new URLSearchParams(window.location.search).has('sources'),
  );
  return (
    <div className="page-stage stack stack--lg">
      {(actor.role === 'operator' || actor.role === 'producer') && (
        <div className="action-row">
          <button
            type="button"
            className="btn btn--primary"
            aria-expanded={creating}
            onClick={() => setCreating((open) => !open)}
          >
            New consolidation
          </button>
        </div>
      )}
      {creating && (
        <CreateConsolidation onCreated={(record) => navigate(`${row.path}/${record.id}`)} />
      )}
      <LoadState
        {...list}
        empty={list.data?.length === 0}
        emptyTitle="No consolidations yet"
        emptyHint="A consolidation turns approved findings into reviewed decisions; a producer starts one here."
      />
      {list.data && !list.error && list.data.length > 0 && (
        <Table
          rows={list.data}
          keyOf={(record) => record.id}
          onRow={(record) => record.id}
          columns={[
            {
              key: 'name',
              label: 'Consolidation',
              render: (record) => <strong>{record.name}</strong>,
            },
            {
              key: 'state',
              label: 'Stage',
              render: (record) => <StatusPill value={record.workflow.state} />,
            },
            {
              key: 'work',
              label: 'Environment',
              render: (record) => (record.workspace === 'git' ? 'Git' : 'Research'),
            },
            {
              key: 'coverage',
              label: 'Corpus',
              render: (record) => `${record.experimentIds.length} experiments`,
            },
            {
              key: 'created',
              label: 'Started',
              render: (record) => (
                <span title={record.createdAt}>{relativeTime(record.createdAt)}</span>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function Submission({
  submission,
  record,
}: {
  submission: ConsolidationSubmission;
  record: ConsolidationRecord;
}) {
  return (
    <div className="stack">
      <KV
        rows={[
          ['Submitted', new Date(submission.createdAt).toLocaleString()],
          ['Report', <EvidenceLink artifact={submission.report} />],
          [
            'Review',
            <Link to={`/reviews/${submission.reviewId}`}>
              <ObjId id={submission.reviewId} />
            </Link>,
          ],
        ]}
      />
      {submission.decisions.length ? (
        <Table
          rows={submission.decisions}
          keyOf={(decision) => decision.experimentId}
          columns={[
            {
              key: 'experiment',
              label: 'Experiment',
              render: (decision) => (
                <Link to={`/experiments/${decision.experimentId}`}>{decision.experimentId}</Link>
              ),
            },
            {
              key: 'decision',
              label: 'Decision',
              render: (decision) => decision.decision.replaceAll('_', ' '),
            },
            {
              key: 'rationale',
              label: 'Rationale',
              render: (decision) => (
                <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {decision.rationale}
                </span>
              ),
            },
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
        <div className="card stack">
          <h3>Sealed code proposal</h3>
          <p>{submission.proposal.summary}</p>
          <KV
            rows={[
              ['Proposal', <ObjId id={submission.proposal.id} />],
              [
                'Exact head',
                <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {submission.proposal.receipt.headOid}
                </span>,
              ],
              [
                'Base',
                <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {submission.proposal.receipt.baseOid}
                </span>,
              ],
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
  return (
    <div className="page-stage stack stack--lg">
      <LoadState {...data} back={{ to: row.path, label: row.label }} />
      {record && (
        <>
          <PageHeader
            eyebrow={<Link to={row.path}>← {row.label}</Link>}
            kind={row.view.kind}
            title={record.name}
            summary={`Workflow revision ${record.workflow.revision} · ${record.workspace === 'git' ? 'Git workspace' : 'Research consolidation'}`}
            actions={<StatusPill value={record.workflow.state} />}
          />
          <Guidance id={record.id} />
          <section className="stack">
            <h2 className="section-title">Retained source artifacts</h2>
            <ul>
              {record.sources.map((artifact) => (
                <li key={artifact.id}>
                  <EvidenceLink artifact={artifact} />
                </li>
              ))}
            </ul>
          </section>
          <section className="stack">
            <h2 className="section-title">Central Git status</h2>
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
            {record.completion && (
              <p>
                Independent consolidation review completed{' '}
                {new Date(record.completion.completedAt).toLocaleString()}.{' '}
                <Link to={`/reviews/${record.completion.reviewId}`}>View approval</Link>.
              </p>
            )}
          </section>
          <section className="stack">
            <h2 className="section-title">
              {record.completion
                ? 'Approved decisions and evidence'
                : 'Submitted decisions and evidence'}
            </h2>
            {latest ? (
              <Submission submission={latest} record={record} />
            ) : (
              <p className="faint">
                The assigned producer has not submitted a consolidation report yet.
              </p>
            )}
            {record.submissions.length > 1 && (
              <details className="card stack">
                <summary>Previous submissions ({record.submissions.length - 1})</summary>
                {record.submissions
                  .slice(0, -1)
                  .reverse()
                  .map((submission) => (
                    <section className="stack" key={submission.id}>
                      <h3>Revision {submission.revision}</h3>
                      <Submission submission={submission} record={record} />
                    </section>
                  ))}
              </details>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ReflectionRoutes(props: ViewProps) {
  return (
    <Routes>
      <Route index element={<ReflectionList {...props} />} />
      <Route path=":id" element={<ReflectionDetail {...props} />} />
    </Routes>
  );
}
function ConsolidationRoutes(props: ViewProps) {
  return (
    <Routes>
      <Route index element={<ConsolidationList {...props} />} />
      <Route path=":id" element={<ConsolidationDetail {...props} />} />
    </Routes>
  );
}
export function ReflectionsView(props: ViewProps) {
  const epoch = useScopeVersion();
  const { actor, project } = useSession();
  return <ReflectionRoutes key={`${epoch}:${project.id}:${actor.id}:${actor.role}`} {...props} />;
}
export function ConsolidationView(props: ViewProps) {
  const epoch = useScopeVersion();
  const { actor, project } = useSession();
  return (
    <ConsolidationRoutes key={`${epoch}:${project.id}:${actor.id}:${actor.role}`} {...props} />
  );
}
