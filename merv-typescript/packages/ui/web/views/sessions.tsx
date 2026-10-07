import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RunnerPlatform } from '@merv/contracts/types';
import { accountRequest, useTool } from '../api';
import {
  Ago,
  ConfirmAction,
  Countdown,
  KV,
  KindLabel,
  Live,
  LoadState,
  Ruled,
  Stamp,
  StatusPill,
  col,
  cx,
  term,
  useNow,
  type KVRow,
} from '../components';
import { ArrowRightIcon } from '../icons';
import { Segments } from '../list-filters';
import { rowOf } from '../navigation';
import { clock, decisionLiveness, runnerLiveness, type Clock } from '../liveness';
import { useCommand } from '../mutations';
import { useScopeKey, useSession } from '../session';
import type { ViewProps } from './index';
import { holding, leaseLiveness } from './threads';
import { AgentsGallery } from './agents-gallery';
import type {
  DispatchState,
  RunnerPresence,
  SessionSummary,
  SessionsProjectStatus,
} from '@merv/sessions/models';
import { platformPhrase } from '@merv/sessions/rules';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** How much of a list this read holds: all of it, or the newest part of a larger total. */
const portion = (shown: number, total: number) => (total > shown ? `${shown} of ${total}` : total);
/** What a runner offers, in its own order; a platform it has paused says so. */
const platformList = (platforms: RunnerPlatform[]) =>
  platforms
    .map(
      (one) => `${one.name}${one.model ? ` · ${one.model}` : ''}${one.enabled ? '' : ' (paused)'}`,
    )
    .join(', ') || <span className="ghost">—</span>;
const workspacePhrase = ({ workspace, workspaceMode }: SessionSummary) => {
  if (!workspace)
    return workspaceMode === 'none' ? 'none · scratch' : `${term(workspaceMode)} · not attached`;
  const result = workspace.result;
  return [
    `${term(workspace.attachment.mode)} · ${result ? 'captured' : 'attached'}`,
    (result ?? workspace.attachment).headOid.slice(0, 7),
    result && `${result.stats.filesChanged} changed files · ${result.stats.commitCount} commits`,
  ]
    .filter(Boolean)
    .join(' · ');
};

/**
 * A halt, reported as it happened. `mutations.ts` keeps the command through an
 * answer that never arrived and says the result is unknown, instead of reading
 * as a refusal; and the count the server returns is stated either way, so a halt
 * that closed nothing can never look like one that closed something. Halt is
 * idempotent server-side — a closed lease is skipped — so the retry is the same
 * request and carries no request id.
 */
function useHalt(path: string, reload: () => void, nothing: string) {
  const [halted, setHalted] = useState<number>();
  const answer = useRef<number>();
  const command = useCommand<{ halted: number }>({
    tool: path,
    send: (body) => accountRequest(path, { method: 'POST', body, scoped: true }),
    validate: (result) => typeof result.halted === 'number',
    idempotent: true,
    onSuccess: (result) => {
      answer.current = result.halted;
      setHalted(result.halted);
      reload();
    },
  });
  return {
    /** The guard's own words, its busy label and what the command answered inside it. */
    guard: (label: string) => ({
      label,
      confirm: command.retry ? 'Retry halt' : label,
      busy: command.busy ? 'Halting…' : undefined,
      note:
        command.error || halted === 0 ? (
          <p className="error-message" role="alert">
            {command.error ?? nothing}
          </p>
        ) : null,
      async onConfirm() {
        answer.current = undefined;
        await command.submit({ reason: 'halted_by_operator' });
        return (answer.current ?? 0) > 0;
      },
    }),
    /** What it closed, stated where it was asked. */
    receipt: halted ? (
      <p className="muted" role="status">
        Halted {count(halted, 'lease', 'leases')}.
      </p>
    ) : null,
  };
}

/**
 * One lease, two lines on one grid: identity above, liveness below, and no fact
 * on both. The body is a toggle and nothing else, so what a person scans stays
 * on the row and the rest — the absolute lease stamps, the platform — waits in
 * the panel, whose first line is the link back to the work. The guard, its answer
 * and its busy label all belong to this row, so no lease's failure is reported
 * over another's.
 */
