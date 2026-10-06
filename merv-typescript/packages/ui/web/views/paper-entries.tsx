import { Fragment, type ReactNode } from 'react';
import type {
  PaperCitation,
  PaperKind,
  PaperRevision,
  PaperSection,
  PaperWorkspace,
} from '@merv/paper/models';
import { Ago, Evidence, Summary, cx, useArtifacts } from '../components';
import { Markdown, RecordText } from '../markdown';

/** Each document's title, wherever the paper is named: here and on Home. */
export const labels: Record<PaperKind, string> = {
  problem: 'Problem & scope',
  literature: 'Literature',
  methods: 'Methods',
  results: 'Results',
};
export type Files = ReturnType<typeof useArtifacts>;

/** The clauses of one line, in the app's one separator; a line with none is no line. */
export const dotted = (parts: ReactNode[]) => {
  const said = parts.filter(Boolean);
  return said.length
    ? said.map((part, at) => <Fragment key={at}>{at ? <> · {part}</> : part}</Fragment>)
    : null;
};
/** Authors as a paper prints them: three, then the rest under et al. */
export const authors = (names: string[]) =>
  names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
export const files = (n: number) =>
  n ? `${n} retained file${n > 1 ? 's' : ''}` : 'No retained file';
export interface SectionRow {
  section: PaperSection;
  /** The derived address, `2.1`, computed from order and never stored. */
  n: string;
  anchor: string;
  /** True where the publication on screen is the one that moved this section. */
  published?: boolean;
}
export interface DocView {
  kind: PaperKind;
  n: number;
  current: PaperRevision;
  publication: PaperWorkspace['documents'][PaperKind]['published'];
  rows: SectionRow[];
  figures: { id: string; n: number }[];
}

/** A marker is a number; the work behind it is one hover away and never an id. */
export function Marker({ at, item }: { at: number; item: PaperCitation }) {
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
export function Entry({
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
export function Block({
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

export function Outline({
  docs,
  ledger,
  here,
}: {
  docs: DocView[];
  ledger: number;
  here?: string;
}) {
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

export const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <span className="label">{label}</span>
    <ul className="rows">{children}</ul>
  </div>
);
/** The two-line row those groups and the history are made of: the name, then how it stands. */
export const Row = ({ name, stand }: { name: ReactNode; stand: ReactNode }) => (
  <li className="row">
    <span className="row-name">{name}</span>
    <span className="ref-stand">{stand}</span>
  </li>
);
