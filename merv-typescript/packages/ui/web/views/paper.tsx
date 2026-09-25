import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { Link, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type {
  PaperCitation,
  PaperKind,
  PaperPatch,
  PaperRevision,
  PaperSection,
  PaperSource,
  PaperWorkspace,
} from '@merv/paper/models';
import { useTool, type Loaded } from '../api';
import { useCommand } from '../mutations';
import {
  Ago,
  Area,
  Evidence,
  Failure,
  Field,
  KV,
  LoadState,
  OpenedForm,
  RecordPage,
  StatusPill,
  Submit,
  Summary,
  cx,
  useArtifacts,
} from '../components';
import { EditIcon, PlusIcon } from '../icons';
import { Markdown, RecordText } from '../markdown';
import { ReferenceLookup } from './paper-references';
import { RecordPicker, filePick } from '../record-picker';
import { ThreeStates } from '../states';
import { useSession } from '../session';
import { useActorNames } from './people';
import type { ViewProps } from './index';

/** A control two other views share; it lives in components.tsx and is reached through here. */
export { ResearchCommand } from '../components';

const labels: Record<PaperKind, string> = {
  problem: 'Problem & scope',
  literature: 'Literature',
  methods: 'Methods',
  results: 'Results',
};
const KINDS = Object.keys(labels) as PaperKind[];
type Files = ReturnType<typeof useArtifacts>;
interface Listed {
  id: string;
  name?: string;
  title?: string;
  workflow?: { state: string };
}
interface Graded {
  id: string;
  subjectId: string;
  status: string;
  verdict: string | null;
  reviewerId: string | null;
}

/** The clauses of one line, in the app's one separator; a line with none is no line. */
const dotted = (parts: ReactNode[]) => {
  const said = parts.filter(Boolean);
  return said.length
    ? said.map((part, at) => <Fragment key={at}>{at ? <> · {part}</> : part}</Fragment>)
    : null;
};
/** A fragment a person can read, from the section's own title. */
const slug = (title: string) =>
  title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
/** Authors as a paper prints them: three, then the rest under et al. */
const authors = (names: string[]) =>
  names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
/** How paper.cite writes a retained file among a citation's references. */
const FILE = 'artifact:';
const files = (n: number) => (n ? `${n} retained file${n > 1 ? 's' : ''}` : 'No retained file');
/** The first limit a form has broken, in the tool's own words; null while it holds. */
const complaint = (tests: [boolean, string][]) => tests.find(([broken]) => broken)?.[1] ?? null;
interface SectionRow {
  section: PaperSection;
  /** The derived address, `2.1`, computed from order and never stored. */
  n: string;
  anchor: string;
  /** True where the publication on screen is the one that moved this section. */
  published?: boolean;
}
interface DocView {
  kind: PaperKind;
  n: number;
  current: PaperRevision;
  publication: PaperWorkspace['documents'][PaperKind]['published'];
  rows: SectionRow[];
  figures: { id: string; n: number }[];
}

/**
 * The paper as it is read: four documents in fixed order, their sections
 * numbered by position, and the files a publication retained placed
 * once — under the last document that pinned them, where a paper's figures sit.
 */
function compose(workspace: PaperWorkspace): DocView[] {
  const pinned = new Map<string, PaperKind>();
  for (const kind of KINDS)
    for (const file of workspace.documents[kind].published?.publication.evidence ?? [])
      pinned.set(file.id, kind);
  let figure = 0;
  return KINDS.map((kind, at) => {
    const held = workspace.documents[kind];
    // The address and the anchor are derived from the final order, once it is settled.
    const rows: Omit<SectionRow, 'n' | 'anchor'>[] = held.current.sections.map((section) => ({
      section,
    }));
    // The proposal a publication carried names the exact sections that review moved.
    const source = workspace.proposals.find(
      (proposal) => proposal.id === held.published?.publication.proposalId,
    );
    const moved = new Set(
      held.published?.publication.sectionIds ??
        source?.documents.flatMap((item) =>
          item.edit.kind === kind ? item.edit.changes.map((change) => change.id) : [],
        ),
    );
    return {
      kind,
      n: at + 1,
      current: held.current,
      publication: held.published,
      figures: (held.published?.publication.evidence ?? [])
        .filter((file) => pinned.get(file.id) === kind)
        .map((file) => ({ id: file.id, n: (figure += 1) })),
      rows: rows.map((row, index) => ({
        ...row,
        n: `${at + 1}.${index + 1}`,
        // A section is found by its title; only a title its document repeats adds the end of its id.
        anchor:
          `${kind}-${slug(row.section.title)}` +
          (rows.findIndex((other) => slug(other.section.title) === slug(row.section.title)) < index
            ? `-${row.section.id.slice(-6)}`
            : ''),
        published:
          moved.has(row.section.id) &&
          JSON.stringify(row.section) ===
            JSON.stringify(
              held.published?.document.sections.find((section) => section.id === row.section.id),
            ),
      })),
    };
  });
}

/** The outline says where the reading is: the first section the viewport holds. */
function useReading(anchors: string[]): string | undefined {
  const [here, setHere] = useState<string>();
  const all = anchors.join(' ');
  useEffect(() => {
    const ids = all ? all.split(' ') : [];
    const seen = new Set<string>();
    const watch = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) seen.add(entry.target.id);
          else seen.delete(entry.target.id);
        setHere(ids.find((id) => seen.has(id)));
      },
      { rootMargin: '0px 0px -60% 0px' },
    );
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) watch.observe(node);
    }
    return () => watch.disconnect();
  }, [all]);
  return here;
}

