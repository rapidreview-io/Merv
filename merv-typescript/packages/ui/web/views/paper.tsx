import { useState } from 'react';
import type {
  PaperCitation,
  PaperDocument,
  PaperProposal,
  PaperKind,
  PaperRevision,
  PaperSection,
  PaperWorkspace,
} from '@merv/paper/models';
import { useScopeVersion, useTool } from '../api';
import { useCommand } from '../mutations';
import { LoadState, ObjId, StatusPill, kindStyle } from '../components';
import { useSession } from '../session';

const labels: Record<PaperKind, string> = {
  problem: 'Problem & scope',
  literature: 'Literature',
  methods: 'Methods',
  results: 'Results',
};
const prose = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;

/** Keep a pending receipt even if a refresh already observes the created assignment. */
export function ResearchCommand({
  tool,
  input,
  label,
  onSaved,
  available = true,
  disabled = false,
}: {
  tool: string;
  input: Record<string, unknown>;
  label: string;
  onSaved: () => void;
  available?: boolean;
  disabled?: boolean;
}) {
  const command = useCommand<{ id: string; kind?: string }>({
    tool,
    validate: (value) =>
      !!value &&
      typeof value.id === 'string' &&
      (input.kind === undefined || value.kind === input.kind),
    onSuccess: onSaved,
  });
  if (!available && !command.locked) return null;
  return (
    <div className="stack">
      {command.error && (
        <p className="error-message" role="alert">
          {command.error}
        </p>
      )}
      <div>
        <button
          className="btn"
          disabled={command.busy || (disabled && !command.retry)}
          onClick={() => void command.submit(input)}
        >
          {command.busy ? 'Saving…' : command.retry ? 'Retry same request' : label}
        </button>
      </div>
    </div>
  );
}

