import type { Caller, Json } from '@merv/contracts';
import type {} from 'cordis';

/** One project's authorized connection. Secrets are named, never carried. */
export interface SandboxConnection {
  projectId: string;
  /** The namespace the grant selects, sent as `X-Sandbox-Namespace` on every call. */
  namespace: string;
  /** Environment variable holding that project's `sbxt_` consumer grant. */
  tokenEnv: string;
}

export interface SandboxesConfig {
  /** Environment variable holding the service origin; the only origin this plugin calls. */
  urlEnv: string;
  connections: SandboxConnection[];
  /** Manifest re-poll cadence; five minutes by default. */
  refreshMs?: number;
  timeoutMs?: number;
}

/**
 * One sidebar row derived from a manifest row. Data only: the browser renders `view`,
 * and `spec`/`record` are the manifest's own collection and record specifications.
 */
export type SandboxRow = {
  id: string;
  label: string;
  group: string;
  order: number;
  path: string;
  view: { kind: 'collection'; icon: string | null; spec: Json; record: Json };
};

/** One sandbox, named by the id the collection publishes as its key. */
export interface SandboxTarget {
  id: string;
}
export interface SandboxExtend extends SandboxTarget {
  /** Extra lifetime, added to whatever is left of the lease when the service renews it. */
  seconds: number;
}

/** Readiness only. A count beside a row means open work, and a proxy cannot know that. */
export interface SandboxReadiness {
  state: 'ready' | 'degraded';
  detail?: string;
}

export interface Sandboxes {
  /** Rows from the last accepted manifest, already named and routed for the UI registry. */
  rows(): SandboxRow[];
  status(): SandboxReadiness;
  /** Fetch every connection's manifest now; rows change only when the manifest does. */
  refresh(): Promise<void>;
  /** The collection, or one record when `id` is given, read as the caller's own project. */
  read(caller: Caller, rowId: string, params?: Record<string, unknown>): Promise<Json>;
  /** Add `seconds` to what is left of one sandbox's lease; the service refuses a dead one. */
  extend(caller: Caller, input: SandboxExtend): Promise<Json>;
  /** Ask the provider to delete one sandbox, then answer the record as it now reads. */
  release(caller: Caller, input: SandboxTarget): Promise<Json>;
  /** Fires after the published row set changes. */
  subscribe(listener: () => void): () => void;
}

declare module 'cordis' {
  interface Context {
    sandboxes: Sandboxes;
  }
}
