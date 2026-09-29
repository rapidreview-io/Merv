import type {} from 'cordis';

/** Configuration shape only; the plugin's Config schema validates it before apply. */
export interface CredentialBinding {
  id: string;
  projectId: string;
  actorId: string;
  mountId: string;
  /** env:NAME; secret values stay in the server environment. */
  secretRef: string;
  /** Fixed nonsecret x-* selectors, lower-cased by the schema. */
  headers?: Record<string, string>;
}

export interface MountConfig {
  id: string;
  url: string;
  /** Explicit raw upstream names to publish; there is no implicit full-catalog selection. */
  tools: string[];
  /** Selects the binding used only to list tools; each round requires this actor to read the project. */
  discovery?: { actorId: string; projectId: string };
  timeoutMs?: number;
  /** Discovery interval after a success or a failure (default 60000). */
  reconnectMs?: number;
}

export interface MountsConfig {
  mounts: MountConfig[];
  bindings?: CredentialBinding[];
}

export interface MountStatus {
  id: string;
  /** Public endpoint origin only; never credentials, paths, query strings, or headers. */
  origin: string;
  /**
   * connecting: no round finished yet. ready: the last round succeeded (errorCode
   * mount_missing_tool when some selected tools are absent). disconnected: the last round failed
   * and the last catalog stays published. failed: the last round failed and nothing was ever
   * published. stopped: the entry is unloading.
   */
  state: 'connecting' | 'ready' | 'disconnected' | 'failed' | 'stopped';
  toolCount: number;
  errorCode?: string;
}

/** To toggle a mount or rotate a binding, reload the mounts entry. */
export interface Mounts {
  status(): MountStatus[];
}

declare module 'cordis' {
  interface Context {
    mounts: Mounts;
  }
}
