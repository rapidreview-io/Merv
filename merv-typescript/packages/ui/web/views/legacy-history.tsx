import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useScopeVersion, useTool } from '../api';
import { KV, LoadState, Stamp, StatusPill, Summary, words } from '../components';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from '../icons';
import { ListPage, Tabs, useListFilter } from '../list-filters';
import { Markdown } from '../markdown';
import { ThreeStates } from '../states';
import { useSession } from '../session';
import type { ViewProps } from './index';

interface Summary {
  sourceId: string;
  fingerprint: string;
  importedAt: string;
  counts: Record<string, number>;
}
interface RecordSummary {
  type: string;
  id: string;
  hash: string;
  label: string;
  status?: string;
  createdAt?: string;
  fileRetention?:
    | { status: 'verified'; artifactId: string }
    | {
        status: 'metadata-only';
        reason: 'legacy-lineage-without-retained-bytes';
        auditSha256: string;
      }
    | { status: 'unverified' };
}
interface RecordDetail {
  type: string;
  id: string;
  hash: string;
  fileRetention?: RecordSummary['fileRetention'];
  data: Record<string, unknown>;
  files?: { artifactId: string; label: string; slot: string }[];
}

interface HistoryNavigation {
  type: string;
  pages: string[];
  selected?: { type: string; id: string };
}
const RESEARCH_TYPES = [
  ['experiments', 'Experiments'],
  ['tasks', 'Tasks'],
  ['reflections', 'Reflections'],
  ['claims', 'Claims'],
  ['litreview_sections', 'Literature'],
  ['papers', 'Papers'],
  ['posts', 'Feed'],
] as const;

const READING_FIELDS: Record<string, string[]> = {
  experiments: ['intent', 'conclusion', 'details', 'revision_context'],
  tasks: ['goal', 'outcome', 'deliverables_json', 'revision_context'],
  reflections: ['revision_context'],
  claims: ['statement', 'scope', 'confidence'],
  litreview_sections: ['tldr', 'body'],
  papers: ['description', 'authors_json', 'year', 'url'],
  posts: ['text'],
  reviews: ['synopsis', 'verdict', 'notes', 'findings_json', 'evidence_json'],
  consolidation_proposals: ['summary'],
  consolidation_decisions: ['disposition', 'rationale'],
};

