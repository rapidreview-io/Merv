import type { Caller, Json } from '@merv/contracts';
import type {} from 'cordis';

/** Live state a row owner reports alongside its navigation entry. */
export interface UiRowStatus {
  state?: 'ready' | 'degraded' | 'unavailable';
  count?: number;
  detail?: string;
}

/** One sidebar row. Rows are data: the browser bundle renders `view.kind`, never plugin code. */
export interface UiRow {
  id: string;
  label: string;
  /** Sidebar section. `settings` rows render in the foot. */
  group: string;
  order: number;
  /** Browser route under /ui, beginning with a slash. */
  path: string;
  view: { kind: string; [key: string]: Json };
  status?(caller: Caller): UiRowStatus | Promise<UiRowStatus>;
  /** Row-owned read-only data for views without a domain tool, served through ui.read. */
  /** The owning row validates any pagination or lookup parameters. */
  read?(caller: Caller, params?: Record<string, unknown>): Json | Promise<Json>;
}

export interface UiRowDescription extends Omit<UiRow, 'status' | 'read'> {
  status: UiRowStatus;
  readable: boolean;
}

export interface Ui {
  /** Registers a row until the returned disposer runs; ids are unique while registered. */
  register(row: UiRow): () => void;
  rows(): UiRow[];
}

declare module 'cordis' {
  interface Context {
    ui: Ui;
  }
}
