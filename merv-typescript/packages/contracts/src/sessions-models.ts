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

/**
 * Checkout intent only. The base names an execution reference, which workspace preparation
 * resolves to an exact commit. `driver` names the workspace driver that prepares the checkout,
 * opaque to everything but the runner and the plugin that owns the driver.
 */
export type WorkflowWorkspacePolicy =
  | { mode: 'none' }
  | {
      mode: 'ephemeral';
      namespace: string;
      base: `reference:${string}`;
      retain: boolean;
      driver: string;
    }
  | {
      mode: 'persistent';
      namespace: string;
      base: `reference:${string}`;
      retain: boolean;
      driver: string;
      /** Always false. Kept only because the pinned fingerprints of registered versions hold them. */
      perBase: false;
      advancesCentral: false;
    };