function LeaseRow({
  session,
  name,
  route,
  now,
  open,
  onToggle,
  canManage,
  reload,
}: {
  session: SessionSummary;
  name?: string;
  route?: { to: string; kind: string };
  now: Clock;
  open: boolean;
  onToggle(): void;
  canManage: boolean;
  reload(): void;
}) {
  const panelId = `lease-${session.id}`;
  const held = holding(session);
  const work = session.name;
  const halt = useHalt(
    `/sessions/${encodeURIComponent(session.id)}/halt`,
    reload,
    'Nothing was halted. This lease had already closed.',
  );
  const rows: KVRow[] = [
    ['Offered', <Stamp at={session.createdAt} />],
    !!session.activatedAt && ['Taken up', <Stamp at={session.activatedAt} />],
    [held ? 'Lease expires' : 'Lease ran to', <Stamp at={session.expiresAt} />],
    !!session.closedAt && ['Closed', <Stamp at={session.closedAt} />],
    !!session.platform && ['Platform', platformPhrase(session.platform)],
    ['Workspace', <span className="wrap">{workspacePhrase(session)}</span>],
  ];
  return (
    <div className={`lease${open ? ' lease--open' : ''}`}>
      <button
        type="button"
        className="ruled-row lease-row"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onToggle}
      >
        <span className="wrap">{name ?? term(null)}</span>
        <strong>{work}</strong>
        <span className="muted" data-label="Role">
          {term(session.role)}
        </span>
        <span data-label="Expires">
          <Countdown to={held ? session.expiresAt : null} now={now} />
        </span>
      </button>
      <div className="lease-live">
        <Live of={leaseLiveness(session, now)} />
      </div>
      {open && (
        <div className="lease-panel stack" id={panelId}>
          {route && (
            <Link className="cluster agent-help hit" to={route.to}>
              <KindLabel kind={route.kind} />
              Open record <ArrowRightIcon size={14} />
            </Link>
          )}
          <KV rows={rows} />
          {canManage && held && (
            <div className="act-danger">
              <ConfirmAction {...halt.guard('Halt lease')} title="Halt this lease?">
                <p>
                  {name ?? 'An unnamed agent'} holds this lease on {work} as {term(session.role)}.
                  Halting closes it now; its runner must stop the worker itself.
                </p>
                <p className="muted">
                  The assignment is released back to the queue. No verdict, claim standing or review
                  state changes.
                </p>
              </ConfirmAction>
            </div>
          )}
          {halt.receipt}
        </div>
      )}
    </div>
  );
}

/**
 * The machines behind the agents: dispatch, the runners and every lease, a press under the
 * Agents gallery.
 */
/** Whether a lease or a runner is live now: the page's clock ticks, and its read is quick, only
 *  then, so an idle Agents page costs nothing. */
const busy = (status: SessionsProjectStatus | undefined) =>
  (status?.liveSessionCount ?? 0) > 0 || (status?.runners ?? []).some((runner) => runner.live);
const cadenceOf = (status: SessionsProjectStatus | undefined) => (busy(status) ? 4000 : 15000);

