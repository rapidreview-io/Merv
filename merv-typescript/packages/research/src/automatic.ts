import {
  clip,
  digest,
  MervError,
  sourceCaller,
  type Caller,
  type DelegationSource,
  type DomainEvents,
  type Scope,
  type State,
  type Transaction,
  type Workflows,
} from '@merv/contracts';

/**
 * A row of research_automation. Its blocker_json column holds `{unavailableSince}`, when the
 * outage the cycle's blocker reports was first seen, whatever codes it has reported since.
 */
export interface AutomaticRow {
  research_id: string;
  project_id: string;
  source_json: string;
  root_id: string;
  cycle_index: number;
  max_cycles: number;
}
/** Why automatic progress waits, as Research publishes it to Workflows; null when it does not. */
export type AutomaticBlocker = { code: string; message: string; status: number } | null;
/** The provider Research's automation blockers are published as. */
export const AUTOMATIC_PROVIDER = 'research';
const NEXT =
  'Automatic research tries again when this project next changes; research.advance moves the cycle by hand, and research.end stops it.';

/** When the outage a cycle's blocker reports was first seen, or NaN when it reports none. */
export const unavailableSince = (blockerJson: string | null): number => {
  try {
    return Date.parse(
      (JSON.parse(blockerJson ?? 'null') as { unavailableSince?: string })?.unavailableSince ?? '',
    );
  } catch {
    return NaN;
  }
};

/** Research's whole opinion of a cycle, written over whatever it said before. */
export async function publishBlocker(
  workflows: Pick<Workflows, 'replaceBlockers'>,
  row: Pick<AutomaticRow, 'project_id' | 'research_id'>,
  blocker: AutomaticBlocker,
  tx: Transaction,
): Promise<void> {
  const held = await tx.get<{ blocker_json: string | null }>(
    'SELECT blocker_json FROM research_automation WHERE research_id=?',
    row.research_id,
  );
  const since = unavailableSince(held?.blocker_json ?? null);
  await tx.run(
    'UPDATE research_automation SET blocker_json=? WHERE research_id=?',
    blocker?.status === 503
      ? JSON.stringify({ unavailableSince: new Date(since || Date.now()).toISOString() })
      : null,
    row.research_id,
  );
  await workflows.replaceBlockers(
    {
      projectId: row.project_id,
      instanceId: row.research_id,
      provider: AUTOMATIC_PROVIDER,
      blockers: blocker ? [{ key: 'automatic', ...blocker, next: NEXT, related: [] }] : [],
    },
    tx,
  );
}

const CONSUMER = 'research.automatic.v3';
/** Retries of one event while the database answers 503: about 25 seconds of backoff in all. */
const UNAVAILABLE_RETRIES = 8;
const TRANSIENT = ['state_timeout', 'state_busy', 'state_unavailable'];

/** Existing durable events drive Research. This neither schedules nor launches workers. */
export async function automaticResearch(
  state: State,
  scope: Scope,
  workflows: Pick<Workflows, 'open' | 'replaceBlockers'>,
  events: DomainEvents,
  reconcile: (caller: Caller, row: AutomaticRow, tx: Transaction) => Promise<AutomaticBlocker>,
  /** Asked to try a cycle that an outage refused again later; it reads what was committed. */
  unavailable: (row: AutomaticRow) => void,
): Promise<() => void | Promise<void>> {
  return await events.subscribe({
    id: CONSUMER,
    // New subscriptions start here; bindAutomatic's startup wake revisits every open cycle.
    from: 'now',
    types: [
      'workflow.transition',
      'workflow.limit_extended',
      'code.publication_verified',
      'code.publication_stale',
      'research.created',
      'research.resume',
      'paper.patched',
      'actor.permissions_changed',
    ],
    handle: async (event, tx) => {
      // Startup and each provider bind ask for a resume; a later one still to come answers this.
      const later = { projectId: event.projectId, type: 'research.resume', after: event.id };
      if (event.type === 'research.resume' && (await state.findEvents(later, 1, tx)).length) return;
      // Only a defining cycle reads the paper, so only it can be unblocked by a patch.
      const cycles = (await workflows.open('research', event.projectId, tx)).filter(
        (cycle) => event.type !== 'paper.patched' || cycle.state === 'defining',
      );
      const rows = await tx.all<AutomaticRow>(
        'SELECT * FROM research_automation WHERE project_id=? AND research_id IN (SELECT jsonb_array_elements_text(?::jsonb)) ORDER BY cycle_index,research_id',
        event.projectId,
        JSON.stringify(cycles.map((cycle) => cycle.id)),
      );
      for (const row of rows) {
        let blocker: AutomaticBlocker;
        // Isolate an expected refusal to this cycle, including any child mutations already made.
        // The effects and the event cursor still share the outer transaction. Unexpected errors
        // retry the event; a permanent domain blocker must not strand every other cycle.
        await tx.run('SAVEPOINT research_automatic_cycle');
        try {
          const source = JSON.parse(row.source_json) as DelegationSource;
          await scope.requireDelegation(source, 'write', tx);
          blocker = await reconcile(sourceCaller(source), row, tx);
          await tx.run('RELEASE SAVEPOINT research_automatic_cycle');
        } catch (error) {
          await tx.run('ROLLBACK TO SAVEPOINT research_automatic_cycle');
          await tx.run('RELEASE SAVEPOINT research_automatic_cycle');
          if (!(error instanceof MervError) || (error.status >= 500 && error.status !== 503))
            throw error;
          // A database that is briefly unavailable is retried with the event, a bounded number
          // of times the consumer's own durable attempt count keeps, before it shows as a blocker.
          // Any other refusal shows at once: the consumer is shared by every project and must
          // not wait on it. An unbound provider's bind wakes the cycle again, and any other
          // outage is tried again later, as nothing else may happen in this project.
          if (TRANSIENT.includes(error.code)) {
            const consumer = (await events.status()).find((item) => item.id === CONSUMER);
            if ((consumer?.attempts ?? UNAVAILABLE_RETRIES) < UNAVAILABLE_RETRIES) throw error;
          }
          blocker = automaticBlocker(error);
          if (error.status === 503) unavailable(row);
        }
        await publishBlocker(workflows, row, blocker, tx);
      }
    },
  });
}

export const automaticBlocker = (error: MervError): AutomaticBlocker => ({
  code: error.code,
  message: clip(error.message, 2000),
  status: error.status,
});

export const automaticRequest = (cycle: string, revision: number, action: string) =>
  `research-auto:${digest({ cycle, revision, action })}`;
