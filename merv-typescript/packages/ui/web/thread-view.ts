import type { AgentStreamEvent } from '@merv/contracts/agent-stream';
import type { LeaseLiveness } from '@merv/sessions/models';

/**
 * A thread as Sessions reads it to the page. These mirror Sessions' own `ThreadView` and
 * `VisitView` (contracts), which are being written beside this page; at merge the page imports
 * them from there and this file goes.
 *
 * A thread is the worker that owns one stage of one work item for one role. Each session is one
 * visit by it: one lease, one credential, one launch.
 */
export interface ThreadView {
  id: string;
  instanceId: string;
  state: string;
  role: string;
  status: 'live' | 'dormant' | 'retired';
  /** Oldest first. */
  visits: VisitView[];
}

export interface VisitView {
  sessionId: string;
  status: 'offered' | 'active' | 'released' | 'expired';
  offeredAt: string;
  startedAt?: string;
  endedAt?: string;
  /** The session's close outcome, e.g. submitted, crash_loop. */
  outcome?: string;
  /** The session's close code, e.g. local_process_exit_code_70. */
  why?: string;
  /** False where the visit ended before the agent process ran: a failed launch. */
  launched: boolean;
  /** It continued the thread's conversation. */
  resumed: boolean;
  harness?: 'claude' | 'codex';
  runnerId?: string;
  /** Sessions' liveness verdict and phrase, for a visit that holds its lease. */
  liveness?: LeaseLiveness;
  hasConversation: boolean;
}

/** GET /sessions/threads?instanceId=… */
export interface ThreadList {
  threads: ThreadView[];
}

/** GET /sessions/threads/:id/conversation: what each visit said, oldest visit first. */
export interface ThreadConversation {
  visits: { sessionId: string; events: AgentStreamEvent[] }[];
}
