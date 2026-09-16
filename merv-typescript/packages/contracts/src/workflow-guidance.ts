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

export interface WorkflowOverview {
  projectId: string;
  ready: string[];
  blocked: string[];
  terminal: string[];
  unavailable: string[];
  workflows: WorkflowDecision[];
}
