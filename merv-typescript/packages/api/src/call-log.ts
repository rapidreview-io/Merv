import { MervError, type State } from '@merv/contracts';
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

const RETAINED_MS = 180 * 86_400_000;
/** Bound pending/in-flight rows; overflow is counted, never blocks calls. */
const PENDING = 10_000;
const warn = (event: string, rows: number, error?: unknown) =>
  process.stderr.write(
    `${JSON.stringify({ event, rows, ...(error !== undefined && { error: String(error) }) })}\n`,
  );
const text = (value: string | undefined) =>
  value === undefined ? null : value.replaceAll('\0', '').slice(0, 200);
const permanent = (error: unknown) =>
  error instanceof MervError && ['state_invalid_value', 'state_constraint'].includes(error.code);

/** Outside-agent telemetry: no arguments or results, serialized batches outside call transactions.
 * Remove rows only after writing or permanent individual rejection. Shutdown makes one final
 * attempt; late calls, transient failures or process death can lose the last interval. */
export class AgentCallLog {
  private pending: AgentToolCall[] = [];
  private flushing?: Promise<void>;
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
  /** Share concurrent flushes; prune once daily. */
  flush(): Promise<void> {
    return (this.flushing ??= this.drain().finally(() => (this.flushing = undefined)));
  }
  /** The last flush, after the one running: the state store is closed only after it. */
  async close(): Promise<void> {
    await this.flushing?.catch(() => {});
    await this.flush();
  }

  private async drain(): Promise<void> {
    if (this.dropped) warn('agent_tool_calls.dropped', this.dropped);
    this.dropped = 0;
    const rows = this.pending.slice();
    const prune = this.clock() - this.pruned >= 86_400_000;
    if (!rows.length && !prune) return;
    try {
      await this.write(rows, prune);
      this.pending.splice(0, rows.length);
      if (prune) this.pruned = this.clock();
    } catch (error) {
      warn('agent_tool_calls.flush_failed', rows.length, error);
      if (!permanent(error)) throw error;
      // One row PostgreSQL can never hold fails its whole batch: each is written alone.
      for (const row of rows) {
        await this.write([row], false).catch((error) => {
          if (!permanent(error)) throw error;
          this.dropped++;
        });
        this.pending.shift();
      }
    }
  }

  private async write(rows: AgentToolCall[], prune: boolean): Promise<void> {
    await this.state.transaction(async (tx) => {
      for (const row of rows)
        await tx.run(
          'INSERT INTO agent_tool_calls (project_id,actor_id,client,tool,action,outcome,error_code,started_at,duration_ms) VALUES (?,?,?,?,?,?,?,?,?)',
          text(row.projectId),
          text(row.actorId),
          text(row.client),
          text(row.tool),
          text(row.action),
          row.outcome,
          text(row.errorCode),
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
