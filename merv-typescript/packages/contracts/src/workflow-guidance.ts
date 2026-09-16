import type { Data } from './data.js';

export interface WorkflowReference {
  kind: string;
  id: string;
  label: string;
}

export interface WorkflowDependency {
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
  references: WorkflowReference[];
  dependencies: WorkflowDependency[];
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
  terminal: string[];
  unavailable: string[];
  workflows: WorkflowDecision[];
}