function SectionEditor({
  document,
  section,
  onDone,
  onSaved,
}: {
  document: PaperRevision;
  section?: PaperSection;
  onDone: () => void;
  onSaved: () => void;
}) {
  const [original] = useState(document);
  const [id] = useState(section?.id ?? `section_${crypto.randomUUID().replaceAll('-', '')}`);
  const [title, setTitle] = useState(section?.title ?? '');
  const [content, setContent] = useState(section?.content ?? '');
  const command = useCommand<PaperRevision>({
    tool: 'paper.patch',
    validate: (value) =>
      !!value &&
      value.projectId === original.projectId &&
      value.kind === original.kind &&
      value.revision === original.revision + 1,
    onSuccess: () => {
      onSaved();
      onDone();
    },
  });
  const totalChars =
    original.sections
      .filter((item) => item.id !== id)
      .reduce((sum, item) => sum + item.content.length, 0) + content.length;
  const validation = !title.trim()
    ? 'Enter a section title.'
    : totalChars > 160_000
      ? 'This document would exceed 160,000 characters.'
      : !section && original.sections.length >= 100
        ? 'A document can contain at most 100 sections.'
        : null;
  return (
    <form
      className="card stack claims-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (validation && !command.retry) return;
        void command.submit({
          kind: original.kind,
          expectedRevision: original.revision,
          changes: [{ id, title, content }],
        });
      }}
    >
      <h3>{section ? 'Edit section' : 'Add section'}</h3>
      <fieldset disabled={command.locked}>
        <label>
          Section title
          <input
            required
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Content
          <textarea
            className="textarea"
            rows={8}
            value={content}
            maxLength={100000}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
      </fieldset>
      <p className="faint">
        Editing revision {original.revision}. Concurrent changes require a fresh edit.
      </p>
      {validation && <p className="faint">{validation}</p>}
      {command.error && (
        <p className="error-message" role="alert">
          {command.error}
        </p>
      )}
      <div className="cluster">
        <button
          className="btn btn--primary"
          disabled={command.busy || (!!validation && !command.retry)}
        >
          {command.retry ? 'Retry same request' : 'Save section'}
        </button>
        <button type="button" className="btn" disabled={command.locked} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CitationEditor({
  citation,
  sections,
  onDone,
  onSaved,
}: {
  citation?: PaperCitation;
  sections: PaperSection[];
  onDone: () => void;
  onSaved: () => void;
}) {
  const { project } = useSession();
  const [original] = useState(citation);
  const [identifier, setIdentifier] = useState(citation?.identifier ?? '');
  const [title, setTitle] = useState(citation?.title ?? '');
  const [authors, setAuthors] = useState(citation?.authors.join('; ') ?? '');
  const [year, setYear] = useState(citation?.year?.toString() ?? '');
  const [url, setUrl] = useState(citation?.url ?? '');
  const [notes, setNotes] = useState(citation?.notes ?? '');
  const [sectionIds, setSectionIds] = useState(citation?.sectionIds ?? []);
  const [references, setReferences] = useState(citation?.refs.join('\n') ?? '');
  const command = useCommand<PaperCitation>({
    tool: 'paper.cite',
    validate: (value) =>
      !!value &&
      value.projectId === project.id &&
      typeof value.id === 'string' &&
      (!original || value.id === original.id) &&
      value.revision === (original?.revision ?? 0) + 1,
    onSuccess: () => {
      onSaved();
      onDone();
    },
  });
  const authorNames = authors
    .split(';')
    .map((name) => name.trim())
    .filter(Boolean);
  const refs = references.split(/\s+/).filter(Boolean);
  const validation =
    !identifier.trim() || !title.trim()
      ? 'Enter an identifier and title.'
      : authorNames.length > 100 || authorNames.some((name) => name.length > 300)
        ? 'Use up to 100 author names, each at most 300 characters.'
        : refs.length > 200 ||
            refs.some(
              (ref) =>
                (!/^artifact:[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(ref) &&
                  !citation?.refs.includes(ref)) ||
                ref.length > 200,
            )
          ? 'Use up to 200 artifact: evidence references, each at most 200 characters.'
          : null;
  // Retain an older link explicitly even if a refresh no longer lists its section.
  const choices = [
    ...sections,
    ...sectionIds
      .filter((id) => !sections.some((section) => section.id === id))
      .map((id) => ({ id, title: id, content: '' })),
  ];
  return (
    <form
      className="card stack claims-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (validation && !command.retry) return;
        void command.submit({
          ...(original ? { id: original.id } : {}),
          expectedRevision: original?.revision ?? 0,
          identifier,
          title,
          authors: authorNames,
          year: year ? Number(year) : null,
          url: url || null,
          notes,
          sectionIds,
          refs,
        });
      }}
    >
      <h3>{original ? 'Edit citation' : 'Add citation'}</h3>
      <fieldset disabled={command.locked}>
        <label>
          Identifier
          <input
            required
            maxLength={500}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="doi:… or arxiv:…"
          />
        </label>
        <label>
          Title
          <input
            required
            maxLength={1000}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          Authors, separated by semicolons
          <input
            maxLength={30198}
            value={authors}
            onChange={(event) => setAuthors(event.target.value)}
          />
        </label>
        <label>
          Year
          <input
            type="number"
            min="1000"
            max="9999"
            step="1"
            value={year}
            onChange={(event) => setYear(event.target.value)}
          />
        </label>
        <label>
          Source URL
          <input
            type="url"
            pattern="https?://.*"
            maxLength={2000}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label>
          Notes
          <textarea
            className="textarea"
            rows={3}
            maxLength={16000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <div className="stack">
          <span>Linked literature sections</span>
          {!choices.length && <p className="faint">Add a literature section to link it here.</p>}
          {choices.map((section) => (
            <label className="cluster" style={{ display: 'flex' }} key={section.id}>
              <input
                type="checkbox"
                checked={sectionIds.includes(section.id)}
                onChange={(event) =>
                  setSectionIds((ids) =>
                    event.target.checked
                      ? [...ids, section.id]
                      : ids.filter((id) => id !== section.id),
                  )
                }
              />
              {section.title}
            </label>
          ))}
        </div>
        <label>
          Evidence references, one per line
          <textarea
            className="textarea mono"
            rows={3}
            maxLength={40199}
            value={references}
            onChange={(event) => setReferences(event.target.value)}
            placeholder={'artifact:art_…'}
          />
        </label>
        <p className="faint">
          Link retained evidence artifacts in this project. Existing links stay selected until you
          change them.
        </p>
      </fieldset>
      {validation && <p className="faint">{validation}</p>}
      {command.error && (
        <p className="error-message" role="alert">
          {command.error}
        </p>
      )}
      <div className="cluster">
        <button
          className="btn btn--primary"
          disabled={command.busy || (!!validation && !command.retry)}
        >
          {command.retry ? 'Retry same request' : 'Save citation'}
        </button>
        <button type="button" className="btn" disabled={command.locked} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DocumentPanel({
  document,
  proposals,
  writable,
  reload,
}: {
  document: PaperDocument;
  proposals: PaperProposal[];
  writable: boolean;
  reload: () => void;
}) {
  const [editing, setEditing] = useState<PaperSection | 'new' | null>(null);
  const [published, setPublished] = useState(false);
  const kind = document.current.kind;
  const canEdit = writable && !published && (kind === 'problem' || kind === 'literature');
  const shown = published && document.published ? document.published.document : document.current;
  return (
    <section className="stack stack--lg">
      <h2 className="section-title">{labels[kind]}</h2>
      <div className="cluster">
        <span className="faint">Revision {shown.revision}</span>
        {document.published && (
          <button
            className="btn btn--sm"
            disabled={editing !== null}
            onClick={() => setPublished((value) => !value)}
          >
            {published ? 'Show current draft' : 'Show published version'}
          </button>
        )}
      </div>
      {document.published && (
        <div className="record stack" style={kindStyle('paper')}>
          <div className="cluster">
            <StatusPill
              value={document.published.publication.reviewId ? 'approved' : 'published'}
            />
            <span>Published revision {document.published.document.revision}</span>
          </div>
          <p>{document.published.publication.evidence.length} retained evidence artifacts.</p>
          <p className="faint">
            {document.published.publication.reviewId
              ? `Accepted in the ${document.published.publication.source?.kind ?? 'scientific'} review.`
              : 'Historical publication, retained from the earlier writing workflow.'}
          </p>
        </div>
      )}
      {(kind === 'methods' || kind === 'results') && (
        <p className="muted">
          Updates are proposed with experiment results or reflection synthesis and accepted by the
          same scientific review.
        </p>
      )}
      {proposals.filter((p) => p.documents.some((d) => d.edit.kind === kind)).length > 0 && (
        <details className="stack">
          <summary>Proposed and reviewed updates</summary>
          {proposals
            .filter((p) => p.documents.some((d) => d.edit.kind === kind))
            .map((proposal) => (
              <article className="stack" key={proposal.id}>
                <div className="cluster">
                  <StatusPill value={proposal.acceptance ? 'approved' : 'submitted'} />
                  <span>
                    {proposal.source.kind} <ObjId id={proposal.source.id} />
                  </span>
                </div>
                <p>
                  Change artifact <ObjId id={proposal.artifact.id} />
                </p>
                {proposal.documents
                  .filter((d) => d.edit.kind === kind)
                  .map((d) => (
                    <pre key={d.edit.kind} style={prose}>
                      {JSON.stringify(d.edit.changes, null, 2)}
                    </pre>
                  ))}
                <p className="faint">
                  {proposal.acceptance
                    ? `Accepted by review ${proposal.acceptance.reviewId}`
                    : 'Retained submission; consult the scientific workflow review for its current verdict.'}
                </p>
              </article>
            ))}
        </details>
      )}
      {editing !== null ? (
        <SectionEditor
          document={document.current}
          section={editing === 'new' ? undefined : editing}
          onDone={() => setEditing(null)}
          onSaved={reload}
        />
      ) : (
        <>
          {!shown.sections.length && <p className="empty">No sections yet.</p>}
          {shown.sections.map((section) => (
            <article className="record stack" style={kindStyle('paper')} key={section.id}>
              <div className="cluster">
                <h3>{section.title}</h3>
                {canEdit && (
                  <button className="btn btn--sm" onClick={() => setEditing(section)}>
                    Edit {section.title}
                  </button>
                )}
              </div>
              <p style={prose}>{section.content || 'Not defined yet.'}</p>
            </article>
          ))}
          {canEdit && kind !== 'problem' && (
            <div>
              <button className="btn" onClick={() => setEditing('new')}>
                Add section
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PaperPage() {
  const { actor } = useSession();
  const workspace = useTool<PaperWorkspace>('paper.read', {}, { every: 10000 });
  const [kind, setKind] = useState<PaperKind>('problem');
  const [citation, setCitation] = useState<PaperCitation | 'new' | null>(null);
  const writable = actor.role === 'operator' || actor.role === 'producer';
  return (
    <div className="page-stage stack stack--lg">
      <LoadState {...workspace} />
      {workspace.data && (
        <>
          <div className="action-row" role="tablist" aria-label="Paper documents">
            {(Object.keys(labels) as PaperKind[]).map((value) => (
              <button
                className="btn-text"
                role="tab"
                id={`paper-tab-${value}`}
                aria-controls={`paper-panel-${value}`}
                aria-selected={kind === value}
                key={value}
                onClick={() => setKind(value)}
              >
                {labels[value]}
              </button>
            ))}
          </div>
          {/* Hide inactive panels without unmounting their drafts or uncertain command receipts. */}
          {(Object.keys(labels) as PaperKind[]).map((value) => (
            <div
              role="tabpanel"
              id={`paper-panel-${value}`}
              aria-labelledby={`paper-tab-${value}`}
              key={value}
              hidden={kind !== value}
            >
              <DocumentPanel
                document={workspace.data!.documents[value]}
                proposals={workspace.data!.proposals}
                writable={writable}
                reload={workspace.reload}
              />
            </div>
          ))}
          <div hidden={kind !== 'literature'}>
            <section className="stack">
              <h2 className="section-title">Citation ledger</h2>
              {citation !== null ? (
                <CitationEditor
                  citation={citation === 'new' ? undefined : citation}
                  sections={workspace.data.documents.literature.current.sections}
                  onDone={() => setCitation(null)}
                  onSaved={workspace.reload}
                />
              ) : (
                writable && (
                  <div>
                    <button className="btn" onClick={() => setCitation('new')}>
                      Add citation
                    </button>
                  </div>
                )
              )}
              {!workspace.data.citations.length && <p className="empty">No citations yet.</p>}
              {workspace.data.citations.map((item) => (
                <article className="record stack" style={kindStyle('paper')} key={item.id}>
                  <h3>{item.title}</h3>
                  <p>
                    {item.authors.join(', ')}
                    {item.year ? ` · ${item.year}` : ''}
                  </p>
                  <p className="mono" style={prose}>
                    {item.identifier}
                  </p>
                  <p style={prose}>{item.notes}</p>
                  {item.url && /^https?:\/\//i.test(item.url) && (
                    <a href={item.url} target="_blank" rel="noreferrer">
                      Open source
                    </a>
                  )}
                  <p className="faint">
                    {item.sectionIds.length} linked sections · {item.refs.length} research
                    references · Revision {item.revision}
                  </p>
                  {!!item.sectionIds.length && (
                    <p className="faint">
                      Sections:{' '}
                      {item.sectionIds
                        .map(
                          (id) =>
                            workspace.data!.documents.literature.current.sections.find(
                              (section) => section.id === id,
                            )?.title ?? id,
                        )
                        .join(', ')}
                    </p>
                  )}
                  {!!item.refs.length && (
                    <p className="mono faint" style={prose}>
                      {item.refs.join('\n')}
                    </p>
                  )}
                  {writable && citation === null && (
                    <div>
                      <button className="btn btn--sm" onClick={() => setCitation(item)}>
                        Edit citation
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

export function PaperView() {
  const epoch = useScopeVersion();
  const { actor, project } = useSession();
  return <PaperPage key={`${epoch}:${project.id}:${actor.id}:${actor.role}`} />;
}
