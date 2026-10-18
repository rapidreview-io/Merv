import { useState } from 'react';
import { useTool } from '../api';
import { Ago, SearchField, cx, kindStyle, stamp, toneOf, useNow, words } from '../components';
import { Chips, Narrowing, useListFilter } from '../list-filters';
import { clockOf, duration, elapsed } from '../liveness';
import { steadyText } from '../views/running-phrase';
import { Go, Lede, Loading, None, Tone, count, openRow, usd } from './parts';
import type { AdminWorkRow, AdminWork } from './types';

/** Each kind the table names: the record kind it wears the colour of, its word, its row's path. */
const KINDS: Record<string, [kind: string, label: string, path?: string]> = {
  task: ['tasks', 'Task', 'tasks'],
  experiment: ['experiments', 'Experiment', 'experiments'],
  'standalone experiment': ['experiments', 'Standalone'],
  reflection: ['reflections', 'Reflection', 'reflections'],
  'reflection lens': ['reflections', 'Lens', 'reflections'],
  'research cycle': ['research', 'Cycle', 'research'],
  'pi turn': ['sessions', 'Agent'],
};
const kindOf = (kind: string) => KINDS[kind] ?? ['', words(kind)];

/**
 * Where a row opens: the record's own page in its project, read as the platform, or the
 * project's Home for a unit with no page; a standalone experiment as its customer sees it.
 */
function opens(row: AdminWorkRow): string | undefined {
  const part = encodeURIComponent;
  if (row.kind === 'standalone experiment')
    return row.requestId && `/admin/standalone/${part(row.requestId)}`;
  const path = kindOf(row.kind)[2];
  return `/ui/admin/p/${part(row.project.id)}/${path ? `${path}/${part(row.id)}` : ''}`;
}

const said = (message: AdminWorkRow['attention'][number]['message']) =>
  typeof message === 'string'
    ? message
    : steadyText(message, { now: clockOf(Date.now()), nameOf: () => undefined });

function Line({ row }: { row: AdminWorkRow }) {
  const [kind, label] = kindOf(row.kind);
  const to = opens(row);
  const [first] = row.terminal ? [] : row.attention;
  const { agent, machine, cost } = row;
  return (
    <tr className={cx(to && 'admin-opens', row.terminal && 'admin-ended')} onClick={openRow}>
      <td className="admin-fill">
        <div className="admin-line">
          <span className="kind admin-kind" style={kindStyle(kind)} title={row.type ?? undefined}>
            {label}
          </span>
          {to ? <Go to={to}>{row.title}</Go> : row.title}
        </div>
        {/* What it needs, under its name: the owner's word, then the owner's sentence. */}
        {first && (
          <div
            className={cx(
              'admin-line admin-attn',
              first.reason === 'allowance' && 'admin-attn--bad',
            )}
            title={row.attention.map((item) => said(item.message)).join('\n')}
          >
            <span className="admin-attn-code">{words(first.code)}</span>{' '}
            <span className="faint">{said(first.message)}</span>
          </div>
        )}
      </td>
      <td className="admin-clip">{row.project.name}</td>
      <td className="admin-clip admin-person">{row.person.label}</td>
      <td>
        {/* A state no word table knows is work under way until its unit has ended. */}
        <Tone tone={toneOf(row.state).replace('neutral', row.terminal ? 'dim' : 'warn')}>
          {words(row.state)}
        </Tone>
      </td>
      <td
        className="admin-clip"
        title={machine?.sandboxId ? undefined : (machine?.provider ?? undefined)}
      >
        {agent && (
          <>
            {words(agent.role)}{' '}
            <span className={`status--${toneOf(agent.status)}`}>{words(agent.status)}</span>
          </>
        )}
        {agent && machine && <span className="ghost"> · </span>}
        {machine && (
          <span title={[machine.provider, machine.phase].filter(Boolean).join(' · ')}>
            {machine.profile ?? machine.provider ?? words(machine.phase)}
            {machine.usdPerHour !== null && (
              <span className="faint tabular"> {usd(machine.usdPerHour)}/h</span>
            )}
          </span>
        )}
        {!agent && !machine && <None />}
      </td>
      <td className="num admin-when">
        <Ago at={row.lastActivity} />
      </td>
      <td className="num faint" title={stamp(row.createdAt)}>
        {elapsed(Date.now() - Date.parse(row.createdAt))}
      </td>
      <td
        className="num"
        title={
          cost
            ? `${cost.reportedSessions} of ${cost.sessions} sessions reported · ${count(cost.inputTokens)} in · ${count(cost.outputTokens)} out · ${duration(cost.wallMs)}`
            : undefined
        }
      >
        {cost ? (
          <>
            {count(cost.inputTokens + cost.outputTokens)}
            <span className="faint"> · {elapsed(cost.wallMs)}</span>
          </>
        ) : (
          <None />
        )}
      </td>
    </tr>
  );
}

