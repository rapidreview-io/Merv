import type { Caller } from '@merv/contracts';
import type {} from 'cordis';

export interface MountConfig {
  id: string;
  url: string;
  /** Explicit raw upstream names to publish; there is no implicit full-catalog selection. */
  tools: string[];
  /** Optional local identity used only for credential-scoped catalog discovery. */
  discovery?: Caller;
  timeoutMs?: number;
  reconnectMs?: number;
}

export interface MountsConfig {
  mounts: MountConfig[];
}

export interface MountStatus {
  id: string;
  /** Public endpoint origin only; never credentials, paths, query strings, or headers. */
  origin: string;
  state: 'connecting' | 'ready' | 'disconnected' | 'failed' | 'stopped';
  toolCount: number;
  errorCode?: string;
}

export interface Mounts {
  status(): MountStatus[];
  /** Trusted host control: withdraw/drain one mount, or restore its retained configuration. */
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Wait for a new forced discovery attempt, queued after any active refresh. */
  reconnect(id: string): Promise<void>;
}

declare module 'cordis' {
  interface Context {
    mounts: Mounts;
  }
}
