import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type { PaperCitation, PaperRevision, PaperSection } from '@merv/paper/models';
import { useCommand } from '../mutations';
import { Area, Failure, Field, OpenedForm, Submit, useArtifacts } from '../components';
import { EditIcon, PlusIcon } from '../icons';
import { RecordPicker, filePick } from '../record-picker';
import { useSession } from '../session';

/** How paper.cite writes a retained file among a citation's references. */
const FILE = 'artifact:';
/** The first limit a form has broken, in the tool's own words; null while it holds. */
const complaint = (tests: [boolean, string][]) => tests.find(([broken]) => broken)?.[1] ?? null;
/**
 * A section's own control: one glyph beside its heading, named for a screen reader
 * and on hover by the words the form it opens is headed with. `data-tool` is how
 * the cursor finds its way back here when that form closes.
 */
export function HeadTool({
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

export function SectionEditor({
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
export function CitationEditor({
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