/** Live units that need someone first, then by their last activity; what ended, after them. */
const rank = (row: AdminWorkRow) => (row.terminal ? 2 : row.attention.length ? 0 : 1);

export function WorkView() {
  const work = useTool<AdminWork>('/admin/work', {}, { every: 15_000 });
  // An unchanged answer draws nothing again, so the ages count on by themselves.
  useNow(30_000);
  const [ended, setEnded] = useState(false);
  const [kind, setKind] = useState('');
  const [project, setProject] = useState('');
  const [person, setPerson] = useState('');
  const all = work.data?.rows ?? [];
  const seen = all.filter((row) => ended || !row.terminal);
  const filter = useListFilter(seen, {
    stateOf: (row) => row.state,
    labels: (row) => [row.title, row.project.name, row.person.label, row.kind],
    ids: (row) => [row.id],
    also: (row) =>
      (!kind || row.kind === kind) &&
      (!project || row.project.id === project) &&
      (!person || row.person.key === person),
  });
  const rows = [...filter.rows].sort(
    (a, b) => rank(a) - rank(b) || b.lastActivity.localeCompare(a.lastActivity),
  );
  const live = all.filter((row) => !row.terminal);
  const kinds = [...new Set(seen.map((row) => row.kind))].sort();
  const projects = [...new Map(seen.map((row) => [row.project.id, row.project.name]))];
  const people = [...new Map(seen.map((row) => [row.person.key, row.person.label]))];
  const narrowed = filter.filtering || !!(kind || project || person);
  const pick = (
    name: string,
    value: string,
    set: (v: string) => void,
    options: [string, string][],
  ) =>
    options.length > 1 && (
      <label className="admin-pick">
        {name}
        <select className="input" value={value} onChange={(event) => set(event.target.value)}>
          <option value="">All</option>
          {options
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
        </select>
      </label>
    );
  return (
    <div className="admin-page">
      <Lede
        title="Work"
        facts={
          work.data && (
            <>
              <span>
                <b>{live.length}</b> running
              </span>
              {live.some((row) => row.attention.length) && (
                <span>
                  <b>{live.filter((row) => row.attention.length).length}</b> need attention
                </span>
              )}
            </>
          )
        }
      >
        {all.length > live.length && (
          <button
            type="button"
            className={cx('btn btn--quiet', ended && 'btn--on')}
            aria-pressed={ended}
            onClick={() => setEnded(!ended)}
          >
            Ended today <span className="state-n">{all.length - live.length}</span>
          </button>
        )}
        {all.length > 0 && (
          <Narrowing
            reset={
              narrowed
                ? () => {
                    filter.clear();
                    setKind('');
                    setProject('');
                    setPerson('');
                  }
                : undefined
            }
          >
            <SearchField label="Search work" value={filter.query} onChange={filter.setQuery} />
            {kinds.length > 1 && (
              <Chips
                label="Kind"
                options={kinds.map((value) => ({
                  value,
                  label: kindOf(value)[1],
                  count: seen.filter((row) => row.kind === value).length,
                }))}
                value={kind}
                onChange={(value) => setKind(kind === value ? '' : value)}
              />
            )}
            {filter.states.length > 1 && (
              <Chips
                label="State"
                options={filter.states.map(({ value, count }) => ({
                  value,
                  label: words(value),
                  count,
                }))}
                value={filter.state}
                onChange={(value) => filter.setState(filter.state === value ? '' : value)}
              />
            )}
            {pick('Project', project, setProject, projects)}
            {pick('Person', person, setPerson, people)}
          </Narrowing>
        )}
      </Lede>
      <div className="page-stage">
        <Loading read={work} columns={6} />
        {work.data && (
          <div className="admin-surface">
            <table className="admin-table" aria-label="Work">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Project</th>
                  <th>Person</th>
                  <th>State</th>
                  <th>Agent · Machine</th>
                  <th className="num">Activity</th>
                  <th className="num">Age</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Line key={row.id} row={row} />
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={8} className="faint">
                      {narrowed ? 'Nothing matches' : 'Nothing running'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
