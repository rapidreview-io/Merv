/** Portable session read models that more than one plugin shares and no single plugin owns. */

/** Frozen plan and checkpoint metadata, carried only by a merge-capable workspace driver. */
export type CodePendingMerge = {
  plan: string;
  firstParent: string;
  secondParent: string;
  checkpoint: string;
  firstMerge: string | null;
};

/** Source-authenticated runner observations; the server does not verify Git objects. */
export interface SessionWorkspace {
  repositoryId: string;
  workspaceId: string;
  mode: 'ephemeral' | 'persistent';
  branch: string | null;
  baseOid: string;
  headOid: string;
  /** Observed Git tree; absent on older reports, never inferred by the server. */
  treeOid?: string;
  pendingMerge?: CodePendingMerge;
  stats: { commitCount: number; filesChanged: number; insertions: number; deletions: number };
}

export interface RunnerPlatform {
  name: string;
  /** The harnesses a runner has a profile for. */
  harness: 'codex' | 'claude' | 'command';
  model?: string;
  effort?: string;
  enabled: boolean;
  parallelism: number;
}

/** What the machine that launched a process says it spent. Merv cannot verify any of it. */
export interface SessionUsageReport {
  inputTokens: number;
  outputTokens: number;
  model?: string;
}
