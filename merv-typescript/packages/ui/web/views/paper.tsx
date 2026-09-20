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
  PaperProposal,
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
type Change = PaperPatch['changes'][number];
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
/** How many sections one proposal changes, counted the same way wherever it is said. */
const edits = (proposal: PaperProposal) =>
  proposal.documents.reduce((count, item) => count + item.edit.changes.length, 0);

interface Run {
  text: string;
  mark?: 'add' | 'del' | 'both';
}
/**
 * What one proposal actually changes, word by word: the common head and tail of
 * the two texts, then a longest-common-subsequence alignment of what moved
 * between them, with a scrap of shared text between two changes folded into the
 * change — a diff that alternates single words is not a reading of anything.
 * Above the cap the middle reads as one replacement rather than costing the page
 * a quadratic pass over a hundred thousand characters.
 */
function wordDiff(before: string, after: string): Run[] {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let head = 0;
  let tail = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail))
    tail += 1;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const runs: Run[] = head ? [{ text: a.slice(0, head).join('') }] : [];
  const keep = (text: string, mark?: Run['mark']) => {
    const last = runs[runs.length - 1];
    if (last && last.mark === mark) last.text += text;
    else runs.push({ text, mark });
  };
  if (x.length * y.length > 160_000) {
    if (x.length) keep(x.join(''), 'del');
    if (y.length) keep(y.join(''), 'add');
  } else {
    const wide = y.length + 1;
    const grid = new Int32Array((x.length + 1) * wide);
    for (let i = x.length - 1; i >= 0; i -= 1)
      for (let j = y.length - 1; j >= 0; j -= 1)
        grid[i * wide + j] =
          x[i] === y[j]
            ? grid[(i + 1) * wide + j + 1] + 1
            : Math.max(grid[(i + 1) * wide + j], grid[i * wide + j + 1]);
    for (let i = 0, j = 0; i < x.length || j < y.length;)
      if (i >= x.length) keep(y[j++], 'add');
      else if (j >= y.length) keep(x[i++], 'del');
      else if (x[i] === y[j]) {
        keep(x[i]);
        i += 1;
        j += 1;
      } else if (grid[(i + 1) * wide + j] >= grid[i * wide + j + 1]) keep(x[i++], 'del');
      else keep(y[j++], 'add');
  }
  if (tail) keep(a.slice(a.length - tail).join(''));
  /** Inside a change, a short scrap of shared text is part of it and not a third run. */
  const glued = (at: number) =>
    !!runs[at].mark ||
    (at < runs.length - 1 && runs[at].text.trim().length < 12 && !!runs[at + 1].mark);
  const said: Run[] = [];
  for (let at = 0; at < runs.length;)
    if (!runs[at].mark) said.push(runs[at++]);
    else {
      let cut = '';
      let add = '';
      while (at < runs.length && glued(at)) {
        const run = runs[at++];
        if (run.mark !== 'add') cut += run.text;
        if (run.mark !== 'del') add += run.text;
      }
      if (cut.trim()) said.push({ text: cut, mark: 'del' });
      if (add.trim()) said.push({ text: add, mark: 'add' });
    }
  return said;
}

