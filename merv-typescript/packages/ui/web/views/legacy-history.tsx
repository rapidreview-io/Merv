import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useScopeVersion, useTool } from '../api';
import { KV, LoadState, PageHeader, StatusPill, Table, words } from '../components';
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
  if (depth >= 4 && typeof value === 'object')
    return <p className="faint">More detail is available in the original record below.</p>;
  if (Array.isArray(value))
    return (
      <ul className="history-content-list">
        {value.slice(0, 100).map((item, index) => (
          <li key={index}>
            <ResearchContent value={item} depth={depth + 1} />
          </li>
        ))}
        {value.length > 100 && (
          <li>Remaining entries are available in the original record below.</li>
        )}
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
  return <p className="history-prose">{String(value)}</p>;
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
        <button className="btn btn--sm" onClick={close}>
          Close
        </button>
      </div>
      <LoadState {...detail} />
      {detail.data && !detail.error && (
        <>
          <div className="cluster faint">
            <span>{words(detail.data.type)}</span>
            <StatusPill value={typeof record?.status === 'string' ? record.status : undefined} />
            {typeof record?.created_at === 'string' && (
              <time dateTime={record.created_at}>
                {new Date(record.created_at).toLocaleDateString()}
              </time>
            )}
            <span>Imported · read-only</span>
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
              className="btn btn--sm"
              to={`/artifacts/${encodeURIComponent(detail.data.fileRetention.artifactId)}`}
            >
              Open imported file
            </Link>
          )}
          {detail.data.fileRetention?.status === 'metadata-only' && (
            <p>
              This legacy record tracks file lineage; its contents were not retained in Merv. The
              original metadata is preserved below.
            </p>
          )}
          {detail.data.type === 'artifacts' &&
            detail.data.data.status === 'complete' &&
            (!detail.data.fileRetention || detail.data.fileRetention.status === 'unverified') && (
              <p className="faint">File availability has not been verified for this import.</p>
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
            <summary>Original record and import details</summary>
            <KV
              rows={[
                ['Original ID', <span className="mono">{detail.data.id}</span>],
                ['Preservation hash', <span className="mono">{detail.data.hash}</span>],
              ]}
            />
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
  return (
    <div className="page-stage page-stage--wide stack stack--lg">
      <PageHeader
        title={row.label}
        summary="Explore the findings, experiments and discussions from your earlier research."
      />
      <p className="faint">
        Imported records are read-only. New work appears in Experiments and Tasks.
      </p>
      <LoadState
        loading={summary.loading}
        error={summary.error?.code === 'legacy_history_not_found' ? undefined : summary.error}
        empty={summary.error?.code === 'legacy_history_not_found'}
        emptyTitle="No previous research in this project"
        emptyHint="Research created in this backend appears in the other project pages."
      />
      {summary.data && !summary.error && (
        <>
          <nav className="history-type-tabs" aria-label="Research categories">
            {RESEARCH_TYPES.filter(([name]) => (summary.data?.counts[name] ?? 0) > 0).map(
              ([name, label]) => (
                <button
                  className={`history-type-tab${type === name ? ' active' : ''}`}
                  key={name}
                  aria-pressed={type === name}
                  onClick={() => update({ type: name, pages: [] })}
                >
                  {label}
                  <span>{summary.data!.counts[name].toLocaleString()}</span>
                </button>
              ),
            )}
          </nav>
          <details className="history-technical">
            <summary>Browse all record types</summary>
            <div className="cluster">
              <label>
                Record type{' '}
                <select
                  className="input"
                  ref={typeChooser}
                  value={type}
                  onChange={(event) => update({ type: event.target.value, pages: [] })}
                >
                  {types.map(([name, count]) => (
                    <option key={name} value={name}>
                      {words(name)} ({count.toLocaleString()})
                    </option>
                  ))}
                </select>
              </label>
              <span className="faint">
                Imported {new Date(summary.data.importedAt).toLocaleString()}
              </span>
            </div>
          </details>
          <div className={`history-layout${selected ? ' history-layout--selected' : ''}`}>
            <section className="stack" aria-label="Historical records">
              <LoadState
                {...records}
                empty={records.data?.records.length === 0}
                emptyTitle="No records of this type"
              />
              {!!records.data?.records.length && !records.error && (
                <Table
                  rows={records.data.records}
                  keyOf={(item) => item.id}
                  columns={[
                    {
                      key: 'label',
                      label: 'Record',
                      render: (item) => (
                        <div className="stack">
                          <button
                            className="history-record-link"
                            ref={selected?.id === item.id ? opener : undefined}
                            aria-expanded={selected?.id === item.id}
                            aria-controls={selected?.id === item.id ? 'history-detail' : undefined}
                            onClick={() => update({ type, pages, selected: { type, id: item.id } })}
                          >
                            {item.label || item.id}
                          </button>
                        </div>
                      ),
                    },
                    {
                      key: 'status',
                      label: 'Status',
                      render: (item) => <StatusPill value={item.status} />,
                    },
                    ...(type === 'artifacts'
                      ? [
                          {
                            key: 'retention',
                            label: 'File',
                            render: (item: RecordSummary) =>
                              item.fileRetention?.status === 'verified'
                                ? 'Available'
                                : item.fileRetention?.status === 'metadata-only'
                                  ? 'Metadata only'
                                  : 'Not verified',
                          },
                        ]
                      : []),
                    {
                      key: 'date',
                      label: 'Created',
                      render: (item) =>
                        item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '—',
                    },
                  ]}
                />
              )}
              <div className="cluster">
                <button
                  className="btn btn--sm"
                  disabled={!pages.length || records.loading}
                  onClick={() => update({ type, pages: pages.slice(0, -1) })}
                >
                  Previous
                </button>
                <span className="faint">Page {pages.length + 1}</span>
                <button
                  className="btn btn--sm"
                  disabled={!records.data?.next || records.loading || !!records.error}
                  onClick={() => {
                    if (records.data?.next) update({ type, pages: [...pages, records.data.next] });
                  }}
                >
                  Next
                </button>
              </div>
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
          <details className="faint">
            <summary>Import provenance</summary>
            <p>
              Source: <span className="mono">{summary.data.sourceId}</span>
            </p>
            <p className="history-hash mono">{summary.data.fingerprint}</p>
            <p>
              Sandbox-owned objects retain their original references and availability status. A
              historical reference does not guarantee the object is still available.
            </p>
          </details>
        </>
      )}
    </div>
  );
}

export function LegacyHistoryView(props: ViewProps) {
  const scope = useScopeVersion();
  return <History key={scope} {...props} />;
}
