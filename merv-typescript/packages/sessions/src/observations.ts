import { postgresMigrations } from './observations.postgres.js';
import { check, type Caller, type Scope, type State } from '@merv/contracts';
import type { Agent, AgentObservation, AgentSummary, AgentToolCall, Session } from './types.js';

/** Payload size only. This is deliberately not a model tokenizer or billing counter. */
function estimate(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Math.ceil(Buffer.byteLength(json, 'utf8') / 4);
  } catch {
    return null;
  }
}

/** PostgreSQL SUM(bigint) is numeric; normalize this public aggregate only. */
function aggregateNumber(value: number | string): number {
  const number = Number(value);
  check(
    Number.isSafeInteger(number) && number >= 0,
    'observation_overflow',
    'Tool observation totals exceed the supported numeric range',
    500,
  );
  return number;
}

export function summarizeAgent(
  agent: Agent,
  currentExecutionId: string | null,
  currentAssignment: AgentSummary['currentAssignment'] = null,
): AgentSummary {
  return {
    id: agent.id,
    sessionId: agent.sessionId,
    actorId: agent.actorId,
    name: agent.name,
    status: agent.status,
    contextEpoch: agent.contextEpoch,
    persistent: agent.persistent,
    currentExecutionId,
    currentAssignment,
    createdAt: agent.createdAt,
    runnerId: agent.runnerId,
  };
}

/** Metadata only: never retain arguments, results, error messages or credentials. */
export class AgentObservations {
  /** Complete storage migrations before publishing this service. */
  initialize!: () => Promise<void>;
  constructor(
    private state: State,
    private scope: Scope,
    private clock: () => number,
  ) {
    this.initialize = async () => {
      await state.migrate('session_tool_calls', [
        {
          version: 1,
          postgres: postgresMigrations[1],
          sql: `
      CREATE TABLE session_tool_calls (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES worker_sessions(id),
        tool TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER
      );
      CREATE INDEX session_tool_calls_execution ON session_tool_calls(execution_id);
      CREATE TRIGGER session_tool_calls_immutable BEFORE UPDATE ON session_tool_calls
      WHEN OLD.status!='running' OR NEW.id IS NOT OLD.id OR NEW.execution_id IS NOT OLD.execution_id
        OR NEW.tool IS NOT OLD.tool OR NEW.started_at IS NOT OLD.started_at
      BEGIN SELECT RAISE(ABORT,'Tool call attribution and completed observations are immutable'); END;
    `,
        },
      ]);
    };
  }

  async start(id: string, executionId: string, tool: string, input: unknown): Promise<void> {
    await this.state.transaction(
      async (tx) =>
        await tx.run(
          "INSERT INTO session_tool_calls(id,execution_id,tool,status,started_at,input_tokens) VALUES(?,?,?,'running',?,?)",
          id,
          executionId,
          tool,
          new Date(this.clock()).toISOString(),
          estimate(input) ?? 0,
        ),
    );
  }

  async finish(id: string, status: 'succeeded' | 'failed', result?: unknown): Promise<void> {
    const now = this.clock();
    await this.state.transaction(async (tx) => {
      const row = await tx.get<{ started_at: string }>(
        "SELECT started_at FROM session_tool_calls WHERE id=? AND status='running'",
        id,
      );
      if (!row) return;
      await tx.run(
        'UPDATE session_tool_calls SET status=?,finished_at=?,duration_ms=?,output_tokens=? WHERE id=?',
        status,
        new Date(now).toISOString(),
        Math.max(0, now - Date.parse(row.started_at)),
        result === undefined ? null : estimate(result),
        id,
      );
    });
  }

  /** An interrupted process has no known completion time or outcome. */
  async interrupt(): Promise<void> {
    await this.state.transaction(
      async (tx) =>
        await tx.run("UPDATE session_tool_calls SET status='interrupted' WHERE status='running'"),
    );
  }

