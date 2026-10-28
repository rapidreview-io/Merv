import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AdminIssue, AdminIssueCase, AdminIssueDetail, AdminIssues } from '@merv/admin/models';
import { issueTitle } from '@merv/contracts/issue-models';
import { accountRequest, useTool } from '../api';
import { Ago, Failure, LoadState, Word, capital, cx, stamp, useNow, words } from '../components';
import { Icon } from '../icons';
import { ListPage, useListFilter } from '../list-filters';
import { elapsed } from '../liveness';
import { Head, count } from './parts';

const HOUR = 3_600_000;
const WEEK = 168;
/** Each class in its own hue and glyph, in one fixed order. */
const CLASSES = [
  { value: 'tool', label: 'Tool calls', icon: 'chip' },
  { value: 'question', label: 'Questions', icon: 'chat' },
  { value: 'platform', label: 'Platform', icon: 'machines' },
] as const;
const hue = (cls: string) => ({ '--issue': `var(--issue-${cls})` }) as CSSProperties;
const TONE = { severe: 'bad', warn: 'warn', notice: 'dim' } as const;
/** Where releases are cut from: a fault's frame opens there at the commit that ran it. */
const SOURCE = 'https://github.com/rapidreview-io/Merv';

/** What an issue is called: a question by what it asked, anything else by its site and code. */
const titleOf = (row: AdminIssue) =>
  (row.class === 'question' && row.note) || issueTitle(row.where, row.code);
/** An open issue's state is its level, so the state chips narrow by level too. */
const stateOf = (row: AdminIssue) => (row.state === 'open' ? row.level : row.state);
/** Open severe, warn, then notice issues; what ended after them. */
const rank = (row: AdminIssue) => ['severe', 'warn', 'notice', 'resolved'].indexOf(stateOf(row));
const weekOf = (row: AdminIssue) => row.hours.reduce((sum, [, n]) => sum + n, 0);

/** The part of the platform a site belongs to, as the breakdown groups platform issues. */
const PARTS: Record<string, string> = {
  session: 'Sessions',
  dispatch: 'Sessions',
  code_work: 'Code',
  git: 'Code',
  consumer: 'Events',
  plugin: 'Server',
  process: 'Server',
  composition: 'Server',
  secrets: 'Server',
  api_error: 'Server',
};
/** Which group of its class the breakdown counts an issue under: a tool by its name, a question by
 *  its project, the platform by its part. */
const groupOf = (row: AdminIssue) => {
  if (row.class === 'tool') return row.where.split(':')[0]!;
  if (row.class === 'question')
    return row.latest?.project?.name ?? row.projects[0]?.name ?? 'No project';
  const part = row.where.split('.')[0]!;
  return PARTS[part] ?? capital(words(part));
};

/** The commit a release was built from (`<stamp>-<sha>-…`), and a fault's first frame of Merv's own
 *  source, as the path within merv-typescript and its line. */
const commitOf = (release: string | null) =>
  /^\d{8}T\d{6}Z-([0-9a-f]{7,40})/.exec(release ?? '')?.[1];
