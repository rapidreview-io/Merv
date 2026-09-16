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
export interface ShellData {
  rows: Row[];
  plugins: PluginState[];
}
