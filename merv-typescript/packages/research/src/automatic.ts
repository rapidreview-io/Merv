import {
  clip,
  digest,
  MervError,
  type Caller,
  type DelegationSource,
  type DomainEvents,
  type Scope,
  type State,
  type Transaction,
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

/** Reconstitute only an already verified delegation. Never turn a worker into an owner. */
function delegatedCaller(source: DelegationSource): Caller {
  const base = { actorId: source.actorId, projectId: source.projectId };
  if (source.kind === 'actor') return { ...base, credentialId: source.credentialId };
  if (source.kind === 'key')
    return { ...base, key: { id: source.keyId, membershipId: source.membershipId } };
  return {
    ...base,
    human: {
      issuer: source.issuer,
      subject: source.subject,
      membershipId: source.membershipId,
      expiresAt: '9999-12-31T23:59:59.999Z',
    },
  };
}

/** Existing durable events drive Research. This neither schedules nor launches workers. */
export async function automaticResearch(
  state: State,
  scope: Scope,
  events: DomainEvents,
  reconcile: (
    caller: Caller,
    row: AutomaticRow,
    tx: Transaction,
  ) => Promise<ResearchAutomation['blocker']>,
): Promise<() => void | Promise<void>> {
  return await events.subscribe({
    id: 'research.automatic.v1',
    from: 'beginning',
    types: [
      'workflow.transition',
      'workflow.limit_extended',
      'research.created',
      'research.resume',
      'paper.patched',
      'actor.permissions_changed',
    ],
    handle: async (event, tx) => {
      const rows = await tx.all<AutomaticRow>(
        "SELECT a.* FROM research_automation a JOIN wf_instances w ON w.id=a.research_id WHERE a.project_id=? AND w.state NOT IN ('complete','abandoned','failed') ORDER BY a.cycle_index,a.research_id",
        event.projectId,
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
          blocker = await reconcile(delegatedCaller(source), row, tx);
          await tx.run('RELEASE SAVEPOINT research_automatic_cycle');
        } catch (error) {
          await tx.run('ROLLBACK TO SAVEPOINT research_automatic_cycle');
          await tx.run('RELEASE SAVEPOINT research_automatic_cycle');
          if (!(error instanceof MervError) || (error.status >= 500 && error.status !== 503))
            throw error;
          blocker = { code: error.code, message: clip(error.message, 2000) };
        }
        const encoded = blocker ? JSON.stringify(blocker) : null;
        if (encoded !== row.blocker_json) {
          await tx.run(
            'UPDATE research_automation SET blocker_json=? WHERE research_id=?',
            encoded,
            row.research_id,
          );
          await state.appendEvent(tx, {
            projectId: row.project_id,
            actorId: JSON.parse(row.source_json).actorId,
            type: 'research.automatic_status',
            subjectId: row.research_id,
            data: { performedBy: 'system:research', causeEventId: event.id, blocker },
          });
        }
      }
    },
  });
}

export const automaticRequest = (cycle: string, revision: number, action: string) =>
  `research-auto:${digest({ cycle, revision, action })}`;
