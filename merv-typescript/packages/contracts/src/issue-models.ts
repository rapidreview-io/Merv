/** Issues' data as kept and read, and the words an issue is called by, free of any import so the
 *  browser reads the same ones (`issues.ts` re-exports them). */
export type IssueClass = 'tool' | 'question' | 'platform';

/** What a site is called where its code alone would not say it; `<where> <code>` where the code
 *  is the whole story. A tool's site is its own name and action, said as it is. */
const SITES: Record<string, string> = {
  'session.ask_owner asked': 'An agent asked its owner',
  'session.ask_owner needs_you': 'Pi passed an agent’s question to you',
  'sessions.question_responder': 'Pi could not answer an agent',
  'session.stopped': 'An agent stopped without handing off',
  'sessions.launch': 'An agent failed to launch',
  'sessions.launch model_interrupted': 'An agent’s model was interrupted',
  'sessions.sweep_failed': 'The session sweep failed',
  'dispatch.offer_failed': 'Work could not be offered',
  'dispatch.inquiry_refused': 'An inquiry could not be offered',
  'dispatch.launch_held': 'Work is held after failed launches',
  'fleet.retry': 'Fleet keeps retrying a machine',
  'fleet.refused': 'Fleet was refused a machine',
  'fleet.not_ready': 'A Fleet machine’s runtime is not ready',
  'fleet.unpriced': 'A Fleet machine has no price',
  'fleet.machine_gone': 'A Fleet machine vanished',
  'fleet.stuck_releasing': 'A Fleet machine is stuck releasing',
  'fleet.queued': 'A Fleet request is stuck in the queue',
  'fleet.relay': 'The model relay is failing',
  'fleet.workflow_skipped': 'Fleet skipped a project’s work',
  'fleet.unclaimed': 'Hosted machines never claimed the work',
  'pi.turn': 'A Pi turn was interrupted',
  'git.push': 'A git push was rejected',
  'code.capture_quarantined': 'A code capture was quarantined',
  consumer: 'An event consumer keeps failing',
  plugin: 'A plugin failed',
  'plugin plugin_failed': 'A plugin failed to start',
  'composition.restore_failed': 'The composition could not be restored',
  'secrets.platform_unopened': 'Platform secrets could not be opened',
  'process crashed': 'The server crashed',
  'process unclean_exit': 'The server exited uncleanly',
  'events event_flood': 'An event flood',
  api_error: 'The API answered a server error',
  'issues.dropped overflow': 'Issues dropped reports',
  'issues.alert alert_failed': 'Slack alerts are failing',
};
const words = (code: string) => code.replace(/[._:-]+/g, ' ').trim();
/** What an issue is called, in Slack and on the admin's page: its site in words and then its
 *  code, unless the site's words already say both. */
export function issueTitle(where: string, code: string): string {
  const whole = SITES[`${where} ${code}`];
  if (whole) return whole;
  const site = SITES[where];
  return `${site ?? words(where)} · ${words(code)}`;
}
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
  /** The agents' visits its kept cases name. */
  visits: number;
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
/** An issue as the admin's list reads it: its reports in each hour of the last week that had any,
 *  oldest first (`YYYY-MM-DDTHH`, UTC), and its newest kept case. */
export interface IssueListed extends IssueRow {
  hours: [hour: string, count: number][];
  latest: IssueCase | null;
}