interface SectionRow {
  section: PaperSection;
  /** The derived address, `2.1`, computed from order and never stored. */
  n: string;
  anchor: string;
  change?: Change;
  before?: PaperSection;
  proposal?: PaperProposal;
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
 * numbered by position, each open proposal's changes carried against the
 * revision that proposal pinned, and the files a publication retained placed
 * once — under the last document that pinned them, where a paper's figures sit.
 */
function compose(workspace: PaperWorkspace): DocView[] {
  const open = workspace.proposals.filter((proposal) => !proposal.acceptance);
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
    for (const proposal of open)
      for (const edit of proposal.documents.filter((item) => item.edit.kind === kind))
        for (const change of edit.edit.changes) {
          const found = rows.findIndex((row) => row.section.id === change.id);
          const row = {
            section: {
              id: change.id,
              title: change.title ?? rows[found]?.section.title ?? '',
              content: change.content ?? rows[found]?.section.content ?? '',
            },
            change,
            before: edit.before.sections.find((item) => item.id === change.id),
            proposal,
          };
          if (found >= 0) rows[found] = row;
          else {
            const after =
              change.afterId === null
                ? -1
                : rows.findIndex((item) => item.section.id === change.afterId);
            rows.splice(after < 0 && change.afterId !== null ? rows.length : after + 1, 0, row);
          }
        }
    // The proposal a publication carried names the exact sections that review moved.
    const source = workspace.proposals.find(
      (proposal) => proposal.id === held.published?.publication.proposalId,
    );
    const moved = new Set(
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
        anchor: `${kind}-${slug(row.section.title)}-${row.section.id.slice(-6)}`,
        published: moved.has(row.section.id),
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
      className="card stack claims-form"
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

/**
 * One section of the paper: its derived number, where it came from or what is
 * waiting on it, and the text itself — read as the markdown it is written in, or
 * carrying the marks of an open proposal unless the reader asks for the version
 * that passed review. A section nobody has written yet says so in one quiet line
 * and keeps its control in view, rather than standing as a bare heading.
 */
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
  const [plain, setPlain] = useState(false);
  const { section, change, before } = row;
  const shown = (plain ? (before?.content ?? section.content) : section.content).trim();
  const runs =
    change && !plain
      ? change.remove
        ? [{ text: section.content, mark: 'del' as const }]
        : // A section that is wholly new has nothing to be read against: every word would
          // be an insertion, a page of underline. Its `Proposed` flag says it, and the
          // text is read as the document it is.
          change.content === undefined || !before
          ? null
          : wordDiff(before.content, change.content)
      : null;
  return (
    <div className={cx('sec', !runs && !shown && 'sec--unwritten')} id={row.anchor}>
      <h4 className="sec-h">
        <span className="n">{row.n}</span>
        {section.title}
        {change && (
          <span className="flag">
            {change.remove ? 'Proposed removal' : before ? '' : 'Proposed'}
          </span>
        )}
        {edit}
      </h4>
      {from}
      {runs ? (
        <p className="diff">
          {runs.map((run, at) =>
            run.mark === 'add' ? (
              <ins className="add" key={at}>
                {run.text}
              </ins>
            ) : run.mark === 'del' ? (
              <del className="cut" key={at}>
                {run.text}
              </del>
            ) : (
              <Fragment key={at}>{run.text}</Fragment>
            ),
          )}
        </p>
      ) : (
        // A section nobody has written is its heading and the pencil beside it, which
        // is always drawn there: the way to begin says that nothing has begun.
        shown && <Markdown source={shown} under={4} />
      )}
      {markers}
      {change && before && (
        <p className="sec-tools">
          <button type="button" className="btn-text" onClick={() => setPlain((value) => !value)}>
            {plain ? 'Show proposed changes' : 'Show published version'}
          </button>
        </p>
      )}
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
                  {row.proposal && <span className="out-flag" />}
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
  const open = proposals.filter((proposal) => !proposal.acceptance);
  const writable = actor.role === 'operator' || actor.role === 'producer';
  // paper.patch edits problem and literature by hand; methods and results change only
  // through an experiment's or a reflection's review, and problem's four sections are fixed.
  const editable = (kind: string) => writable && (kind === 'problem' || kind === 'literature');
  const extendable = (kind: string) => writable && kind === 'literature';
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
    if (item.proposal)
      clauses.push(
        sourceOf(item.proposal.source) ? (
          <>
            Proposed by <Source source={item.proposal.source} /> · waiting on its review
          </>
        ) : (
          'Waiting on its review'
        ),
      );
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
  const changes = open.reduce((sum, proposal) => sum + edits(proposal), 0);
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
    changes ? `${changes} change${changes > 1 ? 's' : ''} waiting on review` : null,
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
              <Group label="Proposed this paper">
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
              <Group label="Accepted it">
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