export function MachinesPanel({ row, shell, me }: ViewProps & { me: string }) {
  const state = useTool<SessionsProjectStatus>('ui.read', { rowId: row.id }, { every: cadenceOf });
  const [open, setOpen] = useState<string>();
  const [already, setAlready] = useState<string>();
  const status = state.data;
  const liveCount = status?.liveSessionCount ?? 0;
  // A lease is named by the machine it runs on, as the Runners table names it; a runner that
  // table does not name is its id, shortened.
  const hosts = new Map(
    status?.runners.map((runner) => [runner.runnerId, runner.machine.hostname]),
  );
  const hostOf = ({ runnerId: id }: SessionSummary) =>
    hosts.get(id) ?? (id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);
  const cadence = cadenceOf(status);
  const tick = useNow(busy(status) ? 1000 : 0);
  // Every duration is measured from the payload's own server clock, so browser
  // skew never reaches one, and past two cadences the page states the age of what
  // it is showing instead of counting on against a fact nobody has refreshed.
  const now = clock(status?.observedAt, state.loadedAt, tick, cadence * 2);
  const haltAll = useHalt(
    '/sessions/halt',
    state.reload,
    'Nothing was halted. No lease was live; automatic dispatch is off.',
  );
  // The button sends the state it means, never a flip of what it last read, and the
  // answer names the case where someone else had already set it.
  const dispatch = useCommand<{ dispatch: DispatchState }>({
    tool: '/sessions/dispatch',
    send: (body) => accountRequest('/sessions/dispatch', { method: 'PUT', body, scoped: true }),
    validate: (result) => typeof result.dispatch?.enabled === 'boolean',
    idempotent: true,
    onSuccess: (result) => {
      setAlready(
        result.dispatch.updatedBy === me || result.dispatch.enabled === status?.dispatch.enabled
          ? undefined
          : `Dispatch was already ${result.dispatch.enabled ? 'on' : 'off'}.`,
      );
      state.reload();
    },
  });
  // A lease's record opens on the row that lists its workflow, as a record a text names does.
  const routeOf = ({ workflow, instanceId }: SessionSummary) => {
    const owner = workflow && rowOf(shell.rows, workflow);
    return owner ? { to: `${owner.path}/${instanceId}`, kind: owner.view.kind } : undefined;
  };
  // Every machine Fleet was asked for, the ended ones too: its own page, a step further.
  const fleet = shell.rows.find((entry) => entry.id === 'fleet');
  const live = (status?.sessions ?? []).filter((session) => holding(session));
  // A lease that ended more than a day ago is history, one control away rather than the page.
  const [older, showOlder] = useState(false);
  const leases = (status?.sessions ?? []).filter(
    (session) =>
      older ||
      holding(session) ||
      now.at - Date.parse(session.closedAt ?? session.expiresAt) < 86_400_000,
  );
  const machines = [
    col<RunnerPresence>('machine', 'Machine', (runner) => (
      <>
        <strong>{runner.machine.hostname}</strong>
        <div className="faint">
          {runner.machine.system} · {runner.machine.architecture}
        </div>
      </>
    )),
    col<RunnerPresence>('live', 'Presence', (runner) => <Live of={runnerLiveness(runner, now)} />),
    col<RunnerPresence>('decision', 'Last dispatch', (runner) => (
      <Live of={decisionLiveness(runner, now)} />
    )),
    col<RunnerPresence>('platforms', 'Platforms', (runner) => platformList(runner.platforms)),
    col<RunnerPresence>('capacity', 'Capacity', (runner) => runner.capacity),
    col<RunnerPresence>('settings', 'Settings', (runner) => (
      <StatusPill
        value={runner.desiredVersion > (runner.appliedVersion ?? 0) ? 'pending' : 'applied'}
      />
    )),
  ];
  return (
    <>
      {/* The page's subject is the page: dispatch, the machines and the leases are what a
          person came for, so none of them waits behind a control. Each says how it stands
          in an element — a pill, a count beside its name, rows — and a section holding
          nothing is its name and a zero. What waits for an agent is on the Work page's map. */}
      {/* A failed refresh is one line over the page it leaves in place. */}
      {(!status || state.error) && <LoadState {...state} />}
      {status && (
        <div className="stack stack--lg sessions-ops">
          {/* Every machine Fleet was asked for is a step further. */}
          {fleet && (
            <p className="cluster muted">
              <Link to={fleet.path}>Fleet requests</Link>
            </p>
          )}
          <section className="stack" aria-label="Dispatch">
            <div className="dispatch">
              <h2 className="section-title">Dispatch</h2>
              {/* Switched on with no live runner to hand work to, nothing runs: it waits. */}
              <StatusPill
                value={
                  !status.dispatch.enabled
                    ? 'paused'
                    : status.runners.some((runner) => runner.live)
                      ? 'running'
                      : 'waiting'
                }
              />
              {status.dispatch.updatedAt && (
                <span className="faint agent-help">
                  {status.dispatch.updatedBy === me && 'you · '}
                  <Ago at={status.dispatch.updatedAt} />
                </span>
              )}
              {status.canManage && status.dispatch.fleet && (
                <Segments<'fleet' | 'own'>
                  label="Machines"
                  options={[
                    { value: 'fleet', label: 'Fleet' },
                    { value: 'own', label: 'Own machines' },
                  ]}
                  value={status.dispatch.ownMachines ? 'own' : 'fleet'}
                  onChange={(value) => void dispatch.submit({ ownMachines: value === 'own' })}
                />
              )}
              {/* One control, and it says the state it will set: starting is the page's
                  one primary, and pausing what runs is never dressed as an invitation. */}
              {status.canManage && (
                <button
                  type="button"
                  className={cx('btn', !status.dispatch.enabled && 'btn--primary')}
                  disabled={dispatch.busy}
                  onClick={() => {
                    setAlready(undefined);
                    void dispatch.submit({ enabled: !status.dispatch.enabled });
                  }}
                >
                  {status.dispatch.enabled ? 'Pause dispatch' : 'Start dispatch'}
                </button>
              )}
            </div>
            {dispatch.error && (
              <p className="error-message" role="alert">
                {dispatch.error}
              </p>
            )}
            {already && (
              <p className="muted" role="status">
                {already}
              </p>
            )}
          </section>
          <section className="stack">
            <h2 className="section-title">
              Runners{' '}
              <span className="section-n">
                {portion(status.runners.length, status.runnerTotal)}
              </span>
            </h2>
            {status.runners.length > 0 && (
              <Ruled
                label="Runners"
                template="minmax(0, 1.3fr) minmax(0, 1.1fr) minmax(0, 1.4fr) minmax(0, 1.4fr) 72px 104px"
                rows={status.runners}
                keyOf={(runner) => runner.id}
                columns={machines}
              />
            )}
          </section>
          <section className="stack">
            <div className="cluster cluster--between">
              <h2 className="section-title">
                Leases{' '}
                <span className="section-n">
                  {portion(status.sessions.length, status.sessionTotal)} · {liveCount} live
                </span>
              </h2>
              {/* What ends every lease at once stands with the leases it ends, in the
                  refusal's colour, and asks before it acts. */}
              {status.canManage && live.length > 0 && (
                <div className="act-danger">
                  <ConfirmAction
                    {...haltAll.guard('Halt all leases')}
                    title={`Halt ${count(liveCount, 'live lease', 'live leases')} and dispatch?`}
                  >
                    <ul className="guard-list">
                      {live.map((session) => (
                        <li key={session.id}>
                          {session.name} · {term(session.role)} · {hostOf(session)}
                        </li>
                      ))}
                      {/* The guard names every lease under the click, including the
                          ones past this read's 200-row window. */}
                      {liveCount > live.length && <li>{liveCount - live.length} more</li>}
                    </ul>
                    <p className="muted">
                      Each lease closes now and automatic dispatch stops, so nothing new is offered
                      until you start it again; connected runners must stop their own workers. Each
                      assignment is released back to the queue. No verdict, claim standing or review
                      state changes.
                    </p>
                  </ConfirmAction>
                </div>
              )}
            </div>
            {haltAll.receipt}
            {leases.length > 0 && (
              <div className="ruled lease-list">
                <div className="ruled-head">
                  {['Agent', 'Work', 'Role', 'Expires'].map((head) => (
                    <span className="label" key={head}>
                      {head}
                    </span>
                  ))}
                </div>
                {leases.map((session) => (
                  <LeaseRow
                    key={session.id}
                    session={session}
                    now={now}
                    route={routeOf(session)}
                    name={hostOf(session)}
                    canManage={status.canManage}
                    reload={state.reload}
                    open={open === session.id}
                    onToggle={() =>
                      setOpen((current) => (current === session.id ? undefined : session.id))
                    }
                  />
                ))}
              </div>
            )}
            {leases.length < status.sessions.length && (
              <div>
                <button type="button" className="btn-text" onClick={() => showOlder(true)}>
                  Show all {status.sessions.length}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}

/** The Agents page: the gallery of the project's agents, and the machines a press under it. */
function AgentsPage(props: ViewProps & { me: string }) {
  const [machines, showMachines] = useState(false);
  return (
    <div className="page-stage stack stack--lg">
      <AgentsGallery />
      <section className="stack" aria-label="Machines">
        <div>
          <button
            type="button"
            className="btn-text agents-recent"
            aria-expanded={machines}
            onClick={() => showMachines((open) => !open)}
          >
            Machines {machines ? '▾' : '▸'}
          </button>
        </div>
        {machines && <MachinesPanel {...props} />}
      </section>
    </div>
  );
}

export const SessionsView = (props: ViewProps) => {
  const { actor } = useSession();
  return <AgentsPage key={useScopeKey()} me={actor.id} {...props} />;
};