/**
 * A section's own control: one glyph beside its heading, named for a screen reader
 * and on hover by the words the form it opens is headed with. `data-tool` is how
 * the cursor finds its way back here when that form closes.
 */
function HeadTool({
  label,
  glyph,
  tool,
  onClick,
}: {
  label: string;
  glyph: 'edit' | 'plus';
  tool: string;
  onClick: () => void;
}) {
  const Glyph = glyph === 'edit' ? EditIcon : PlusIcon;
  return (
    <button
      type="button"
      className="btn-icon head-tool"
      data-tool={tool}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Glyph />
    </button>
  );
}

/**
 * Both editors are one form: the heading says what is being made or changed, the
 * fields sit under it, the button says only Create or Save, and a refusal is
 * stated in the same place. The cursor goes to the first field as it opens, and
 * Escape means what Cancel means.
 */
function Editor({
  label,
  creates,
  incomplete,
  validation,
  command,
  onSubmit,
  onDone,
  children,
}: {
  label: string;
  /** True where the form makes a record rather than changing one. */
  creates: boolean;
  /**
   * True while a field the form cannot do without is still empty. That is not a
   * mistake anyone has made yet, so it holds the button and says nothing; a limit
   * that was overrun is a `validation`, and is said.
   */
  incomplete: boolean;
  validation: string | null;
  command: { busy: boolean; retry: boolean; error?: string; locked: boolean };
  onSubmit: () => void;
  onDone: () => void;
  children: ReactNode;
}) {
  return (
    <OpenedForm
      className="card stack entry-form"
      aria-label={label}
      onClose={onDone}
      locked={command.locked}
      onSubmit={(event) => {
        event.preventDefault();
        if ((!validation && !incomplete) || command.retry) onSubmit();
      }}
    >
      <h3>{label}</h3>
      <fieldset disabled={command.locked}>{children}</fieldset>
      {validation && <p className="faint">{validation}</p>}
      <Failure message={command.error} />
      <div className="cluster">
        <Submit
          label={creates ? 'Create' : 'Save'}
          busy={command.busy}
          retry={command.retry}
          disabled={(!!validation || incomplete) && !command.retry}
        />
        <button type="button" className="btn" disabled={command.locked} onClick={onDone}>
          Cancel
        </button>
      </div>
    </OpenedForm>
  );
}

