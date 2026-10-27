/** Issues' data as kept and read, types alone, so the browser reads the same ones (`issues.ts`
 *  re-exports them). */
export type IssueClass = 'tool' | 'question' | 'platform';
export type IssueLevel = 'notice' | 'warn' | 'severe';
export type IssueState = 'open' | 'resolved';

/** Ids only: what joins a case to its project, visit, conversation, machine and code. */
export interface IssueRefs {
  projectId?: string;
  actorId?: string;
  /** An outside agent's client string. */
  client?: string;
  sessionId?: string;
  threadId?: string;
  /** A leased call's session_tool_calls row. */
  invocationId?: string;
  instanceId?: string;
  revision?: number;
  questionId?: string;
  conversationId?: string;
  commandId?: string;
  hostId?: string;
  allocationId?: string;
  /** A Fleet machine's provider launch. */
  launchId?: string;
  sandboxId?: string;
  profileId?: string;
  /** A hosted machine's image, `rt1_…` (deploy/HOSTED_RELEASES.md maps it to its commit). */
  runtimeRelease?: string;
  runnerId?: string;
  hostRef?: string;
  pushId?: string;
  eventType?: string;
  subjectId?: string;
  eventIds?: [first: number, last: number];
  /** The Main release a case ran under when it is not this process's: a crash found at restart. */
  release?: string;
}

/** What an error is kept as: never its message, which may carry request values or secrets. */
export interface ErrorFacts {
  name?: string;
  code?: string;
  status?: number;
  /** Up to three stack frames of a fault (status 500 or above, or no MervError): file:line
   *  within the release. */
  at?: string[];
  sqlstate?: string;
  table?: string;
  constraint?: string;
  /** Paths of the input fields a refusal names (invalid_input), at most ten. */
  fields?: string[];
}

/** What Sessions pins of one visit for a case (`sessions.running.platformTrace`). */
export interface SessionTrace {
  projectId: string;
  threadId: string;
  instanceId: string;
  revision: number;
  role: string;
  harness?: string;
  status: string;
  outcome?: string;
  closeReason?: string;
  createdAt: string;
  closedAt?: string;
  runnerId?: string;
  hostRef?: string;
  allocationId?: string;
  /** Its uploaded transcript: blob `transcripts-<projectId>/<sha256>`. */
  transcript?: { sha256: string; size: number };
  /** The resumable conversation it left: blob `conversations-<projectId>/<sha256>`. */
  conversation?: { sha256: string; size: number };
  workspace?: { branch?: string; baseOid?: string; headOid?: string; treeOid?: string };
}

/** An issue as the admin reads it. */
export interface IssueRow {
  id: string;
  class: IssueClass;
  where: string;
  code: string;
  key: string | null;
  level: IssueLevel;
  loop: boolean;
  state: IssueState;
  count: number;
  /** The most reports in any one hour. */
  peakHour: number;
  note: string | null;
  /** Up to five projects its kept cases name. */
  projects: string[];
  firstAt: string;
  openedAt: string;
  lastAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}
/** One kept case of an issue. */
export interface IssueCase {
  id: string;
  at: string;
  level: IssueLevel;
  status: number | null;
  /** Reports of its subject folded into this case within one flush. */
  repeats: number;
  projectId: string | null;
  subject: string | null;
  /** The Main release it ran under (`<stamp>-<sha8>-<content12>`), where known. */
  release: string | null;
  refs: IssueRefs;
  error: ErrorFacts | null;
  note: string | null;
  /** Pinned once its visit has ended; null before that and for a case without a visit. */
  trace: SessionTrace | null;
}