function ResearchContent({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined || value === '') return null;
  if (depth >= 4 && typeof value === 'object') return null;
  if (Array.isArray(value))
    return (
      <ul className="history-content-list">
        {value.slice(0, 100).map((item, index) => (
          <li key={index}>
            <ResearchContent value={item} depth={depth + 1} />
          </li>
        ))}
        {value.length > 100 && <li className="faint">and {value.length - 100} more</li>}
      </ul>
    );
  if (typeof value === 'object')
    return (
      <dl className="history-content-fields">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{words(key.replace(/_json$/, ''))}</dt>
            <dd>
              <ResearchContent value={item} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  // What an agent wrote is read as the markdown it wrote; a number or a flag is only itself.
  return typeof value === 'string' ? (
    <Markdown source={value} />
  ) : (
    <p className="history-prose">{String(value)}</p>
  );
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const recordId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2000;

function restoreNavigation(
  state: unknown,
  owner: { actorId: string; projectId: string; rowId: string },
  fallbackType: string,
): HistoryNavigation {
  const saved = object(state) ? state.mervHistory : undefined;
  if (
    !object(saved) ||
    saved.actorId !== owner.actorId ||
    saved.projectId !== owner.projectId ||
    saved.rowId !== owner.rowId ||
    typeof saved.type !== 'string' ||
    !/^[a-z][a-z_]{0,63}$/.test(saved.type) ||
    !Array.isArray(saved.pages) ||
    !saved.pages.every(recordId) ||
    (saved.selected !== undefined &&
      (!object(saved.selected) ||
        saved.selected.type !== saved.type ||
        !recordId(saved.selected.id)))
  )
    return { type: fallbackType, pages: [] };
  return {
    type: saved.type,
    pages: saved.pages,
    ...(object(saved.selected)
      ? { selected: { type: saved.type, id: saved.selected.id as string } }
      : {}),
  };
}

function Detail({
  rowId,
  selected,
  close,
}: {
  rowId: string;
  selected: { type: string; id: string };
  close(): void;
}) {
  const detail = useTool<RecordDetail>('ui.read', {
    rowId,
    params: { action: 'detail', ...selected },
  });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const record = detail.data?.data;
  const title =
    record &&
    [record.name, record.title, record.statement, record.synopsis, record.text].find(
      (value) => typeof value === 'string' && value.trim(),
    );
  return (
    <aside
      id="history-detail"
      className="card stack history-detail"
      aria-labelledby="history-detail-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="cluster">
        <h2 id="history-detail-title" className="section-title" ref={heading} tabIndex={-1}>
          {typeof title === 'string'
            ? title.slice(0, 240)
            : detail.data
              ? words(detail.data.type)
              : 'Loading research…'}
        </h2>
        <button
          type="button"
          className="btn-icon"
          aria-label="Close"
          title="Close (Esc)"
          onClick={close}
        >
          <CloseIcon />
        </button>
      </div>
      <LoadState {...detail} />
      {detail.data && !detail.error && (
        <>
          <div className="cluster faint">
            <span>{words(detail.data.type)}</span>
            <StatusPill value={typeof record?.status === 'string' ? record.status : undefined} />
            {typeof record?.created_at === 'string' && <Stamp at={record.created_at} />}
            <span>Imported</span>
          </div>
          {(READING_FIELDS[detail.data.type] ?? ['summary', 'description', 'notes']).map(
            (field) => {
              const value = detail.data!.data[field];
              if (value === null || value === undefined || value === '') return null;
              return (
                <section key={field} className="history-reading-section">
                  <h3>{field === 'tldr' ? 'Summary' : words(field.replace(/_json$/, ''))}</h3>
                  <ResearchContent value={value} />
                </section>
              );
            },
          )}
          {detail.data.fileRetention?.status === 'verified' && (
            <Link
              className="btn"
              to={`/artifacts/${encodeURIComponent(detail.data.fileRetention.artifactId)}`}
            >
              Open imported file
            </Link>
          )}
          {/* How the file itself stands is one state word, the same one its row carries. */}
          {detail.data.type === 'artifacts' && detail.data.fileRetention?.status !== 'verified' && (
            <div>
              <StatusPill value={detail.data.fileRetention?.status ?? 'unverified'} />
            </div>
          )}
          {!!detail.data.files?.length && (
            <div className="stack">
              <h3 className="section-title">Attached files</h3>
              {detail.data.files.map((file) => (
                <Link key={file.slot} to={`/artifacts/${encodeURIComponent(file.artifactId)}`}>
                  {file.label}
                </Link>
              ))}
            </div>
          )}
          <details className="history-technical">
            <Summary>Original record</Summary>
            <KV rows={[['Hash', <span className="mono">{detail.data.hash}</span>]]} />
            <pre className="doc">{JSON.stringify(detail.data.data, null, 2)}</pre>
          </details>
        </>
      )}
    </aside>
  );
}

function History({ row }: ViewProps) {
  const summary = useTool<Summary>('ui.read', { rowId: row.id, params: { action: 'summary' } });
  const { actor, project } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const owner = { actorId: actor.id, projectId: project.id, rowId: row.id };
  const counts = summary.data?.counts ?? {};
  const fallbackType =
    RESEARCH_TYPES.find(([name]) => counts[name] > 0)?.[0] ??
    Object.keys(counts).find((name) => counts[name] > 0) ??
    'experiments';
  const { type, pages, selected } = restoreNavigation(location.state, owner, fallbackType);
  const opener = useRef<HTMLButtonElement>(null);
  const typeChooser = useRef<HTMLSelectElement>(null);
  const update = (next: HistoryNavigation) => {
    // Keep the actual cursor stack on this route's history entry, never record payloads.
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: { mervHistory: { ...owner, ...next } } },
    );
  };
  const close = () => {
    const target = opener.current ?? typeChooser.current;
    update({ type, pages });
    target?.focus();
  };
  const records = useTool<{ records: RecordSummary[]; next?: string }>(
    summary.data ? 'ui.read' : null,
    {
      rowId: row.id,
      params: { action: 'list', type, limit: 25, ...(pages.length ? { after: pages.at(-1) } : {}) },
    },
  );
  const types = Object.entries(summary.data?.counts ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const filter = useListFilter(records.data?.records, {
    stateOf: (item) => item.status ?? '',
    labels: (item) => [item.label],
    ids: (item) => [item.id],
  });
  return (
    <div className="page-stage stack stack--lg">
      <LoadState
        loading={summary.loading}
        error={summary.error?.code === 'legacy_history_not_found' ? undefined : summary.error}
        empty={summary.error?.code === 'legacy_history_not_found'}
        emptyTitle="No previous research in this project"
        emptyKind="legacy-history"
      />
      {summary.data && !summary.error && (
        <>
          {/* The categories a person reads are tabs; every other type is one fold away. */}
          <nav className="history-tabs" aria-label="Research categories">
            <Tabs
              label="Research categories"
              options={RESEARCH_TYPES.filter(([name]) => (counts[name] ?? 0) > 0).map(
                ([name, label]) => ({
                  value: name,
                  label,
                  count: counts[name]!.toLocaleString(),
                }),
              )}
              value={type}
              onChange={(name) => update({ type: name, pages: [] })}
            />
          </nav>
          <details className="history-technical">
            <Summary>Import details</Summary>
            <KV
              rows={[
                [
                  'Record type',
                  <select
                    className="input"
                    aria-label="Record type"
                    ref={typeChooser}
                    value={type}
                    onChange={(event) => update({ type: event.target.value, pages: [] })}
                  >
                    {types.map(([name, count]) => (
                      <option key={name} value={name}>
                        {words(name)} ({count.toLocaleString()})
                      </option>
                    ))}
                  </select>,
                ],
                ['Imported', <Stamp at={summary.data.importedAt} />],
                ['Fingerprint', <span className="mono">{summary.data.fingerprint}</span>],
              ]}
            />
          </details>
          <div className={`history-layout${selected ? ' history-layout--selected' : ''}`}>
            <section className="stack" aria-label="Historical records">
              <ListPage
                load={records}
                noun="records"
                kind="legacy-history"
                filter={filter}
                emptyTitle="No records of this type"
                line={(item) => ({
                  name: (
                    <button
                      className="row-link history-record-link"
                      ref={selected?.id === item.id ? opener : undefined}
                      aria-expanded={selected?.id === item.id}
                      aria-controls={selected?.id === item.id ? 'history-detail' : undefined}
                      onClick={() => update({ type, pages, selected: { type, id: item.id } })}
                    >
                      {item.label}
                    </button>
                  ),
                  standing: (
                    <ThreeStates
                      execution={item.status ?? null}
                      meta={
                        (type === 'artifacts' || item.createdAt) && (
                          <>
                            {type === 'artifacts' &&
                              (item.fileRetention?.status === 'verified'
                                ? 'Available'
                                : item.fileRetention?.status === 'metadata-only'
                                  ? 'Metadata only'
                                  : 'Not verified')}
                            {type === 'artifacts' && item.createdAt && ' · '}
                            {item.createdAt && <Stamp at={item.createdAt} />}
                          </>
                        )
                      }
                    />
                  ),
                })}
              />
              {/* One page of a short type needs no way to turn it. */}
              {(pages.length > 0 || !!records.data?.next) && (
                <div className="cluster">
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label="Previous page"
                    title="Previous page"
                    disabled={!pages.length || records.loading}
                    onClick={() => update({ type, pages: pages.slice(0, -1) })}
                  >
                    <ChevronLeftIcon />
                  </button>
                  <span className="faint tabular">Page {pages.length + 1}</span>
                  <button
                    type="button"
                    className="btn-icon"
                    aria-label="Next page"
                    title="Next page"
                    disabled={!records.data?.next || records.loading || !!records.error}
                    onClick={() => {
                      if (records.data?.next)
                        update({ type, pages: [...pages, records.data.next] });
                    }}
                  >
                    <ChevronRightIcon />
                  </button>
                </div>
              )}
            </section>
            {selected && (
              <Detail
                key={`${type}:${selected.id}`}
                rowId={row.id}
                selected={selected}
                close={close}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

export const LegacyHistoryView = (props: ViewProps) => (
  <History key={useScopeVersion()} {...props} />
);
