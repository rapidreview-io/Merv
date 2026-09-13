import type {} from 'cordis';

export interface NisaConfig {
  id?: string;
  apiOrigin?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface NisaStatus {
  id: string;
  origin: string;
  state: 'configured' | 'ready' | 'stopped';
}

/** Query execution belongs exclusively to the registered, caller-authorized tool handlers. */
export interface Nisa {
  status(): NisaStatus;
}

declare module 'cordis' {
  interface Context {
    nisa: Nisa;
  }
}
