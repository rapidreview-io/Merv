import { useState } from 'react';
import type { AdminWork, AdminWorkRow } from '@merv/admin/models';
import { useTool } from '../api';
import {
  Ago,
  PageHeader,
  Ruled,
  Word,
  col,
  cx,
  kindStyle,
  stamp,
  toneOf,
  useNow,
  words,
} from '../components';
import { Chips, ListPage, openRow, useListFilter } from '../list-filters';
import { clockOf, duration, elapsed } from '../liveness';
import { valueText } from '../views/running-phrase';
import { Facts, Go, None, count, fig, usd } from './parts';

/** Each workflow the table names: the record kind it wears the colour of, its word, its path. */
const KINDS: Record<string, [kind: string, label: string, path?: string]> = {
  task: ['tasks', 'Task', 'tasks'],
  experiment: ['experiments', 'Experiment', 'experiments'],
  service_experiment: ['experiments', 'Standalone'],
  reflection: ['reflections', 'Reflection', 'reflections'],
  'reflection.lens': ['reflections', 'Lens', 'reflections'],
  research: ['research', 'Cycle', 'research'],
  pi: ['sessions', 'Agent'],
};
const kindOf = (kind: string) => KINDS[kind] ?? ['', words(kind)];

/**
 * Where a row opens: the record's own page in its project, read as the platform, or the
 * project's Home for a unit with no page; a standalone experiment as its customer sees it.
 */
function opens(row: AdminWorkRow): string | undefined {
  const part = encodeURIComponent;
  if (row.kind === 'service_experiment')
    return row.requestId && `/admin/standalone/${part(row.requestId)}`;
  const path = kindOf(row.kind)[2];
  return `/ui/admin/p/${part(row.project.id)}/${path ? `${path}/${part(row.id)}` : ''}`;
}

const said = (message: AdminWorkRow['attention'][number]['message']) =>
  typeof message === 'string'
    ? message
    : (message ?? [])
        .map((value) => valueText(value, { now: clockOf(Date.now()), nameOf: () => undefined }))
        .join('');

const COLUMNS = [
  col<AdminWorkRow>('title', 'Title', (row) => {
    const [kind, label] = kindOf(row.kind);
    const to = opens(row);
    const [first] = row.terminal ? [] : row.attention;
    return (
      <>
        {/* A part stands under the unit it is part of, by its own name alone. */}
        {!row.parent && (
          <span className="kind admin-kind" style={kindStyle(kind)} title={row.type ?? undefined}>
            {label}
          </span>
        )}
        {to ? <Go to={to}>{row.title}</Go> : row.title}
        {/* What it needs, under its name: the owner's word, then the owner's own, if any. */}
        {first && (
          <div
            className={cx('admin-attn', first.reason === 'allowance' && 'admin-attn--bad')}
            title={row.attention.map((item) => said(item.message)).join('\n') || undefined}
          >
            {/* The owner's code, unless its own words already say it, then those words. */}
            {said(first.message).toLowerCase().startsWith(words(first.code).toLowerCase()) ? (
              <span className="admin-attn-code">{said(first.message)}</span>
            ) : (
              <>
                <span className="admin-attn-code">{words(first.code)} </span>
                {first.message && <span className="faint">{said(first.message)}</span>}
              </>
            )}
          </div>
        )}
      </>
    );
  }),
  col<AdminWorkRow>('project', 'Project', (row) => row.project.name),
  col<AdminWorkRow>('person', 'Person', (row) => row.person),
  col<AdminWorkRow>('state', 'State', (row) => (
    // A state no word table knows is work under way until its unit has ended.
    <Word
      tone={toneOf(row.state).replace('neutral', row.terminal ? 'dim' : 'warn')}
      value={row.state}
    />
  )),
  col<AdminWorkRow>('agent', 'Agent · Machine', ({ agent, machine }) =>
    !agent && !machine ? (
      <None />
    ) : (
      <span>
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
      </span>
    ),
  ),
  fig<AdminWorkRow>('activity', 'Activity', (row) => (
    <Ago at={row.lastActivity} className="countdown" />
  )),
  fig<AdminWorkRow>('age', 'Age', (row) => (
    <span className="faint" title={stamp(row.createdAt)}>
      {elapsed(Date.now() - Date.parse(row.createdAt))}
    </span>
  )),
  // What its closed visits measured, each figure only where it is not zero.
  fig<AdminWorkRow>('cost', 'Usage', ({ cost: c }) => {
    const tokens = c ? c.inputTokens + c.outputTokens : 0;
    const figures = [tokens > 0 && count(tokens), c && c.wallMs >= 1000 && elapsed(c.wallMs)];
    return c && figures.some(Boolean) ? (
      <span
        title={`${c.reportedSessions} of ${c.sessions} sessions reported · ${count(c.inputTokens)} in · ${count(c.outputTokens)} out · ${duration(c.wallMs)}`}
      >
        {figures.filter(Boolean).join(' · ')}
      </span>
    ) : (
      <None />
    );
  }),
];