function SectionEditor({
  revision,
  section,
  onDone,
  onSaved,
}: {
  revision: PaperRevision;
  section?: PaperSection;
  onDone: () => void;
  onSaved: () => void;
}) {
  const [original] = useState(revision);
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
  return (
    <Editor
      label={section ? `Edit ${section.title}` : 'New section'}
      creates={!section}
      command={command}
      onDone={onDone}
      onSubmit={() =>
        void command.submit({
          kind: original.kind,
          expectedRevision: original.revision,
          changes: [{ id, title, content }],
        })
      }
      incomplete={!title.trim()}
      validation={complaint([
        [totalChars > 160_000, 'This document would exceed 160,000 characters.'],
        [
          !section && original.sections.length >= 100,
          'A document can contain at most 100 sections.',
        ],
      ])}
    >
      <Field label="Section title" required maxLength={300} value={title} onChange={setTitle} />
      <Area label="Content" rows={8} maxLength={100000} value={content} onChange={setContent} />
    </Editor>
  );
}

/** The bibliographic line, with the tool's own limits passed straight through. */
type Told = { identifier: string; title: string; authors: string; year: string; url: string };
const ASKED: [keyof Told, string, InputHTMLAttributes<HTMLInputElement>][] = [
  ['identifier', 'Identifier', { required: true, maxLength: 500, placeholder: 'doi:… or arxiv:…' }],
  ['title', 'Title', { required: true, maxLength: 1000 }],
  ['authors', 'Authors, separated by semicolons', { maxLength: 30198 }],
  ['year', 'Year', { type: 'number', min: '1000', max: '9999', step: '1' }],
  ['url', 'Source URL', { type: 'url', pattern: 'https?://.*', maxLength: 2000 }],
];

/**
 * One editor for the whole ledger: which entry is being changed is chosen inside
 * the form, so a project with forty citations still has one control.
 */
