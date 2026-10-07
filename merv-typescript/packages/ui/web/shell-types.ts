import type { UiRowDescription, UiRowNeeds, UiRowStatus, UiStateWords } from '@merv/ui/rows';

/** A row as ui.shell describes it, and its parts: the server's own types. */
export type Row = UiRowDescription;
export type RowStatus = UiRowStatus;
export type RowNeeds = UiRowNeeds;
export type RowStateWords = UiStateWords;
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
