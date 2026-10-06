import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type {
  PaperKind,
  PaperRevisionSummary,
  PaperSection,
  PaperSource,
  PaperWorkspace,
} from '@merv/paper/models';
import { useTool, type Loaded } from '../api';
import {
  Ago,
  Evidence,
  KV,
  LoadState,
  RecordPage,
  StatusPill,
  Summary,
  cx,
  useArtifacts,
} from '../components';
import { refreshReferences, useReferences } from '../markdown';
import { ReferenceLookup } from './paper-references';
import { ThreeStates } from '../states';
import { useSession } from '../session';
import { useActorNames } from './people';
import type { ViewProps } from './index';
import { CitationEditor, HeadTool, SectionEditor } from './paper-editors';
import {
  Block,
  Entry,
  Group,
  labels,
  Marker,
  Outline,
  Row,
  dotted,
  type DocView,
  type SectionRow,
} from './paper-entries';

/** A control two other views share; it lives in components.tsx and is reached through here. */
export { ResearchCommand } from '../components';

const KINDS = Object.keys(labels) as PaperKind[];
/** How often the paper, and the states of what it names, are read again. */
const EVERY = 10_000;

/** A fragment a person can read, from the section's own title. */
const slug = (title: string) =>
  title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'section';

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
    // A publication names the sections its review moved; an early one that names none
    // stands behind every section it still holds word for word.
    const moved = held.published?.publication.sectionIds;
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
          (!moved || moved.includes(row.section.id)) &&
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

/** A link where its owner says the record opens, and its words alone where nobody does. */
const Opens = ({ to, children }: { to?: string; children: ReactNode }) =>
  to ? <Link to={to}>{children}</Link> : <>{children}</>;
/**
 * The records the paper names that are not its own, as one key: where each publication
 * came from, and the reviews that wrote or accepted it.
 */
function citedBy(
  workspace: PaperWorkspace | undefined,
  kept: Loaded<PaperRevisionSummary[]>[],
): string {
  if (!workspace) return '';
  const ids = new Set<string>();
  const revisions: (PaperRevisionSummary | undefined)[] = kept.flatMap((held) => held.data ?? []);
  for (const { current, published } of Object.values(workspace.documents)) {
    revisions.push(current, published?.document);
    if (published) ids.add(published.publication.source.id).add(published.publication.reviewId);
  }
  for (const revision of revisions) if (revision?.review) ids.add(revision.review.id);
  return [...ids].sort().join(' ');
}

/**
 * The paper is one record, not four: the act first, then the document itself in
 * one reading column beside its outline, then how it got here, the reviews that
 * published it, and the machine text last.
 */
function PaperPage({ row }: ViewProps) {
  const { actor } = useSession();
  const { pathname } = useLocation();
  const { kind: opened } = useParams();
  const workspace = useTool<PaperWorkspace>('paper.read', {}, { every: EVERY });
  const artifacts = useArtifacts();
  const nameOf = useActorNames();
  // Every retained revision of each document, for History; a read that fails
  // leaves that document standing on the two revisions the workspace carries.
  const kept: Record<PaperKind, Loaded<PaperRevisionSummary[]>> = {
    problem: useTool<PaperRevisionSummary[]>('paper.read', { kind: 'problem', history: true }),
    literature: useTool<PaperRevisionSummary[]>('paper.read', {
      kind: 'literature',
      history: true,
    }),
    methods: useTool<PaperRevisionSummary[]>('paper.read', { kind: 'methods', history: true }),
    results: useTool<PaperRevisionSummary[]>('paper.read', { kind: 'results', history: true }),
  };
  // What the paper names that is not its own, named and routed by its owners.
  const cited = citedBy(workspace.data, Object.values(kept));
  const ids = useMemo(() => (cited ? cited.split(' ') : []), [cited]);
  // A review's state moves while the paper stands still, so it is asked again as the paper is.
  const named = useReferences(ids, EVERY);
  /** A saved edit writes a revision, so History is read again with the workspace. */
  const reload = () => {
    workspace.reload();
    for (const held of Object.values(kept)) held.reload();
    refreshReferences(ids);
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
  const { citations } = workspace.data;
  const writable = actor.role === 'operator' || actor.role === 'producer';
  const editable = (_kind: string) => writable;
  const extendable = (kind: string) => writable && kind !== 'problem';
  const literature = workspace.data.documents.literature.current;

  /** A source this page cannot name is left out, never printed as its identifier. */
  const sourceOf = (source: PaperSource) => named.get(source.id);
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
  /** A review, by its reviewer as the paper recorded them. */
  const verdict = (reviewId: string, reviewerId: string | null) => {
    const who = nameOf(reviewerId);
    return <Opens to={named.get(reviewId)?.to}>{who ? `${who}’s review` : 'the review'}</Opens>;
  };
  /** A revision belongs to its document; a change belongs to its section. */
  const said = (revision: PaperRevisionSummary): ReactNode => {
    if (revision.review)
      return dotted([
        <>Written by {verdict(revision.review.id, revision.updatedBy)}</>,
        revision.updatedAt ? <Ago at={revision.updatedAt} /> : null,
      ]);
    const who = nameOf(revision.updatedBy);
    // A revision published before reviews wrote the paper carries no review of its own.
    const publishedHere =
      workspace.data!.documents[revision.kind].published?.document.revision === revision.revision;
    return dotted([
      who ? `Edited by ${who}` : null,
      revision.updatedAt ? <Ago at={revision.updatedAt} /> : null,
      publishedHere ? 'published' : 'never reviewed',
    ]);
  };
  const attribution = (doc: DocView, item: SectionRow): ReactNode => {
    const clauses: ReactNode[] = [];
    // An early publication names no sections, so it credits nobody with any one of them.
    if (item.published && doc.publication)
      clauses.push(
        doc.publication.publication.sectionIds ? said(doc.publication.document) : 'published',
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
  // Every revision each document retained, once, newest first when they are read.
  const revisions = new Map<string, { doc: DocView; revision: PaperRevisionSummary }>();
  // The revision a document's own heading already states is not History's to say again.
  const headed = (doc: DocView, revision: PaperRevisionSummary) =>
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
        published.length > 0 ? (
          <>
            {published.length > 0 && (
              <Group label="Paper reviews">
                {/* One review publishes every document it accepted, so it is one row. */}
                {[...new Set(published.map((kind) => accepted(kind).publication.reviewId))].map(
                  (reviewId) => {
                    const took = published.filter(
                      (kind) => accepted(kind).publication.reviewId === reviewId,
                    );
                    const publication = accepted(took[0]).publication;
                    const subject = sourceOf(publication.source);
                    return subject ? (
                      <Row
                        key={reviewId}
                        name={
                          <Opens to={named.get(reviewId)?.to}>
                            <strong>{subject.name} review</strong>
                          </Opens>
                        }
                        stand={dotted([
                          <StatusPill value={publication.verdict ?? named.get(reviewId)?.state} />,
                          nameOf(publication.createdBy),
                          `published ${took.map((kind) => labels[kind]).join(' and ')}`,
                          <Ago at={publication.createdAt} />,
                        ])}
                      />
                    ) : null;
                  },
                )}
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