function CitationEditor({
  citation,
  ledger,
  sections,
  onPick,
  onDone,
  onSaved,
}: {
  citation?: PaperCitation;
  ledger: PaperCitation[];
  sections: PaperSection[];
  onPick: (id: string) => void;
  onDone: () => void;
  onSaved: () => void;
}) {
  const { project } = useSession();
  const [original] = useState(citation);
  const [told, setTold] = useState<Told>({
    identifier: citation?.identifier ?? '',
    title: citation?.title ?? '',
    authors: citation?.authors.join('; ') ?? '',
    year: citation?.year?.toString() ?? '',
    url: citation?.url ?? '',
  });
  const [notes, setNotes] = useState(citation?.notes ?? '');
  const [sectionIds, setSectionIds] = useState(citation?.sectionIds ?? []);
  // The tool takes a retained file as `artifact:<id>`; nobody types one. A reference of
  // any other shape that the entry already carries is kept exactly as it was written.
  const artifacts = useArtifacts();
  const [files, setFiles] = useState(() =>
    (citation?.refs ?? [])
      .filter((ref) => ref.startsWith(FILE))
      .map((ref) => ref.slice(FILE.length)),
  );
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
  const authorNames = told.authors
    .split(';')
    .map((name) => name.trim())
    .filter(Boolean);
  const carried = citation?.refs ?? [];
  const refs = [
    ...carried.filter((ref) => !ref.startsWith(FILE) || files.includes(ref.slice(FILE.length))),
    ...files.map((id) => `${FILE}${id}`).filter((ref) => !carried.includes(ref)),
  ];
  return (
    <Editor
      label={original ? 'Edit citation' : 'New citation'}
      creates={!original}
      command={command}
      onDone={onDone}
      onSubmit={() =>
        void command.submit({
          ...(original ? { id: original.id } : {}),
          expectedRevision: original?.revision ?? 0,
          ...told,
          authors: authorNames,
          year: told.year ? Number(told.year) : null,
          url: told.url || null,
          notes,
          sectionIds,
          refs,
        })
      }
      incomplete={!told.identifier.trim() || !told.title.trim()}
      validation={complaint([
        [
          authorNames.length > 100 || authorNames.some((name) => name.length > 300),
          'Use up to 100 author names, each at most 300 characters.',
        ],
        [refs.length > 200, 'Use up to 200 retained files.'],
      ])}
    >
      {original && (
        <label>
          Citation
          <select value={original.id} onChange={(event) => onPick(event.target.value)}>
            {ledger.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {ASKED.map(([key, label, rest]) => (
        <Field
          key={key}
          label={label}
          {...rest}
          value={told[key]}
          onChange={(value) => setTold((held) => ({ ...held, [key]: value }))}
        />
      ))}
      <Area label="Notes" rows={3} maxLength={16000} value={notes} onChange={setNotes} />
      {/* A group of nothing has no name to stand over. */}
      {sections.length > 0 && (
        <fieldset className="stack">
          <legend>Literature sections</legend>
          {sections.map((section) => (
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
        </fieldset>
      )}
      <RecordPicker
        label="Retained files"
        options={[...artifacts.values()].map(filePick)}
        value={files}
        onChange={setFiles}
      />
    </Editor>
  );
}

/** A marker is a number; the work behind it is one hover away and never an id. */
function Marker({ at, item }: { at: number; item: PaperCitation }) {
  return (
    <button
      type="button"
      className="cite"
      onClick={() => {
        const entry = document.getElementById(`ref-${item.id}`);
        entry?.scrollIntoView({ block: 'center' });
        entry?.querySelector<HTMLElement>('summary')?.focus();
      }}
    >
      [{at}]
      <span className="cite-card">
        {dotted([authors(item.authors), item.year])}
        <strong>{item.title}</strong>
        {item.notes && <span>{item.notes}</span>}
        <span>{files(item.refs.length)}</span>
      </span>
    </button>
  );
}

/** The paper's References: two lines a row, and every retained file readable in place. */
function Entry({
  at,
  item,
  sections,
  artifacts,
  edit,
}: {
  at: number;
  item: PaperCitation;
  sections: PaperSection[];
  artifacts: Files;
  edit?: ReactNode;
}) {
  const cited = item.sectionIds
    .map((id) => sections.find((section) => section.id === id)?.title)
    .filter(Boolean);
  const source = item.url?.match(/^https?:\/\//i)
    ? item.url
    : item.identifier.startsWith('doi:')
      ? `https://doi.org/${item.identifier.slice(4)}`
      : item.identifier.startsWith('arxiv:')
        ? `https://arxiv.org/abs/${item.identifier.slice(6)}`
        : null;
  return (
    <li className="row">
      <details className="crit-file" id={`ref-${item.id}`}>
        <Summary>
          <span className="ref-name">
            <span className="ref-n">[{at}]</span>
            {dotted([authors(item.authors), item.year, item.title])}
          </span>
          <span className="ref-stand">
            {dotted([
              cited.length ? `Cited in ${cited.join(', ')}` : 'Not cited in any section',
              item.refs.length ? files(item.refs.length) : null,
              <>
                updated&nbsp;
                <Ago at={item.updatedAt} />
              </>,
            ])}
          </span>
        </Summary>
        <div className="ref-open">
          {item.notes && (
            <p>
              <RecordText text={item.notes} />
            </p>
          )}
          {/* Where the work can be opened the address says which it is; otherwise its identifier does. */}
          {source ? (
            <p>
              <a href={source} target="_blank" rel="noreferrer">
                {source.replace(/^https?:\/\//, '')}
              </a>
            </p>
          ) : (
            <p className="mono">{item.identifier}</p>
          )}
          {item.refs.map((ref) => {
            const id = ref.replace(/^artifact:/, '');
            return <Evidence key={ref} artifactId={id} artifact={artifacts.get(id)} meta />;
          })}
          {edit}
        </div>
      </details>
    </li>
  );
}

/** Current document text; earlier producer proposals remain in retained history. */
function Block({
  row,
  from,
  markers,
  edit,
}: {
  row: SectionRow;
  from: ReactNode;
  markers: ReactNode;
  edit?: ReactNode;
}) {
  const { section } = row;
  const shown = section.content.trim();
  return (
    <div className={cx('sec', !shown && 'sec--unwritten')} id={row.anchor}>
      <h4 className="sec-h">
        <span className="n">{row.n}</span>
        {section.title}
        {edit}
      </h4>
      {from}
      {shown && <Markdown source={shown} under={4} />}
      {markers}
    </div>
  );
}

function Outline({ docs, ledger, here }: { docs: DocView[]; ledger: number; here?: string }) {
  return (
    <nav className="paper-outline" aria-label="Outline">
      <ol>
        {docs.map((doc) => (
          <Fragment key={doc.kind}>
            <li>
              <a
                className={cx('out-doc', doc.rows.some((row) => row.anchor === here) && 'here')}
                href={`#${doc.kind}`}
              >
                <span className="out-n">{doc.n}</span>
                {labels[doc.kind]}
              </a>
            </li>
            {doc.rows.map((row) => (
              <li key={row.section.id}>
                <a className={cx('out-sec', row.anchor === here && 'here')} href={`#${row.anchor}`}>
                  <span className="out-n">{row.n}</span>
                  {row.section.title}
                </a>
              </li>
            ))}
            {doc.kind === 'literature' && ledger > 0 && (
              <li>
                <a className="out-sec" href="#references">
                  <span className="out-n" />
                  References
                </a>
              </li>
            )}
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <span className="label">{label}</span>
    <ul className="rows">{children}</ul>
  </div>
);
/** The two-line row those groups and the history are made of: the name, then how it stands. */
const Row = ({ name, stand }: { name: ReactNode; stand: ReactNode }) => (
  <li className="row">
    <span className="row-name">{name}</span>
    <span className="ref-stand">{stand}</span>
  </li>
);

/**
 * The paper is one record, not four: the act first, then the document itself in
 * one reading column beside its outline, then how it got here, what proposed and
 * accepted it, and the machine text last.
 */
function PaperPage({ row, shell }: ViewProps) {
  const { actor } = useSession();
  const { pathname } = useLocation();
  const { kind: opened } = useParams();
  const workspace = useTool<PaperWorkspace>('paper.read', {}, { every: 10000 });
  const holds = (view: string) => shell.rows.some((entry) => entry.view.kind === view);
  const experiments = useTool<Listed[]>(holds('experiments') ? 'experiment.list' : null);
  const reflections = useTool<Listed[]>(holds('reflections') ? 'reflection.list' : null);
  const reviews = useTool<Graded[]>(holds('reviews') ? 'review.list' : null);
  const artifacts = useArtifacts();
  const nameOf = useActorNames();
  // Every retained revision of each document, for History; a read that fails
  // leaves that document standing on the two revisions the workspace carries.
  const kept: Record<PaperKind, Loaded<PaperRevision[]>> = {
    problem: useTool<PaperRevision[]>('paper.read', { kind: 'problem', history: true }),
    literature: useTool<PaperRevision[]>('paper.read', { kind: 'literature', history: true }),
    methods: useTool<PaperRevision[]>('paper.read', { kind: 'methods', history: true }),
    results: useTool<PaperRevision[]>('paper.read', { kind: 'results', history: true }),
  };
  /** A saved edit writes a revision, so History is read again with the workspace. */
  const reload = () => {
    workspace.reload();
    for (const held of Object.values(kept)) held.reload();
  };
  const [editing, setEditing] = useState<{ kind: PaperKind; section?: PaperSection } | null>(null);
  const [citing, setCiting] = useState<string | null>(null);
  // A form that closes hands the cursor back to the glyph that opened it, which is
  // drawn again only once the form is gone.
  const frame = useRef<HTMLDivElement>(null);
  const tool = editing ? (editing.section?.id ?? editing.kind) : citing === '' ? 'citation' : '';
  const last = useRef(tool);
  useEffect(() => {
    if (!tool && last.current)
      frame.current?.querySelector<HTMLElement>(`[data-tool="${last.current}"]`)?.focus();
    last.current = tool;
  }, [tool]);
  const docs = workspace.data ? compose(workspace.data) : [];
  const here = useReading(docs.flatMap((doc) => doc.rows.map((item) => item.anchor)));
  const ready = docs.length > 0;
  useEffect(() => {
    if (opened && ready) document.getElementById(opened)?.scrollIntoView();
  }, [opened, ready]);
  if (!workspace.data)
    return (
      <div className="page-stage">
        <LoadState {...workspace} />
      </div>
    );
  const { citations, proposals } = workspace.data;
  const writable = actor.role === 'operator' || actor.role === 'producer';
  const editable = (_kind: string) => writable;
  const extendable = (kind: string) => writable && kind !== 'problem';
  const literature = workspace.data.documents.literature.current;

  /** A source this page cannot name is left out, never printed as its identifier. */
  const sourceOf = (source: PaperSource) => {
    const list = source.kind === 'experiment' ? experiments.data : reflections.data;
    const found = list?.find((item) => item.id === source.id);
    const name = found?.name ?? found?.title;
    return name
      ? { name, to: `/${source.kind}s/${source.id}`, state: found?.workflow?.state }
      : undefined;
  };
  const Source = ({ source }: { source: PaperSource }) => {
    const found = sourceOf(source);
    return found ? <Link to={found.to}>{found.name}</Link> : null;
  };
  /** Every citation that named this section, in the ledger's own order. */
  const Markers = ({ section }: { section: string }) => (
    <span className="cites">
      {citations.map((entry, at) =>
        entry.sectionIds.includes(section) ? (
          <Marker key={entry.id} at={at + 1} item={entry} />
        ) : null,
      )}
    </span>
  );
  const verdict = (reviewId: string) => {
    const who = nameOf(reviews.data?.find((review) => review.id === reviewId)?.reviewerId);
    return <Link to={`/reviews/${reviewId}`}>{who ? `${who}’s review` : 'the review'}</Link>;
  };
  /** A revision belongs to its document; a change belongs to its section. */
  const said = (revision: PaperRevision): ReactNode => {
    if (revision.review)
      return dotted([
        <>Written by {verdict(revision.review.id)}</>,
        revision.updatedAt ? <Ago at={revision.updatedAt} /> : null,
      ]);
    const from = proposals.find((proposal) => proposal.id === revision.proposalId);
    if (from?.acceptance)
      return dotted([
        sourceOf(from.source) ? (
          <>
            Published from <Source source={from.source} />
          </>
        ) : (
          'Published'
        ),
        <>accepted by {verdict(from.acceptance.reviewId)}</>,
        revision.updatedAt ? <Ago at={revision.updatedAt} /> : null,
      ]);
    if (revision.updateId) return 'From the earlier writing workflow';
    const who = nameOf(revision.updatedBy);
    return dotted([
      who ? `Edited by ${who}` : null,
      revision.updatedAt ? <Ago at={revision.updatedAt} /> : null,
      'never reviewed',
    ]);
  };
  const attribution = (doc: DocView, item: SectionRow): ReactNode => {
    const clauses: ReactNode[] = [];
    if (item.published && doc.publication) clauses.push(said(doc.publication.document));
    return clauses.length ? <p className="from">{dotted(clauses)}</p> : null;
  };

  // The standing of the whole paper: what has passed review, and what has not.
  const published = KINDS.filter((kind) => workspace.data!.documents[kind].published);
  const accepted = (kind: PaperKind) => workspace.data!.documents[kind].published!;
  const moved = docs
    .map((doc) => doc.current.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const retained = [
    ...new Set(proposals.flatMap((proposal) => proposal.evidence.map((file) => file.id))),
  ];
  const written = docs.flatMap((doc) => doc.current.sections);
  // The limits are per document (100 sections, 160,000 characters); the fullest one is shown.
  const fullest = docs.reduce(
    (most, doc) => {
      const size = doc.current.sections.reduce((sum, item) => sum + item.content.length, 0);
      return size > most.characters
        ? { kind: doc.kind, characters: size, sections: doc.current.sections.length }
        : most;
    },
    { kind: '' as PaperKind | '', characters: 0, sections: 0 },
  );
  // What proposed this paper is named by its source; one nobody can name is left out.
  const proposed = proposals.some((proposal) => sourceOf(proposal.source));
  // Every revision each document retained, once, newest first when they are read.
  const revisions = new Map<string, { doc: DocView; revision: PaperRevision }>();
  // The revision a document's own heading already states is not History's to say again.
  const headed = (doc: DocView, revision: PaperRevision) =>
    !doc.publication && revision.revision === doc.current.revision;
  for (const doc of docs)
    for (const revision of kept[doc.kind].data ??
      [doc.current, doc.publication?.document].filter((item) => !!item))
      if (revision.revision > 0 && !headed(doc, revision)) {
        const key = `${doc.kind}-${revision.revision}`;
        if (!revisions.has(key)) revisions.set(key, { doc, revision });
      }
  const stands = dotted([
    published.map((kind) => labels[kind]).join(', '),
    moved ? (
      <>
        updated&nbsp;
        <Ago at={moved} />
      </>
    ) : null,
  ]);
  const index = pathname === row.path;
  return (
    <RecordPage
      back={null}
      kind={index ? undefined : row.view.kind}
      name={index ? null : 'Paper'}
      title="Document"
      standing={
        <ThreeStates
          execution={published.length ? 'published' : 'unpublished'}
          // A paper with nothing to add is its state word alone: no clause, no separator.
          // What it does add is one run of text, so its words keep a word's spacing.
          meta={stands && <span>{stands}</span>}
        />
      }
      content={
        <div className="paper" ref={frame}>
          <Outline docs={docs} ledger={citations.length} here={here} />
          <article className="paper-body">
            {docs.map((doc) => (
              <div
                className={cx('paper-doc', !doc.rows.length && 'paper-doc--unwritten')}
                id={doc.kind}
                key={doc.kind}
              >
                <h3 className="doc-h">
                  <span className="dn">{doc.n}</span>
                  {labels[doc.kind]}
                  {extendable(doc.kind) && !editing && (
                    <HeadTool
                      label="New section"
                      glyph="plus"
                      tool={doc.kind}
                      onClick={() => setEditing({ kind: doc.kind })}
                    />
                  )}
                </h3>
                {doc.current.revision > 0 && !doc.publication && (
                  <p className="from doc-from">{said(doc.current)}</p>
                )}
                {doc.rows.map((item) =>
                  editing?.section?.id === item.section.id ? (
                    <SectionEditor
                      key={item.section.id}
                      revision={doc.current}
                      section={item.section}
                      onDone={() => setEditing(null)}
                      onSaved={reload}
                    />
                  ) : (
                    <Block
                      key={item.section.id}
                      row={item}
                      from={attribution(doc, item)}
                      markers={doc.kind === 'literature' && <Markers section={item.section.id} />}
                      edit={
                        editable(doc.kind) &&
                        !editing && (
                          <HeadTool
                            label={`Edit ${item.section.title}`}
                            glyph="edit"
                            tool={item.section.id}
                            onClick={() => setEditing({ kind: doc.kind, section: item.section })}
                          />
                        )
                      }
                    />
                  ),
                )}
                {editing?.kind === doc.kind && !editing.section ? (
                  <SectionEditor
                    revision={doc.current}
                    onDone={() => setEditing(null)}
                    onSaved={reload}
                  />
                ) : null}
                {doc.figures.map((file) => (
                  <div className="fig" key={file.id}>
                    <Evidence artifactId={file.id} artifact={artifacts.get(file.id)} meta />
                    <p className="fig-cap">
                      <span className="label">Figure {file.n}</span>
                    </p>
                  </div>
                ))}
                {doc.kind === 'literature' && (citations.length > 0 || writable) && (
                  <div className="ledger" id="references">
                    <span className="label">
                      References
                      {writable && citing === null && (
                        <HeadTool
                          label="New citation"
                          glyph="plus"
                          tool="citation"
                          onClick={() => setCiting('')}
                        />
                      )}
                    </span>
                    {citing !== null && (
                      <CitationEditor
                        key={citing}
                        citation={citations.find((item) => item.id === citing)}
                        ledger={citations}
                        sections={literature.sections}
                        onPick={setCiting}
                        onDone={() => setCiting(null)}
                        onSaved={reload}
                      />
                    )}
                    <ul className="rows">
                      {citations.map((item, at) => (
                        <Entry
                          key={item.id}
                          at={at + 1}
                          item={item}
                          sections={literature.sections}
                          artifacts={artifacts}
                          edit={
                            writable &&
                            citing === null && (
                              <button
                                type="button"
                                className="btn-text"
                                onClick={() => setCiting(item.id)}
                              >
                                Edit citation
                              </button>
                            )
                          }
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </article>
        </div>
      }
      history={
        revisions.size ? (
          <ul className="rows">
            {[...revisions.values()]
              .sort((a, b) =>
                (b.revision.updatedAt ?? '').localeCompare(a.revision.updatedAt ?? ''),
              )
              .map(({ doc, revision }) => (
                <Row
                  key={`${doc.kind}-${revision.revision}`}
                  name={<strong>{labels[doc.kind]}</strong>}
                  stand={said(revision)}
                />
              ))}
          </ul>
        ) : undefined
      }
      related={
        proposed || published.length > 0 || retained.length > 0 ? (
          <>
            {proposed && (
              <Group label="Earlier paper proposals">
                {proposals.map((proposal) => {
                  const found = sourceOf(proposal.source);
                  return found ? (
                    <Row
                      key={proposal.id}
                      name={
                        <Link to={found.to}>
                          <strong>{found.name}</strong>
                        </Link>
                      }
                      stand={<StatusPill value={found.state} />}
                    />
                  ) : null;
                })}
              </Group>
            )}
            {published.length > 0 && (
              <Group label="Paper reviews">
                {/* One review publishes every document it accepted, so it is one row. */}
                {[...new Set(published.map((kind) => accepted(kind).publication.reviewId))].map(
                  (reviewId) => {
                    const took = published.filter(
                      (kind) => accepted(kind).publication.reviewId === reviewId,
                    );
                    const publication = accepted(took[0]).publication;
                    const review = reviews.data?.find((item) => item.id === reviewId);
                    const subject = sourceOf(publication.source);
                    return subject ? (
                      <Row
                        key={reviewId}
                        name={
                          <Link to={`/reviews/${reviewId}`}>
                            <strong>{subject.name} review</strong>
                          </Link>
                        }
                        stand={dotted([
                          <StatusPill value={review?.verdict ?? review?.status} />,
                          nameOf(review?.reviewerId),
                          `published ${took.map((kind) => labels[kind]).join(' and ')}`,
                          <Ago at={publication.createdAt} />,
                        ])}
                      />
                    ) : null;
                  },
                )}
              </Group>
            )}
            {retained.length > 0 && (
              <Group label="Evidence retained with it">
                {retained.map((id) => (
                  <li className="row" key={id}>
                    <Evidence artifactId={id} artifact={artifacts.get(id)} meta />
                  </li>
                ))}
              </Group>
            )}
          </>
        ) : undefined
      }
      details={
        <>
          <KV
            rows={[
              ['Sections', `${written.length}`],
              ['Citations', `${citations.length}`],
              // How near the paper is to the tool's own limits, said of the document
              // nearest them; with nothing written there is nothing to say.
              !!fullest.kind && [
                'Longest document',
                dotted([
                  labels[fullest.kind],
                  `${fullest.characters.toLocaleString()} of 160,000 characters`,
                  `${fullest.sections} of 100 sections`,
                ]),
              ],
            ]}
          />
          <details>
            <Summary>Check references</Summary>
            <ReferenceLookup />
          </details>
        </>
      }
    />
  );
}

/** `/paper/:kind` stays a deep link: one page, opened at that document. */
export const PaperView = (props: ViewProps) => (
  <Routes>
    <Route index element={<PaperPage {...props} />} />
    <Route path=":kind" element={<PaperPage {...props} />} />
  </Routes>
);
