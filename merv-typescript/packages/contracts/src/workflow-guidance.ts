import type { Data } from './data.js';

export interface WorkflowReference {
  kind: string;
  id: string;
  label: string;
}

export interface WorkflowDependency {
  /** Present on edge reads; a provider's instance itself has no incoming edge to classify. */
  kind?: 'declared' | 'system';
  owner?: string | null;
  id: string;
  workflow: string;
  version: number;
  name: string;
  state: string;
  settled: boolean;
  failed: boolean;
}

export interface WorkflowBlocker {
  code: string;
  message: string;
  status: number;
}
/** What a provider hands Workflows: its current opinion of why one instance cannot proceed. */
export interface WorkflowProvidedBlockerInput extends WorkflowBlocker {
  /** Stable within one provider and instance, so a repeated opinion updates its own row. */
  key: string;
  /** The recovery action, in words an operator can follow. */
  next: string;
  related?: WorkflowReference[];
}
/**
 * A blocker a plugin other than the owner published for an instance. Workflows stores it
 * without reading it, so it stays visible while the provider is unloaded; the owner's own
 * hooks refuse the work, never this projection.
 */
export interface WorkflowProvidedBlocker extends WorkflowBlocker {
  instanceId: string;
  provider: string;
  key: string;
  next: string;
  related: WorkflowReference[];
  /** When this key first took this code; a changed code starts a new age. */
  since: string;
  updatedAt: string;
}
/**
 * A dependency as a provider needs it: the workflow's own classification plus whether any
 * state of that workflow version declared a workspace. The second is read from the
 * persisted execution manifests, so it holds with the owning plugin unloaded.
 */
export interface WorkflowProviderDependency extends WorkflowDependency {
  revision: number;
  goal?: string;
  terminal: boolean;
  declaresWorkspace: boolean;
}
export interface WorkflowProviderRelations {
  instance: WorkflowProviderDependency;
  dependencies: WorkflowProviderDependency[];
  dependents: WorkflowProviderDependency[];
}
export interface WorkflowActionStatus {
  action: string;
  tool: string;
  instruction: string;
  status: 'ready' | 'needs_input' | 'blocked';
  arguments: Data;
  requiredInput: string[];
  blockers: WorkflowBlocker[];
}
/** Historical first activation, not a current worker lease or ownership claim. */
export interface WorkflowWorkStart {
  instanceId: string;
  projectId: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  actorId: string;
  startedAt: string;
  eventId: number;
}
/**
 * One loop limit as it stands for one instance, counted from its recorded history.
 * `max` is the deployed cap plus what an admin has granted this instance.
 */
export interface WorkflowLimitStatus {
  name: string;
  from: string;
  actions: string[];
  base: number;
  granted: number;
  max: number;
  used: number;
  remaining: number;
  exhausted: boolean;
}
export interface WorkflowDecision {
  instanceId: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  label: string;
  terminal: boolean;
  available: boolean;
  currentGate: string;
  nextAction: WorkflowActionStatus | null;
  instruction: string;
  actions: WorkflowActionStatus[];
  blockers: WorkflowBlocker[];
  /** Every blocker another plugin published for this instance, whatever action was asked about. */
  providerBlockers: WorkflowProvidedBlocker[];
  references: WorkflowReference[];
  dependencies: WorkflowDependency[];
  /** Loop limits leaving the current state; empty when it has none or the work has ended. */
  limits: WorkflowLimitStatus[];
  /** First activation at this revision, if recorded. */
  workStart: WorkflowWorkStart | null;
}

/** One recorded crossing of a definition edge, from wf_history and nowhere else. */
export interface ProcessTraversal {
  revision: number;
  actorId: string;
  requestId: string;
  at: string;
}
/** A state of the pinned definition, stamped with what the record says happened to it. */
export interface ProcessNode {
  state: string;
  initial: boolean;
  terminal: boolean;
  current: boolean;
  /** Recorded arrivals across an edge; the initial state starts at none, so an entry is a return. */
  entries: number;
  firstEnteredAt: string | null;
  blockers: WorkflowBlocker[];
}
/**
 * A declared edge. An empty `traversals` is the difference between what could have
 * happened and what did; `status` is live only for the current node's outgoing edges.
 */
export interface ProcessEdge {
  from: string;
  action: string;
  to: string;
  traversals: ProcessTraversal[];
  status: WorkflowActionStatus['status'] | null;
  tool: string | null;
  blockers: WorkflowBlocker[];
}
/** An edge between whole instances, recorded by the programs that composed them. */
export interface ProcessDependencyEdge extends WorkflowDependency {
  direction: 'depends_on' | 'required_by';
}
/**
 * Derived on read from the pinned definition, wf_history, the same decision the real
 * transition checks, and recorded dependencies. Nothing here is parsed from bytes an
 * agent wrote, and it is never pinned: an edge shows the machinery stepped through a
 * gate, never that the science is right.
 */
export interface ProcessGraph {
  instanceId: string;
  workflow: string;
  version: number;
  revision: number;
  state: string;
  currentGate: string;
  terminal: boolean;
  /** Reading order: forward from the initial state, ends last. */
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  dependencies: ProcessDependencyEdge[];
}

export interface WorkflowOverview {
  projectId: string;
  ready: string[];
  blocked: string[];
  /**
   * Work that can no longer pursue its own purpose: every action still open to it ends it.
   * A prerequisite that failed leaves its dependants here, and nothing is dispatched for
   * them — they wait for their owner to end them, or for a cycle to replan around them.
   */
  stalled: string[];
  /**
   * Work that has used every return its loop limit allows and waits for a human. Nothing
   * is dispatched for it: a reviewer leased now could only have a needs_changes verdict
   * refused and rolled back, and the next poll would lease another. A human may still
   * review it by hand or end it, and a project admin may allow more rounds.
   */
  escalated: string[];
  terminal: string[];
  unavailable: string[];
  workflows: WorkflowDecision[];
}
