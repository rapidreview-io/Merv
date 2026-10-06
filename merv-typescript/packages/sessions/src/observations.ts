import { postgresMigrations } from './observations.postgres.js';
import { check, type Caller, type Scope, type State, type Transaction } from '@merv/contracts';
import { ordinary as unmanaged, safeCount, text, workName, workNameOf } from './common.js';
import { leaseLiveness } from './liveness.js';
import type { AgentObservation, AgentSummary, AgentToolCall, Session } from './types.js';

/** A thread as an agent: its first visit's runner names it. */
interface ThreadRow {
  id: string;
  actor_id: string;
  status: 'open' | 'dormant' | 'retired';
  created_at: string;
  latest_session_id: string | null;
  runner_id: string;
  first_session_id: string;
}
const THREAD = `SELECT t._merv_rowid AS seq,t.id,t.actor_id,t.status,t.created_at,t.latest_session_id,f.runner_id,f.id AS first_session_id
  FROM session_threads t CROSS JOIN LATERAL (SELECT id,runner_id FROM worker_sessions WHERE thread_id=t.id ORDER BY _merv_rowid LIMIT 1) f`;

/** Payload size only. This is deliberately not a model tokenizer or billing counter. */
function estimate(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Math.ceil(Buffer.byteLength(json, 'utf8') / 4);
  } catch {
    return null;
  }
}

const aggregateNumber = safeCount(
  'observation_overflow',
  'Tool observation totals exceed the supported numeric range',
);

const named = ({ assignment }: Session) => ({
  label: assignment.label,
  name: workName(assignment),
});

function summarizeAgent(
  thread: ThreadRow,
  currentExecutionId: string | null,
  currentAssignment: AgentSummary['currentAssignment'] = null,
): AgentSummary {
  return {
    id: thread.id,
    sessionId: currentExecutionId ?? thread.latest_session_id ?? thread.first_session_id,
    actorId: thread.actor_id,
    name: `Agent ${thread.runner_id}`.slice(0, 200),
    status: thread.status === 'retired' ? 'retired' : 'active',
    currentExecutionId,
    currentAssignment,
    createdAt: thread.created_at,
    runnerId: thread.runner_id,
  };
}

/**
 * The moment an active session last moved: its activation, or its latest tool call. ISO
 * instants order as text, so no date is parsed to compare them.
 */
export function lastActivity(
  session: Pick<Session, 'activatedAt'>,
  lastCallAt: string | undefined,
): string | null {
  if (session.activatedAt === null) return null;
  return lastCallAt !== undefined && lastCallAt > session.activatedAt
    ? lastCallAt
    : session.activatedAt;
}

/** Metadata only: never retain arguments, results, error messages or credentials. */
export class AgentObservations {
  constructor(
    private state: State,
    private scope: Scope,
    private clock: () => number,
    /** Refuses once Sessions has closed. */
    private available: () => void,
  ) {}
  /** Complete storage migrations before publishing this service. */
  async initialize(): Promise<void> {
    await this.state.migrate('session_tool_calls', [{ version: 1, sql: postgresMigrations[1] }]);
  }