/** Live units that need someone first, then by their last activity; what ended, after them. */
const rank = (row: AdminWorkRow) => (row.terminal ? 2 : row.attention.length ? 0 : 1);

export function WorkView() {
  const work = useTool<AdminWork>('/admin/work', {}, { every: 15_000 });
  // An unchanged answer draws nothing again, so the ages count on by themselves.
  useNow(30_000);
  const [ended, setEnded] = useState(false);
  const [kind, setKind] = useState('');
  const all = work.data?.rows ?? [];
  const filter = useListFilter(all, {
    stateOf: (row) => row.state,
    labels: (row) => [row.title, row.project.name, row.person, kindOf(row.kind)[1]],
    ids: (row) => [row.id],
    also: (row) => (ended || !row.terminal) && (!kind || row.kind === kind),
  });
  // Each part right under its unit, where that unit is listed too: the unit ranks by its most
  // pressing part and sorts by the latest activity among them.
  const listed = new Set(filter.rows.map((row) => row.id));
  const parts = (unit: AdminWorkRow) => filter.rows.filter((row) => row.parent === unit.id);
  const key = (unit: AdminWorkRow) => {
    const all = [unit, ...parts(unit)];
    return [
      Math.min(...all.map(rank)),
      all
        .map((row) => row.lastActivity)
        .sort()
        .at(-1)!,
    ] as const;
  };
  const rows = filter.rows
    .filter((row) => !row.parent || !listed.has(row.parent))
    .sort((a, b) => key(a)[0] - key(b)[0] || key(b)[1].localeCompare(key(a)[1]))
    .flatMap((unit) => [unit, ...parts(unit)]);
  const live = all.filter((row) => !row.terminal);
  const kinds = [...new Set(all.map((row) => row.kind))].sort();
  const clear = () => {
    filter.clear();
    setKind('');
    setEnded(false);
  };
  return (
    <ListPage
      load={work}
      noun="work"
      kind=""
      filter={{ ...filter, clear }}
      rows={rows}
      lede={(ends) => (
        <PageHeader
          title="Work"
          summary={
            work.data && (
              <Facts
                facts={[
                  [live.length, 'running'],
                  live.some((row) => row.attention.length) && [
                    live.filter((row) => row.attention.length).length,
                    'need attention',
                  ],
                ]}
              />
            )
          }
          actions={ends}
        />
      )}
      reset={filter.filtering || kind || ended ? clear : undefined}
      narrow={
        <>
          {kinds.length > 1 && (
            <Chips
              label="Kind"
              options={kinds.map((value) => ({
                value,
                label: kindOf(value)[1],
                count: all.filter((row) => (ended || !row.terminal) && row.kind === value).length,
              }))}
              value={kind}
              onChange={(value) => setKind(kind === value ? '' : value)}
            />
          )}
          {all.length > live.length && (
            <Chips
              label="Ended"
              options={[{ value: 'ended', label: 'Ended today', count: all.length - live.length }]}
              value={ended ? 'ended' : ''}
              onChange={() => setEnded(!ended)}
            />
          )}
        </>
      }
      listed={false}
      drawn={
        rows.length > 0 && (
          <Ruled
            label="Work"
            template="minmax(0, 3fr) minmax(0, 1fr) minmax(0, 0.8fr) 112px minmax(0, 1.2fr) 72px 40px 56px"
            columns={COLUMNS}
            rows={rows}
            keyOf={(row) => row.id}
            row={(row) => ({
              className: cx(
                'admin-line',
                opens(row) && 'admin-opens',
                row.terminal && 'admin-ended',
                row.parent && listed.has(row.parent) && 'admin-part',
              ),
              onClick: (event) => openRow(event, 'a'),
            })}
          />
        )
      }
      emptyTitle="Nothing running"
      columns={6}
    />
  );
}
