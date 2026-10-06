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
import type { ResearchAutomation } from './models.js';

export interface AutomaticRow {
  research_id: string;
  project_id: string;
  source_json: string;
  root_id: string;
  cycle_index: number;
  max_cycles: number;
  blocker_json: string | null;
}
export const automaticStatus = (row: AutomaticRow): ResearchAutomation => ({
  rootId: row.root_id,
  cycle: row.cycle_index,
  maxCycles: row.max_cycles,
  blocker: row.blocker_json ? JSON.parse(row.blocker_json) : null,
});

/** Existing durable events drive Research. This neither schedules nor launches workers. */
export async function automaticResearch(
  state: State,
  scope: Scope,
  workflows: Pick<Workflows, 'open'>,
  events: DomainEvents,
  reconcile: (
    caller: Caller,
    row: AutomaticRow,
    tx: Transaction,
  ) => Promise<ResearchAutomation['blocker']>,
): Promise<() => void | Promise<void>> {
  return await events.subscribe({
    id: 'research.automatic.v3',
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
      const later = "SELECT 1 FROM events WHERE project_id=? AND type='research.resume' AND id>?";
      if (event.type === 'research.resume' && (await tx.get(later, event.projectId, event.id)))
        return;
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
        let blocker: ResearchAutomation['blocker'];
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
          blocker = automaticBlocker(error);
        }
        await recordBlocker(state, tx, row, blocker, { causeEventId: event.id });
      }
    },
  });
}

export const automaticBlocker = (error: MervError): ResearchAutomation['blocker'] => ({
  code: error.code,
  message: clip(error.message, 2000),
});

/**
 * Replaces the blocker a cycle shows. The consumer writes over whatever it found, as the
 * advance it made may already have cleared one; a deferred advance writes only over the marker
 * it was left, so a reconcile since is never overwritten. The change is an event, so a reader
 * learns of it the way it learns of every other.
 */
export async function recordBlocker(
  state: State,
  tx: Transaction,
  row: Pick<AutomaticRow, 'research_id' | 'project_id' | 'source_json' | 'blocker_json'>,
  blocker: ResearchAutomation['blocker'],
  options: { causeEventId?: number; onlyOver?: string } = {},
): Promise<void> {
  const encoded = blocker ? JSON.stringify(blocker) : null;
  if (encoded === row.blocker_json) return;
  const { onlyOver } = options;
  const written = await tx.run(
    `UPDATE research_automation SET blocker_json=? WHERE research_id=?${onlyOver === undefined ? '' : ' AND blocker_json=?'}`,
    encoded,
    row.research_id,
    ...(onlyOver === undefined ? [] : [onlyOver]),
  );
  if (!written.changes) return;
  await state.appendEvent(tx, {
    projectId: row.project_id,
    actorId: JSON.parse(row.source_json).actorId,
    type: 'research.automatic_status',
    subjectId: row.research_id,
    data: {
      performedBy: 'system:research',
      ...(options.causeEventId ? { causeEventId: options.causeEventId } : {}),
      blocker,
    },
  });
}

export const automaticRequest = (cycle: string, revision: number, action: string) =>
  `research-auto:${digest({ cycle, revision, action })}`;
