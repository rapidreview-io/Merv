import type { State } from '@merv/contracts';
import type { AgentToolCall } from './types.js';

/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const callLogMigrations: Record<number, string> = {
  1: `
CREATE TABLE agent_tool_calls (
  project_id TEXT NOT NULL, actor_id TEXT NOT NULL, client TEXT, tool TEXT NOT NULL, action TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed')), error_code TEXT,
  started_at TEXT NOT NULL, duration_ms BIGINT NOT NULL
);
CREATE INDEX agent_tool_calls_started ON agent_tool_calls(started_at);
`,
};

/** How long a row is kept. */
const RETAINED_MS = 180 * 86_400_000;
/** Rows waiting past this are dropped, and said so: the log never holds a call up or grows
 *  without bound. */
const PENDING = 10_000;
const warn = (event: string, rows: number, error?: unknown) =>
  process.stderr.write(
    `${JSON.stringify({ event, rows, ...(error !== undefined && { error: String(error) }) })}\n`,
  );

/**
 * Every outside agent's call (neither a leased session nor a Pi conversation), per tool and action
 * with its outcome, append-only beside session_tool_calls: no arguments, no results. Rows are
 * written in batches from the plugin's own timer, never inside a call's transaction or snapshot.
 */
export class AgentCallLog {
  private pending: AgentToolCall[] = [];
  private pruned = 0;
  private dropped = 0;
  constructor(
    private readonly state: State,
    private readonly clock: () => number = Date.now,
  ) {}
  push(call: AgentToolCall): void {
    if (this.pending.length < PENDING) this.pending.push(call);
    else this.dropped++;
  }
  /** Writes what waits, and once a day drops rows older than 180 days. */
  async flush(): Promise<void> {
    if (this.dropped) warn('agent_tool_calls.dropped', this.dropped);
    this.dropped = 0;
    const rows = this.pending.splice(0);
    const prune = this.clock() - this.pruned >= 86_400_000;
    if (!rows.length && !prune) return;
    try {
      await this.write(rows, prune);
    } catch (error) {
      // Kept for the next flush, as far as the bound allows; what it cannot keep is said.
      const kept = rows.slice(0, Math.max(0, PENDING - this.pending.length));
      this.pending.unshift(...kept);
      warn('agent_tool_calls.flush_failed', rows.length, error);
      this.dropped += rows.length - kept.length;
      throw error;
    }
    if (prune) this.pruned = this.clock();
  }

  private async write(rows: AgentToolCall[], prune: boolean): Promise<void> {
    await this.state.transaction(async (tx) => {
      for (const row of rows)
        await tx.run(
          'INSERT INTO agent_tool_calls (project_id,actor_id,client,tool,action,outcome,error_code,started_at,duration_ms) VALUES (?,?,?,?,?,?,?,?,?)',
          row.projectId,
          row.actorId,
          row.client ?? null,
          row.tool,
          row.action ?? null,
          row.outcome,
          row.errorCode ?? null,
          row.startedAt,
          row.durationMs,
        );
      if (prune)
        await tx.run(
          'DELETE FROM agent_tool_calls WHERE started_at<?',
          new Date(this.clock() - RETAINED_MS).toISOString(),
        );
    });
  }
}
