import type { UiRowDescription } from '@merv/ui/rows';

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
  rows: UiRowDescription[];
  plugins: PluginState[];
  workflows?: WorkflowShape[];
}
