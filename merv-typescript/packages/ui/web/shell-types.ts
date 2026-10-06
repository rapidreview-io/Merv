export interface RowStatus {
  state?: 'ready' | 'degraded' | 'unavailable';
  count?: number;
  detail?: string;
}
/** How Needs you speaks of a row's records (UiRowNeeds): every word is the owner's. */
export interface RowNeeds {
  name: string;
  owner: string;
  reads?: Record<string, string>;
  stops?: string[];
  subjectOnly?: true;
}
/** What a row's owner says of one state of its workflow (UiStateWords). */
export interface RowStateWords {
  idle?: true;
  submitted?: string;
}
export interface Row {
  id: string;
  label: string;
  group: string;
  order: number;
  path: string;
  view: { kind: string; [key: string]: unknown };
  workflow?: string;
  rooms?: true;
  whenCounted?: true;
  needs?: RowNeeds;
  states?: Record<string, RowStateWords>;
  status: RowStatus;
  readable: boolean;
}
export interface PluginState {
  id: string;
  name: string;
  state: string;
}
/** One deployed program: the states it can stand in, and the actions between them. */
export interface WorkflowShape {
  name: string;
  version: number;
  initial: string;
  states: string[];
  terminal: string[];
  /** `tool` is the tool the edge is taken through, where a rule owns it. */
  edges: { from: string; action: string; to: string; tool?: string | null }[];
}
export interface ShellData {
  rows: Row[];
  plugins: PluginState[];
  workflows?: WorkflowShape[];
}
