import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AdminIssue, AdminIssueDetail, AdminIssues } from '@merv/admin/models';
import { firstSentence } from '@merv/contracts/text';
import { accountRequest, useTool } from '../api';
import {
  Ago,
  Failure,
  LoadState,
  Ruled,
  Word,
  col,
  cx,
  stamp,
  useHeadFocus,
  useNow,
  words,
} from '../components';
import { Chips, ListPage, openRow, useListFilter } from '../list-filters';
import { elapsed } from '../liveness';
import { useRoomy } from '../theme';
import { Head, count, fig, figure, useDrawer, usePost } from './parts';

const CLASSES = [
  { value: 'tool', label: 'Tools' },
  { value: 'question', label: 'Questions' },
  { value: 'platform', label: 'Platform' },
] as const;
const LEVELS = [
  { value: 'severe', label: 'Severe' },
  { value: 'warn', label: 'Warn' },
  { value: 'notice', label: 'Notice' },
] as const;
const TONE = { severe: 'bad', warn: 'warn', notice: 'dim' } as const;

/** What an issue is called: a question by what it asked, anything else by its site and code
 *  (a tool's `name:action` read as words, never as its address). */
const title = (row: AdminIssue) =>
  (row.class === 'question' && firstSentence(row.note)) ||
  `${words(row.where.replace(':', ' '))} · ${words(row.code)}`;
const since = (row: AdminIssue) => (
  <span title={stamp(row.firstAt)}>{elapsed(Date.now() - Date.parse(row.openedAt))}</span>
);
const level = (row: AdminIssue) => (
  <>
    <Word tone={TONE[row.level]} value={row.level} />
    {row.loop && <span className="status--bad"> loop</span>}
  </>
);
/** Open severe, warn, then notice issues; what was resolved after them. */
const rank = (row: AdminIssue) =>
  row.state === 'open' ? LEVELS.findIndex((l) => l.value === row.level) : 3;

