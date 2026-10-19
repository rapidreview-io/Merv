import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdminWork, AdminWorkRow } from '@merv/admin/models';
import { useTool } from '../api';
import { Ago, Ruled, col, cx, kindStyle, stamp, toneOf, useNow, words } from '../components';
import { Chips, ListPage, openRow, useListFilter } from '../list-filters';
import { clockOf, duration, elapsed } from '../liveness';
import { formatMoney } from '../views/remote-fields';
import { valueText } from '../views/running-phrase';
import { Head, State, count, fact, fig } from './parts';

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
  return `/admin/p/${part(row.project.id)}/${path ? `${path}/${part(row.id)}` : ''}`;
}

type Need = AdminWorkRow['attention'][number];
const said = ({ message }: Need) =>
  typeof message === 'string'
    ? message
    : (message ?? [])
        .map((value) => valueText(value, { now: clockOf(Date.now()), nameOf: () => undefined }))
        .join('');
/** A need's word: the owner's code, and a customer's move as what the unit waits on. */
const named = (need: Need) => (need.reason === 'customer' ? 'waits on ' : '') + words(need.code);
/** A word in its tone. */
const status = (value: string) => (
  <span className={`status--${toneOf(value)}`}>{words(value)}</span>
);
/** What a unit needs reads in its tone, and so does its state while it needs it. */
const toneOfNeed = (row: AdminWorkRow) =>
  !row.terminal && row.attention[0] && (row.attention[0].reason === 'allowance' ? 'bad' : 'warn');

const COLUMNS = [
  col<AdminWorkRow>('title', 'Title', (row) => {
    const [kind, label] = kindOf(row.kind);
    const to = opens(row);
    const [first] = row.terminal ? [] : row.attention;
    const says = first ? said(first) : '';
    const lower = (text: string) => text.toLowerCase();
    // The owner's code, unless its state or its own words already say it; then those words.
    const stated = !!first && lower(words(row.state)).includes(lower(words(first.code)));
    const code = !!first && !stated && !lower(says).startsWith(lower(named(first)));
    return (
      <>
        {/* A part stands under the unit it is part of, by its own name alone. */}
        {!row.parent && (
          <span className="kind admin-kind" style={kindStyle(kind)} title={row.type}>
            {label}
          </span>
        )}
        {/* A drill-in is an app of its own, loaded whole; a page of this one is routed. */}
        {to ? (
          <Link className="admin-name" to={to} reloadDocument={to.startsWith('/admin/p/')}>
            {row.title}
          </Link>
        ) : (
          row.title
        )}
        {/* What it needs, under its name. */}
        {first && (code || says) && (
          <div className="admin-attn" title={row.attention.map(said).join('\n') || undefined}>
            <span className={`admin-attn-code status--${toneOfNeed(row)}`}>
              {code ? `${named(first)} ` : says}
            </span>
            {code && <span className="faint">{says}</span>}
          </div>
        )}
      </>
    );
  }),
  // A project named as its row is the row's own: a standalone experiment's, its intake's.
  fact<AdminWorkRow>('project', 'Project', ({ project, title }) =>
    project.name === title ? null : project.name,
  ),
  col<AdminWorkRow>('person', 'Person', (row) => row.person),
  col<AdminWorkRow>('state', 'State', (row) => (
    <State value={row.state} ended={row.terminal} need={toneOfNeed(row)} />
  )),
  // A machine by its profile, and its phase until it runs; what it costs an hour in its title.
  fact<AdminWorkRow>('agent', 'Agent ·\u00a0Machine', ({ agent, machine: m }) =>
    agent || m ? (
      <span className="admin-parts">
        {agent && (
          <span>
            {words(agent.role)} {status(agent.status)}
          </span>
        )}
        {agent && m && ' '}
        {m && (
          <span
            title={[m.provider, m.usdPerHour !== null && formatMoney(undefined, m.usdPerHour)]
              .filter(Boolean)
              .join(' · ')}
          >
            {/* The separator goes with the machine, so a narrow cell wraps both together. */}
            {agent && <span className="ghost">· </span>}
            {m.profile ?? m.provider}
            {(m.phase !== 'running' || !(m.profile ?? m.provider)) && <> {status(m.phase)}</>}
          </span>
        )}
      </span>
    ) : null,
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
    ) : null;
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
  const shown = (row: AdminWorkRow) => ended || !row.terminal;
  const filter = useListFilter(all, {
    stateOf: (row) => row.state,
    labels: (row) => [row.title, row.project.name, row.person, kindOf(row.kind)[1]],
    ids: (row) => [row.id],
    also: (row) => shown(row) && (!kind || row.kind === kind),
  });
  // Each part right under its unit, where that unit is listed too: the unit ranks by its most
  // pressing part and sorts by the latest activity among them.
  const listed = new Set(filter.rows.map((row) => row.id));
  const part = (row: AdminWorkRow) => !!row.parent && listed.has(row.parent);
  const family = (unit: AdminWorkRow) => [unit, ...filter.rows.filter((r) => r.parent === unit.id)];
  const rankOf = (unit: AdminWorkRow) => Math.min(...family(unit).map(rank));
  const latest = (unit: AdminWorkRow) =>
    Math.max(...family(unit).map((row) => Date.parse(row.lastActivity)));
  const rows = filter.rows
    .filter((row) => !part(row))
    .sort((a, b) => rankOf(a) - rankOf(b) || latest(b) - latest(a))
    .flatMap(family);
  const live = all.filter((row) => !row.terminal);
  // Units, not their parts: those open, and those an agent works on, or on a part of (a live
  // Agent conversation is its agent at work).
  const open = live.filter((row) => !row.parent).length;
  const active = live.filter((row) => row.kind === 'pi' || row.agent?.status === 'active');
  const working = new Set(active.map((row) => row.parent ?? row.id)).size;
  const needs = live.filter((row) => row.attention.length).length;
  const kinds = [...new Set(all.map((row) => row.kind))].sort();
  const narrowed = filter.filtering || kind || ended;
  // The state column as wide as its longest word, which it never cuts: set a size under the
  // row's, about 0.8ch a letter, after its dot.
  const widest = Math.max(5, ...rows.map((row) => row.state.length));
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
        <Head
          title="Work"
          ends={ends}
          facts={
            work.data && [
              [open, 'open'],
              working > 0 && [working, 'working'],
              needs > 0 && [needs, 'need attention'],
            ]
          }
        />
      )}
      reset={narrowed ? clear : undefined}
      narrow={
        <>
          {kinds.length > 1 && (
            <Chips
              label="Kind"
              options={kinds.map((value) => ({
                value,
                label: kindOf(value)[1],
                count: all.filter((row) => shown(row) && row.kind === value).length,
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
            template={`minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 0.5fr) calc(${widest} * 0.8ch + 16px) minmax(0, 1.25fr) 72px 40px 56px`}
            columns={COLUMNS}
            rows={rows}
            keyOf={(row) => row.id}
            row={(row) => ({
              className: cx(
                'admin-line',
                opens(row) && 'admin-opens',
                row.terminal && 'admin-ended',
                part(row) && 'admin-part',
              ),
              onClick: (event) => openRow(event, 'a'),
            })}
          />
        )
      }
      emptyTitle="Nothing open"
      columns={6}
    />
  );
}