  async read(caller: Caller, agentId: string): Promise<AgentObservation> {
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      check(!caller.session, 'session_forbidden', 'Workers cannot browse other agents', 403);
      const row = await tx.get<{ agent_json: string }>(
        'SELECT agent_json FROM agents WHERE id=? AND project_id=?',
        agentId,
        caller.projectId,
      );
      check(row, 'agent_not_found', 'Agent not found in this project', 404);
      const agent: Agent = JSON.parse(row.agent_json);
      const sessions = (
        await tx.all<{ session_json: string }>(
          tx.dialect === 'postgres'
            ? 'SELECT session_json FROM worker_sessions WHERE actor_id=? AND project_id=? ORDER BY _merv_rowid DESC'
            : 'SELECT session_json FROM worker_sessions WHERE actor_id=? AND project_id=? ORDER BY rowid DESC',
          agent.actorId,
          caller.projectId,
        )
      ).map((row) => JSON.parse(row.session_json) as Session);
      const current = sessions.find(
        (session) => session.status === 'offered' || session.status === 'active',
      );
      const columns = `c.id,c.execution_id AS "executionId",c.tool,c.status,c.started_at AS "startedAt",c.finished_at AS "finishedAt",
        c.duration_ms AS "durationMs",c.input_tokens AS "inputTokens",c.output_tokens AS "outputTokens"`;
      const from =
        'FROM session_tool_calls c JOIN worker_sessions s ON s.id=c.execution_id WHERE s.actor_id=? AND s.project_id=?';
      const calls = await tx.all<AgentToolCall>(
        tx.dialect === 'postgres'
          ? `SELECT ${columns} ${from} ORDER BY CASE WHEN c.status='running' THEN 0 ELSE 1 END,c._merv_rowid DESC LIMIT 100`
          : `SELECT ${columns} ${from} ORDER BY CASE WHEN c.status='running' THEN 0 ELSE 1 END,c.rowid DESC LIMIT 100`,
        agent.actorId,
        caller.projectId,
      );
      const aggregate = (await tx.get<
        Record<keyof AgentObservation['tokenStats'], number | string>
      >(
        `SELECT COUNT(*) AS "totalCalls",COALESCE(SUM(c.input_tokens),0) AS "inputTokens",
        COALESCE(SUM(c.output_tokens),0) AS "outputTokens",COALESCE(SUM(CASE WHEN c.status IN ('succeeded','failed') THEN 1 ELSE 0 END),0) AS "completedCalls" ${from}`,
        agent.actorId,
        caller.projectId,
      ))!;
      const stats: AgentObservation['tokenStats'] = {
        totalCalls: aggregateNumber(aggregate.totalCalls),
        completedCalls: aggregateNumber(aggregate.completedCalls),
        inputTokens: aggregateNumber(aggregate.inputTokens),
        outputTokens: aggregateNumber(aggregate.outputTokens),
      };
      return {
        agent: summarizeAgent(
          agent,
          current?.id ?? null,
          current ? { label: current.assignment.label, role: current.role } : null,
        ),
        assignments: sessions.map((session) => ({
          id: session.id,
          instanceId: session.instanceId,
          label: session.assignment.label,
          role: session.role,
          status: session.status,
          createdAt: session.createdAt,
          activatedAt: session.activatedAt,
          expiresAt: session.expiresAt,
          closedAt: session.closedAt,
          closeReason: session.closeReason,
          outcome: session.outcome,
          workflow: { name: session.execution.workflow, state: session.execution.state },
          revision: session.expectedRevision,
          tools: session.execution.policy.tools.map((tool) => tool.name),
        })),
        toolCalls: calls,
        toolCallTotal: stats.totalCalls,
        tokenStats: stats,
        tokenAccounting: {
          kind: 'estimate',
          method:
            'UTF-8 JSON bytes / 4, rounded up per payload. Excludes model context, reasoning, billing and tools called outside Merv. Logging began when this feature was installed.',
        },
      };
    });
  }
}