export function IssuesView() {
  const issues = useTool<AdminIssues>('/admin/issues', {}, { every: 10_000 });
  useNow(30_000);
  const [params, setParams] = useSearchParams();
  const openId = params.get('issue') ?? undefined;
  const setOpen = (id?: string) => setParams(id ? { issue: id } : {}, { replace: true });
  const [kind, setKind] = useState('');
  const [tier, setTier] = useState('');
  const [resolved, setResolved] = useState(false);
  const roomy = useRoomy();
  const all = issues.data?.rows ?? [];
  const shown = (row: AdminIssue) => resolved || row.state === 'open';
  const filter = useListFilter(all, {
    labels: (row) => [title(row), row.note, ...row.projects.map((p) => p.name)],
    ids: (row) => [row.id],
    also: (row) => shown(row) && (!kind || row.class === kind) && (!tier || row.level === tier),
  });
  const rows = [...filter.rows].sort(
    (a, b) => rank(a) - rank(b) || Date.parse(b.lastAt) - Date.parse(a.lastAt),
  );
  useDrawer(rows, openId, setOpen, '.admin-name');
  const closed = all.filter((row) => row.state !== 'open').length;
  const clear = () => {
    filter.clear();
    setKind('');
    setTier('');
    setResolved(false);
  };
  const columns = [
    col<AdminIssue>('issue', 'Issue', (row) => (
      <>
        <span className="kind admin-kind faint">{words(row.class)}</span>
        <button
          type="button"
          className="admin-name"
          data-id={row.id}
          aria-expanded={openId === row.id}
          aria-controls="admin-drawer"
          onClick={() => setOpen(openId === row.id ? undefined : row.id)}
        >
          {title(row)}
        </button>
        {row.note && row.note !== title(row) && <div className="admin-attn faint">{row.note}</div>}
      </>
    )),
    col<AdminIssue>('level', 'Level', level),
    figure<AdminIssue>('count', 'Count', (row) => (
      <span title={`${count(row.peakHour)} in its busiest hour`}>{count(row.count)}</span>
    )),
    col<AdminIssue>('project', 'Project', ({ projects }) =>
      projects.length === 1 ? (
        projects[0]!.name
      ) : projects.length ? (
        <span title={projects.map((p) => p.name).join('\n')}>{projects.length}</span>
      ) : null,
    ),
    fig<AdminIssue>('last', 'Last', (row) => <Ago at={row.lastAt} className="countdown" />),
    fig<AdminIssue>('since', 'Since', since),
  ];
  const open = issues.data?.open ?? 0;
  const severe = issues.data?.severe ?? 0;
  return (
    <div className="running">
      <div className="running-plane" data-open={openId ? '' : undefined}>
        <div className="work-main" hidden={!!openId && !roomy}>
          <ListPage
            load={issues}
            noun="issues"
            kind=""
            filter={{ ...filter, clear }}
            rows={rows}
            lede={(ends) => (
              <Head
                title="Issues"
                ends={ends}
                facts={issues.data && [severe > 0 && [severe, 'severe', true], [open, 'open']]}
              />
            )}
            reset={filter.filtering || kind || tier || resolved ? clear : undefined}
            narrow={
              <>
                <Chips
                  label="Class"
                  options={CLASSES.map((c) => ({
                    ...c,
                    count: all.filter((row) => shown(row) && row.class === c.value).length,
                  }))}
                  value={kind}
                  onChange={(value) => setKind(kind === value ? '' : value)}
                />
                <Chips
                  label="Level"
                  options={LEVELS}
                  value={tier}
                  onChange={(value) => setTier(tier === value ? '' : value)}
                />
                {closed > 0 && (
                  <Chips
                    label="Resolved"
                    options={[{ value: 'resolved', label: 'Resolved', count: closed }]}
                    value={resolved ? 'resolved' : ''}
                    onChange={() => setResolved(!resolved)}
                  />
                )}
              </>
            }
            listed={false}
            drawn={
              rows.length > 0 && (
                <Ruled
                  label="Issues"
                  template="minmax(0, 2.4fr) 112px 56px minmax(0, 1fr) 72px 48px"
                  columns={columns}
                  rows={rows}
                  keyOf={(row) => row.id}
                  row={(row) => ({
                    className: cx(
                      'admin-line admin-opens',
                      row.state !== 'open' && 'admin-ended',
                      openId === row.id && 'admin-unfolded',
                    ),
                    onClick: (event) => openRow(event, '.admin-name'),
                  })}
                />
              )
            }
            emptyTitle="Nothing open"
            columns={columns.length}
          />
        </div>
        <aside
          id="admin-drawer"
          className="running-panel"
          aria-labelledby="admin-drawer-title"
          hidden={!openId}
        >
          {openId && (
            <Drawer
              key={openId}
              id={openId}
              row={all.find((row) => row.id === openId)}
              onClose={() => setOpen(undefined)}
              done={issues.reload}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

/** One issue's case file: what it is, its error, and each kept case's visit. */
function Drawer(props: { id: string; row?: AdminIssue; onClose(): void; done(): void }) {
  const path = `/admin/issues/${encodeURIComponent(props.id)}`;
  const read = useTool<AdminIssueDetail>(path, {}, { every: 30_000 });
  const row = read.data?.issue ?? props.row;
  const heading = useRef<HTMLHeadingElement>(null);
  useHeadFocus(!!row, heading);
  const resolve = usePost(() => (read.reload(), props.done()));
  const [failed, setFailed] = useState<string>();
  const download = async () => {
    try {
      const body = JSON.stringify(await accountRequest(path), null, 2);
      const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
      Object.assign(document.createElement('a'), {
        href: url,
        download: `${props.id}.json`,
      }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setFailed((error as Error).message);
    }
  };
  const cases = [...(read.data?.cases ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const error = cases.find((c) => c.error)?.error;
  return (
    <div className="running-sidebar">
      <header className="running-panel-head">
        <div className="running-panel-top">
          <h2 id="admin-drawer-title" className="running-panel-title" tabIndex={-1} ref={heading}>
            {row && title(row)}
          </h2>
          <button type="button" className="btn-text" onClick={props.onClose}>
            Close
          </button>
        </div>
        {row && (
          <div className="cluster">
            {row.state === 'open' && (
              <button
                type="button"
                className="btn"
                disabled={resolve.locked}
                onClick={() => void resolve.submit({ path: `${path}/resolve` })}
              >
                Resolve issue
              </button>
            )}
            <button type="button" className="btn" onClick={() => void download()}>
              Download case
            </button>
          </div>
        )}
        <Failure message={resolve.error ?? failed} />
      </header>
      <LoadState {...read} />
      {row && (
        <p className="admin-said">
          {level(row)}
          <span>{count(row.count)} times</span>
          {row.state === 'open' ? (
            <span>open {since(row)}</span>
          ) : (
            row.resolvedAt && (
              <span>
                resolved <Ago at={row.resolvedAt} />
              </span>
            )
          )}
          <span>
            last <Ago at={row.lastAt} />
          </span>
        </p>
      )}
      {row?.note && <p>{row.note}</p>}
      {error && (
        <div>
          {[error.code ?? error.name, error.status]
            .filter(Boolean)
            .map(String)
            .map(words)
            .join(' · ')}
          {error.at?.map((frame) => (
            <code key={frame} className="admin-frame">
              {frame}
            </code>
          ))}
        </div>
      )}
      {cases.length > 0 && (
        <ul className="admin-ledger">
          {cases.map((c) => {
            const projectId = c.project?.id ?? c.projectId;
            const thread = c.trace?.threadId ?? c.refs.threadId;
            const instance = c.trace?.instanceId ?? c.refs.instanceId;
            const part = encodeURIComponent;
            const to =
              projectId &&
              thread &&
              `/admin/p/${part(projectId)}/${instance ? `work?key=work:${part(instance)}&` : 'sessions?'}thread=${part(thread)}`;
            const ids = {
              session: c.refs.sessionId,
              invocation: c.refs.invocationId,
              conversation: c.refs.conversationId,
              allocation: c.refs.allocationId ?? c.trace?.allocationId,
              sandbox: c.refs.sandboxId,
              release: c.release,
              transcript: c.trace?.transcript?.sha256,
              head: c.trace?.workspace?.headOid,
            };
            return (
              <li
                key={c.id}
                title={Object.entries(ids)
                  .flatMap(([name, value]) => (value ? `${name} ${value}` : []))
                  .join('\n')}
              >
                <Ago at={c.at} />
                {c.project && <span>{c.project.name}</span>}
                {c.trace && (
                  <span>
                    {words([c.trace.role, c.trace.harness].filter(Boolean).join(' '))}{' '}
                    <span className="faint">
                      {words(c.trace.outcome ?? c.trace.closeReason ?? c.trace.status)}
                    </span>
                  </span>
                )}
                {to && (
                  <Link className="admin-more" to={to} reloadDocument>
                    Thread →
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