const frameOf = (frames?: string[]) =>
  frames
    ?.map((frame) => /(?:^|[\s(/])((?:packages|src)\/[^\s:()]+\.tsx?):(\d+)/.exec(frame))
    .find(Boolean);

interface Opening {
  to: string;
  label: string;
  /** Outside this app: GitHub. */
  away?: true;
}
/**
 * Where a case's context is, as the project's own people see it, read-only: the agent's visit on
 * its work's Agents tab, an agent with no work, the work, the machine, else the project's Work.
 * A case with a fault frame also opens that code at the release that ran it; a case with neither
 * project nor frame, the commit.
 */
function opens(c: AdminIssueCase): Opening[] {
  const part = encodeURIComponent;
  const base = c.projectId && `/admin/p/${part(c.projectId)}`;
  const thread = c.visit?.threadId ?? c.refs.threadId;
  const instance = c.visit?.instanceId ?? c.refs.instanceId;
  const machine = c.refs.allocationId ?? c.visit?.allocationId;
  const commit = commitOf(c.release);
  const frame = frameOf(c.error?.at);
  const kind = c.work ? words(c.work.kind) : 'work';
  const found: Opening[] = [];
  if (base && instance)
    found.push({
      to: `${base}/work?key=work:${part(instance)}${thread ? `&thread=${part(thread)}` : ''}`,
      label: thread ? 'Open agent session' : `Open ${kind}`,
    });
  else if (base && thread)
    found.push({ to: `${base}/sessions?thread=${part(thread)}`, label: 'Open agent' });
  if (base && machine)
    found.push({
      to: `${base}/fleet/${part(machine)}`,
      label: found.length ? 'Machine' : 'Open machine',
    });
  if (base && !found.length) found.push({ to: `${base}/work`, label: 'Open project' });
  if (commit && (frame || !base))
    found.push({
      to: frame
        ? `${SOURCE}/blob/${commit}/merv-typescript/${frame[1]}#L${frame[2]}`
        : `${SOURCE}/commit/${commit}`,
      label: found.length ? `Code at ${commit.slice(0, 8)}` : `Open code at ${commit.slice(0, 8)}`,
      away: true,
    });
  return found;
}
/** A case's ways in: the first a button and the rest quiet words; in a list of cases, all quiet. */
const Opens = ({ c, project, quiet }: { c: AdminIssueCase; project?: string; quiet?: boolean }) => (
  <>
    {opens(c).map((o, i) =>
      o.away ? (
        <a
          key={o.to}
          className={i || quiet ? 'btn-text' : 'btn'}
          href={o.to}
          target="_blank"
          rel="noreferrer"
        >
          {o.label}
          <Icon name="external" />
        </a>
      ) : (
        // A full load: the drill-in is the member Workspace, outside the admin's router.
        <Link
          key={o.to}
          className={i || quiet ? 'btn-text' : 'btn'}
          to={o.to}
          reloadDocument
          title={project && i === 0 ? `In ${project}, read-only` : undefined}
        >
          {o.label}
          {!i && <Icon name="arrow-right" />}
        </Link>
      ),
    )}
  </>
);

/** A key that only names a record or repeats the code: the context line says it better. */
const quietKey = (row: AdminIssue) =>
  !row.key || row.key === row.code || /^[a-z]+_[0-9a-f]{16,}$/.test(row.key);
/** What went wrong beyond the title: the refusal's facts, the fault's frame, the owner's words. */
function what(row: AdminIssue): string[] {
  const c = row.latest;
  const error = c?.error;
  const frame = frameOf(error?.at);
  return [
    row.class === 'question' ? issueTitle(row.where, row.code) : undefined,
    row.class !== 'question' && !quietKey(row) ? row.key! : undefined,
    error?.status ? `status ${error.status}` : undefined,
    error?.fields?.length ? `fields ${error.fields.join(', ')}` : undefined,
    error?.sqlstate &&
      ['sql', error.sqlstate, error.table, error.constraint].filter(Boolean).join(' '),
    frame ? `${frame[1]}:${frame[2]}` : undefined,
    row.class !== 'question' && row.note ? row.note : undefined,
  ].filter((said): said is string => !!said);
}
/** Who and where, from a case: project › work › agent. */
function context(c: AdminIssueCase | null) {
  if (!c) return [];
  const visit = c.visit;
  const agent = visit
    ? [capital(words(visit.role)), visit.harness && capital(visit.harness)]
        .filter(Boolean)
        .join(' · ')
    : c.refs.conversationId
      ? 'Pi'
      : c.refs.client
        ? `${c.refs.client} (outside Merv)`
        : undefined;
  return [
    c.project?.name,
    c.work &&
      `${capital(words(c.work.kind))} ${c.work.name}${c.work.terminal ? ` (${words(c.work.state)})` : ''}`,
    agent,
  ].filter((said): said is string => !!said);
}

/** The last week's reports in hours, oldest first, ending with the current hour. */
const columns = (rows: AdminIssue[], now: number) => {
  const end = Math.floor(now / HOUR);
  const cols = Array.from({ length: WEEK }, (_, i) => ({
    at: (end - WEEK + 1 + i) * HOUR,
    tool: 0,
    question: 0,
    platform: 0,
  }));
  for (const row of rows)
    for (const [hour, n] of row.hours) {
      const i = Math.floor(Date.parse(`${hour}:00:00.000Z`) / HOUR) - (end - WEEK + 1);
      if (i >= 0 && i < WEEK) cols[i]![row.class] += n;
    }
  return cols;
};

/**
 * The week at a glance: each hour's reports stacked by class, the legend naming each class with its
 * total (the hour's, under the pointer) and narrowing the page to it.
 */
function Pulse(props: {
  rows: AdminIssue[];
  now: number;
  kind: string;
  onKind(kind: string): void;
}) {
  const cols = columns(props.rows, props.now);
  const [hover, setHover] = useState<number>();
  const total = (col: (typeof cols)[number]) => col.tool + col.question + col.platform;
  const peak = Math.max(1, ...cols.map(total));
  const shown = hover === undefined ? undefined : cols[hover];
  const sum = (cls: 'tool' | 'question' | 'platform') =>
    shown ? shown[cls] : cols.reduce((s, col) => s + col[cls], 0);
  const days = cols.flatMap((col, i) =>
    new Date(col.at).getHours() === 0 ? [{ i, day: new Date(col.at) }] : [],
  );
  return (
    <section className="issues-pulse" aria-label="Reports in the last seven days">
      <div className="issues-legend">
        {CLASSES.map((c) => (
          <button
            key={c.value}
            type="button"
            className="issues-key"
            style={hue(c.value)}
            aria-pressed={props.kind === c.value}
            onClick={() => props.onKind(props.kind === c.value ? '' : c.value)}
          >
            <span className="issues-swatch" />
            {c.label} <b>{count(sum(c.value))}</b>
          </button>
        ))}
        <span className="issues-when faint">
          {shown
            ? `${new Date(shown.at).toLocaleString('en', { weekday: 'short', hour: 'numeric' })}`
            : `last 7 days · busiest hour ${count(peak)}`}
        </span>
      </div>
      <div
        className="issues-bars"
        onMouseLeave={() => setHover(undefined)}
        role="img"
        aria-label={`${count(cols.reduce((s, col) => s + total(col), 0))} reports in the last seven days`}
      >
        {cols.map((col, i) => (
          <div
            key={col.at}
            className={cx('issues-col', hover === i && 'issues-col--on')}
            onMouseEnter={() => setHover(i)}
          >
            {CLASSES.map(({ value }) =>
              col[value] ? (
                <span
                  key={value}
                  style={{ ...hue(value), height: `${(col[value] / peak) * 100}%` }}
                />
              ) : null,
            )}
          </div>
        ))}
      </div>
      <div className="issues-days faint" aria-hidden="true">
        {days.map(({ i, day }) => (
          <span key={i} style={{ left: `${(i / WEEK) * 100}%` }}>
            {day.toLocaleDateString('en', { weekday: 'short' })}
          </span>
        ))}
      </div>
    </section>
  );
}

/** Where it fails: each class's groups by their reports this week, the busiest first; one narrows
 *  the page to its issues. */
function Breakdown(props: { rows: AdminIssue[]; lens?: string; onLens(lens?: string): void }) {
  return (
    <section className="issues-where" aria-label="Where it fails">
      {CLASSES.map((c) => {
        const groups = new Map<string, { reports: number; issues: number }>();
        for (const row of props.rows.filter((row) => row.class === c.value)) {
          const g = groups.get(groupOf(row)) ?? { reports: 0, issues: 0 };
          groups.set(groupOf(row), { reports: g.reports + weekOf(row), issues: g.issues + 1 });
        }
        const ranked = [...groups].sort(
          (a, b) => b[1].reports - a[1].reports || b[1].issues - a[1].issues,
        );
        const top = Math.max(1, ...ranked.map(([, g]) => g.reports));
        return (
          <div key={c.value} className="issues-part" style={hue(c.value)}>
            <h3 className="issues-part-head">
              <Icon name={c.icon} />
              {c.label}
            </h3>
            {ranked.length === 0 && <p className="faint">Nothing this week</p>}
            <ul>
              {ranked.slice(0, 5).map(([name, g]) => {
                const lens = `${c.value}:${name}`;
                return (
                  <li key={name}>
                    <button
                      type="button"
                      aria-pressed={props.lens === lens}
                      onClick={() => props.onLens(props.lens === lens ? undefined : lens)}
                      title={`${g.issues} issue${g.issues === 1 ? '' : 's'}`}
                    >
                      <span className="issues-part-name">{name}</span>
                      <span className="issues-part-bar">
                        <span style={{ width: `${(g.reports / top) * 100}%` }} />
                      </span>
                      <b>{count(g.reports)}</b>
                    </button>
                  </li>
                );
              })}
            </ul>
            {ranked.length > 5 && <p className="faint">{ranked.length - 5} more</p>}
          </div>
        );
      })}
    </section>
  );
}

/** An issue's week in six-hour bars, labelled by its total. */
function Spark({ row, now }: { row: AdminIssue; now: number }) {
  const bins = Array.from({ length: 28 }, () => 0);
  const start = (Math.floor(now / HOUR) - WEEK + 1) * HOUR;
  for (const [hour, n] of row.hours) {
    const i = Math.floor((Date.parse(`${hour}:00:00.000Z`) - start) / (6 * HOUR));
    if (i >= 0 && i < 28) bins[i]! += n;
  }
  const peak = Math.max(1, ...bins);
  return (
    <svg className="issues-spark" viewBox="0 0 112 24" aria-hidden="true">
      {bins.map((n, i) =>
        n ? (
          <rect
            key={i}
            x={i * 4}
            y={24 - Math.max(2, (n / peak) * 24)}
            width="3"
            height={Math.max(2, (n / peak) * 24)}
            rx="1"
          />
        ) : (
          <rect key={i} x={i * 4} y="23" width="3" height="1" className="issues-spark-zero" />
        ),
      )}
    </svg>
  );
}

export function IssuesView() {
  const issues = useTool<AdminIssues>('/admin/issues', {}, { every: 15_000 });
  const now = useNow(30_000);
  const [params, setParams] = useSearchParams();
  const openId = params.get('issue') ?? undefined;
  const setOpen = (id?: string) => setParams(id ? { issue: id } : {}, { replace: true });
  const [kind, setKind] = useState('');
  const [lens, setLens] = useState<string>();
  const all = issues.data?.rows ?? [];
  const filter = useListFilter(all, {
    stateOf,
    isOpen: (state) => state !== 'resolved',
    history: true,
    labels: (row) => [titleOf(row), row.note, row.key, ...row.projects.map((p) => p.name)],
    ids: (row) => [row.id],
    also: (row) =>
      (!kind || row.class === kind) && (!lens || `${row.class}:${groupOf(row)}` === lens),
  });
  // The issue an address names (an alert's link) is a card whatever the filters say.
  const named = all.filter((row) => row.id === openId && !filter.rows.includes(row));
  const rows = [...filter.rows, ...named].sort(
    (a, b) => rank(a) - rank(b) || Date.parse(b.lastAt) - Date.parse(a.lastAt),
  );
  // An address naming an issue, as an alert's link does, brings it into view once it is drawn.
  const drawn = rows.some((row) => row.id === openId);
  useEffect(() => {
    if (drawn) document.getElementById(`issue-${openId}`)?.scrollIntoView?.({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn]);
  const clear = () => {
    filter.clear();
    setKind('');
    setLens(undefined);
  };
  const severe = issues.data?.severe ?? 0;
  const narrowed = filter.state !== filter.initial || filter.query || kind || lens;
  return (
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
          facts={
            issues.data && [severe > 0 && [severe, 'severe', true], [issues.data.open, 'open']]
          }
        />
      )}
      reset={narrowed ? clear : undefined}
      listed={false}
      drawn={
        all.length > 0 && (
          <div className="issues">
            <Pulse rows={filter.tabbed} now={now} kind={kind} onKind={setKind} />
            <Breakdown rows={filter.tabbed} lens={lens} onLens={setLens} />
            <ol className="issues-list" aria-label="Issues">
              {rows.map((row) => (
                <IssueCard
                  key={row.id}
                  row={row}
                  now={now}
                  open={openId === row.id}
                  onToggle={() => setOpen(openId === row.id ? undefined : row.id)}
                />
              ))}
            </ol>
          </div>
        )
      }
      emptyTitle="Nothing open"
    />
  );
}

/** One issue: what went wrong and its facts, who and where it last happened, its week, and the way
 *  into that context; unfolded, every kept case with its own. */
function IssueCard(props: { row: AdminIssue; now: number; open: boolean; onToggle(): void }) {
  const { row, now } = props;
  const c = row.latest;
  const icon = CLASSES.find((cls) => cls.value === row.class)!.icon;
  const fresh = now - Date.parse(row.firstAt) < 24 * HOUR;
  const back = row.openedAt > row.firstAt;
  const where = context(c);
  const said = what(row);
  return (
    <li
      id={`issue-${row.id}`}
      className={cx('issue', row.state !== 'open' && 'issue--ended', props.open && 'issue--open')}
      style={hue(row.class)}
    >
      <span className="issue-icon">
        <Icon name={icon} />
      </span>
      <div className="issue-main">
        <div className="issue-head">
          <button
            type="button"
            className="issue-title"
            aria-expanded={props.open}
            onClick={props.onToggle}
          >
            {titleOf(row)}
          </button>
          <span className="issue-marks">
            {row.state === 'open' ? (
              <Word tone={TONE[row.level]} value={row.level} />
            ) : (
              <span className="faint">
                ended <Ago at={row.resolvedAt ?? row.lastAt} />
              </span>
            )}
            {row.loop && <span className="issue-mark issue-mark--bad">loop</span>}
            {fresh && <span className="issue-mark">new</span>}
            {back && !fresh && (
              <span className="issue-mark" title={`First seen ${stamp(row.firstAt)}`}>
                back
              </span>
            )}
          </span>
        </div>
        {said.length > 0 && (
          <p className="issue-what">
            {said.map((part, i) => (
              <span key={i} className={cx(i === 0 && row.class !== 'question' && 'mono')}>
                {part}
              </span>
            ))}
          </p>
        )}
        <p className="issue-where">
          {where.length ? (
            where.map((part, i) => <span key={i}>{part}</span>)
          ) : (
            <span>Platform</span>
          )}
          {row.projects.length > 1 && (
            <span className="faint" title={row.projects.map((p) => p.name).join('\n')}>
              {row.projects.length} projects
            </span>
          )}
          {row.visits > 1 && <span className="faint">{row.visits} agents</span>}
        </p>
        <div className="issue-acts">{c && <Opens c={c} project={c.project?.name} />}</div>
      </div>
      <div className="issue-side">
        <Spark row={row} now={now} />
        <span className="issue-week">
          <b>{count(weekOf(row))}</b> this week
        </span>
        {row.count !== weekOf(row) && (
          <span className="faint" title={`${count(row.peakHour)} in its busiest hour`}>
            {count(row.count)} in all
          </span>
        )}
        <span className="faint" title={stamp(row.firstAt)}>
          first {elapsed(now - Date.parse(row.firstAt))} ago
        </span>
        <span className="faint">
          last <Ago at={row.lastAt} />
        </span>
      </div>
      {props.open && <Cases id={row.id} />}
    </li>
  );
}

/** Every kept case of one issue, newest first, each opening its own context. */
function Cases({ id }: { id: string }) {
  const path = `/admin/issues/${encodeURIComponent(id)}`;
  const read = useTool<AdminIssueDetail>(path, {}, { every: 30_000 });
  const [failed, setFailed] = useState<string>();
  const download = async () => {
    try {
      const body = JSON.stringify(await accountRequest(path), null, 2);
      const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: `${id}.json` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setFailed((error as Error).message);
    }
  };
  const cases = read.data?.cases ?? [];
  return (
    <div className="issue-cases">
      <LoadState {...read} />
      {cases.length > 0 && (
        <ol>
          {cases.map((c) => (
            <li key={c.id}>
              <Ago at={c.at} className="faint" />
              <span>
                <span className="issue-case-where">
                  {context(c).map((part, i) => (
                    <span key={i}>{part}</span>
                  ))}
                </span>
                {c.error && (
                  <span className="mono faint">
                    {[c.error.code ?? c.error.name, c.error.status].filter(Boolean).join(' ')}
                  </span>
                )}
                {c.repeats > 1 && <span className="faint"> ×{count(c.repeats)}</span>}
              </span>
              <span className="issue-case-acts">
                <Opens c={c} quiet />
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="issue-cases-foot">
        <span className="faint">
          {cases.length} kept case{cases.length === 1 ? '' : 's'}
          {cases.length > 50 && ': the first and the newest fifty'}
        </span>
        <button type="button" className="btn-text" onClick={() => void download()}>
          Download case
        </button>
      </p>
      <Failure message={failed} />
    </div>
  );
}