  async start(id: string, executionId: string, tool: string, input: unknown): Promise<void> {
    // A read tool's nested reads are part of the call already recorded, and a read scope
    // could not record them anyway.
    if (this.state.readScope) return;
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
    if (this.state.readScope) return;
    const now = this.clock(),
      tokens = result === undefined ? null : estimate(result);
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
        tokens,
        id,
      );
    });
  }

  /** Running calls started before `before` or named in `ids`, whose process has ended: an
   * interrupted call has no known completion time or outcome. */
  async interrupt(before: string, ids: string[] = []): Promise<void> {
    await this.state.transaction(
      async (tx) =>
        await tx.run(
          `UPDATE session_tool_calls SET status='interrupted' WHERE status='running' AND (started_at<? OR id IN (${['NULL', ...ids.map(() => '?')].join()}))`,
          before,
          ...ids,
        ),
    );
  }

  /**
   * The latest tool call of every active session, the progress clock a heartbeat cannot be:
   * a runner renews a lease for as long as its process lives, whatever the process does. A
   * call still running counts from its start, so one that hangs does not hide a stall. One
   * statement for every project, because the sweep is; a read names its own project.
   */
  async activity(tx: Transaction, projectId?: string): Promise<Map<string, string>> {
    const rows = await tx.all<{ id: string; at: string }>(
      `SELECT execution_id AS id,MAX(COALESCE(finished_at,started_at)) AS at FROM session_tool_calls
        WHERE execution_id IN (SELECT id FROM worker_sessions WHERE status='active' AND (CAST(? AS TEXT) IS NULL OR project_id=?))
        GROUP BY execution_id`,
      projectId ?? null,
      projectId ?? null,
    );
    return new Map(rows.map((row) => [row.id, row.at]));
  }

  /** Every thread of the project and its live visit, read in the status transaction. */
  async summaries(tx: Transaction, projectId: string): Promise<AgentSummary[]> {
    return (
      await tx.all<
        ThreadRow & {
          execution_id: string | null;
          execution_label: string;
          execution_name: string;
          execution_role: Session['role'];
        }
      >(
        `SELECT a.*, w.id AS execution_id, (w.session_json::jsonb #>> '{assignment,label}') AS execution_label, ${workNameOf('w.session_json::jsonb')} AS execution_name, (w.session_json::jsonb #>> '{role}') AS execution_role
          FROM (${THREAD} WHERE t.project_id=?) a LEFT JOIN worker_sessions w ON w.thread_id=a.id AND w.status IN ('offered','active') ORDER BY a.created_at DESC,a.seq DESC`,
        projectId,
      )
    ).map((row) =>
      summarizeAgent(
        row,
        row.execution_id,
        row.execution_id
          ? { label: row.execution_label, name: row.execution_name, role: row.execution_role }
          : null,
      ),
    );
  }

  async read(caller: Caller, agentId: string): Promise<AgentObservation> {
    unmanaged(caller);
    this.available();
    check(
      text(agentId, 200),
      'invalid_agent',
      'An agent identifier of 1–200 characters is required',
    );
    caller = structuredClone(caller);
    return await this.state.transaction(async (tx) => {
      await this.scope.require(caller, 'read', tx);
      check(!caller.session, 'session_forbidden', 'Workers cannot browse other agents', 403);
      const thread = await tx.get<ThreadRow>(
        `${THREAD} WHERE t.id=? AND t.project_id=?`,
        agentId,
        caller.projectId,
      );
      check(thread, 'agent_not_found', 'Agent not found in this project', 404);
      const sessions = (
        await tx.all<{ session_json: string }>(
          'SELECT session_json FROM worker_sessions WHERE thread_id=? AND project_id=? ORDER BY _merv_rowid DESC',
          thread.id,
          caller.projectId,
        )
      ).map((row) => JSON.parse(row.session_json) as Session);
      const current = sessions.find(
        (session) => session.status === 'offered' || session.status === 'active',
      );
      const now = this.clock();
      const columns = `c.id,c.execution_id AS "executionId",c.tool,c.status,c.started_at AS "startedAt",c.finished_at AS "finishedAt",
        c.duration_ms AS "durationMs",c.input_tokens AS "inputTokens",c.output_tokens AS "outputTokens"`;
      const from =
        'FROM session_tool_calls c JOIN worker_sessions s ON s.id=c.execution_id WHERE s.thread_id=? AND s.project_id=?';
      const calls = await tx.all<AgentToolCall>(
        `SELECT ${columns} ${from} ORDER BY CASE WHEN c.status='running' THEN 0 ELSE 1 END,c._merv_rowid DESC LIMIT 100`,
        thread.id,
        caller.projectId,
      );
      const aggregate = (await tx.get<
        Record<keyof AgentObservation['tokenStats'], number | string>
      >(
        `SELECT COUNT(*) AS "totalCalls",COALESCE(SUM(c.input_tokens),0) AS "inputTokens",
        COALESCE(SUM(c.output_tokens),0) AS "outputTokens",COALESCE(SUM(CASE WHEN c.status IN ('succeeded','failed') THEN 1 ELSE 0 END),0) AS "completedCalls" ${from}`,
        thread.id,
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
          thread,
          current?.id ?? null,
          current ? { ...named(current), role: current.role } : null,
        ),
        assignments: sessions.map((session) => ({
          id: session.id,
          instanceId: session.instanceId,
          ...named(session),
          role: session.role,
          status: session.status,
          createdAt: session.createdAt,
          activatedAt: session.activatedAt,
          expiresAt: session.expiresAt,
          closedAt: session.closedAt,
          closeReason: session.closeReason,
          outcome: session.outcome,
          liveness: leaseLiveness(session, now),
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
