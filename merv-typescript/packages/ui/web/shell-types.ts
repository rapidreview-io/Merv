export interface RowStatus {
  state?: 'ready' | 'degraded' | 'unavailable';
  count?: number;
  detail?: string;
}
export interface Row {
  id: string;
  label: string;
  group: string;
  order: number;
  path: string;
  view: { kind: string; [key: string]: unknown };
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
  edges: { from: string; action: string; to: string }[];
}
export interface ShellData {
  rows: Row[];
  plugins: PluginState[];
  workflows?: WorkflowShape[];
}
